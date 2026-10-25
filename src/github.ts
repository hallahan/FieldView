// Minimal GitHub REST client for keeping jobs in a repo, using fetch only.
//
// api.github.com allows CORS, so the browser talks to it directly. Reads of a
// public repo work without a token; writes and private repos need one.

const API = 'https://api.github.com';

export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoInfo {
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  /** No commits yet: git data endpoints answer 409 until the first commit. */
  empty: boolean;
}

export interface FileChange {
  path: string;
  /** UTF-8 text content. */
  content: string;
}

export interface Commit {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GitHub {
  constructor(
    readonly repo: RepoRef,
    private token?: string,
  ) {}

  get slug() {
    return `${this.repo.owner}/${this.repo.name}`;
  }

  private async request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: init.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (init.body) headers['Content-Type'] = 'application/json';
    // GitHub caches GETs for up to a minute; skip that so a fresh save shows.
    const res = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store' });
    if (!res.ok && res.status !== 404) throw await toError(res, this.slug, !!this.token);
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 404) throw notFound(this.slug, !!this.token);
    return res.json() as Promise<T>;
  }

  private base(rest = '') {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}${rest}`;
  }

  async info(): Promise<RepoInfo> {
    const r = await this.json<{ private: boolean; default_branch: string; size: number; permissions?: { push?: boolean } }>(this.base());
    let empty = r.size === 0;
    if (empty) {
      // size lags behind pushes, so confirm with the branch itself.
      try {
        const res = await this.request(this.base(`/git/ref/heads/${encodePath(r.default_branch)}`));
        empty = res.status === 404;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 409)) throw e;
      }
    }
    return { private: r.private, defaultBranch: r.default_branch, canPush: !!r.permissions?.push, empty };
  }

  /** A file's text at `ref` (default branch when omitted), or undefined if it doesn't exist. */
  async readText(path: string, ref?: string): Promise<string | undefined> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    // The raw media type returns the bytes directly, which also works past
    // the 1 MB limit of the JSON contents response.
    const res = await this.request(this.base(`/contents/${encodePath(path)}${q}`), { accept: 'application/vnd.github.raw' });
    if (res.status === 404) return undefined;
    return res.text();
  }

  async commits(path: string, perPage = 30): Promise<Commit[]> {
    const list = await this.json<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(
      this.base(`/commits?path=${encodePath(path)}&per_page=${perPage}`),
    );
    return list.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.author.date, author: c.commit.author.name }));
  }

  /**
   * Write several files in one commit on `branch`. `build` receives a reader
   * for the branch as it stands, so it can merge with what's there; if
   * someone else commits in between, it's called again on the new head.
   */
  async commitFiles(
    branch: string,
    build: (read: (path: string) => Promise<string | undefined>) => Promise<{ files: FileChange[]; message: string } | undefined>,
    attempts = 3,
  ): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      const ref = await this.json<{ object: { sha: string } }>(this.base(`/git/ref/heads/${encodePath(branch)}`));
      const head = ref.object.sha;
      const change = await build((path) => this.readText(path, head));
      if (!change) return undefined;
      const headCommit = await this.json<{ tree: { sha: string } }>(this.base(`/git/commits/${head}`));
      const tree = await Promise.all(
        change.files.map(async (f) => {
          const blob = await this.json<{ sha: string }>(this.base('/git/blobs'), {
            method: 'POST',
            body: JSON.stringify({ content: toBase64(f.content), encoding: 'base64' }),
          });
          return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
        }),
      );
      const newTree = await this.json<{ sha: string }>(this.base('/git/trees'), {
        method: 'POST',
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
      });
      const commit = await this.json<{ sha: string }>(this.base('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({ message: change.message, tree: newTree.sha, parents: [head] }),
      });
      try {
        await this.json(this.base(`/git/refs/heads/${encodePath(branch)}`), {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        return commit.sha;
      } catch (e) {
        // 422: not a fast-forward, someone else pushed first.
        if (!(e instanceof GitHubError && e.status === 422) || attempt >= attempts) throw e;
      }
    }
  }

  /** Create the first commit in an empty repo (git data endpoints need one to exist). */
  async initialize(path: string, content: string, message: string) {
    await this.json(this.base(`/contents/${encodePath(path)}`), {
      method: 'PUT',
      body: JSON.stringify({ message, content: toBase64(content) }),
    });
  }
}

function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function notFound(slug: string, authed: boolean) {
  return new GitHubError(
    authed
      ? `Can't find ${slug}. Check the name, and that your token has access to it.`
      : `Can't find ${slug}. If it's a private repo, add a GitHub token in Settings.`,
    404,
  );
}

async function toError(res: Response, slug: string, authed: boolean): Promise<GitHubError> {
  let detail = '';
  try {
    detail = ((await res.json()) as { message?: string }).message ?? '';
  } catch {
    // Not JSON.
  }
  if (res.status === 401) return new GitHubError('GitHub rejected the token. It may have expired; add a new one in Settings.', 401);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubError(
      authed ? 'GitHub rate limit reached. Try again in a few minutes.' : 'GitHub allows 60 requests an hour without a token. Add one in Settings, or try again later.',
      403,
    );
  }
  if (res.status === 403) return new GitHubError(`Your token can't write to ${slug}. It needs Contents: Read and write.`, 403);
  return new GitHubError(`GitHub error ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
}

/** Base64 of the UTF-8 bytes, in chunks so multi-megabyte files don't overflow the call stack. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The id git gives this content as a blob, so unchanged uploads can be skipped without a request. */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Accepts "owner/name", "github.com/owner/name" or a full URL. */
export function parseRepo(input: string): RepoRef | undefined {
  const m = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/);
  return m ? { owner: m[1], name: m[2] } : undefined;
}
