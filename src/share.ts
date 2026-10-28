// Share links: a repo admin makes a link, and anyone holding it can see that
// repo's jobs, download them and, if the link allows, upload, without a
// GitHub account. The sign-in worker (worker/auth.js) checks the link and
// makes the GitHub calls.
//
// The link's secret sits after the # (…/OpenFieldView/#share=…), so the
// browser never sends it to GitHub Pages; it only goes to the worker, in a
// header.

import { getToken } from './auth';
import { AUTH_URL } from './config';
import type { Commit, RepoInfo } from './github';
import { jobEntry, jobName, type JobIndex, type SaveResult } from './library';
import type { JxlDocument } from './jxl';

export interface ShareLink {
  id: string;
  repo: string;
  private: boolean;
  label: string;
  /** Whoever holds the link can upload jobs. */
  upload: boolean;
  /** A link to this one job (view only), rather than the whole repo. */
  job?: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  /** Only given to the repo's admins, so they can copy the link again. */
  secret?: string;
}

export interface SharedRepo extends ShareLink {
  defaultBranch: string;
  index: JobIndex;
}

export class ShareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
  ) {
    super(message);
  }
}

export const sharingAvailable = () => !!AUTH_URL;

const endpoint = (path: string) => `${AUTH_URL.replace(/\/+$/, '')}${path}`;

/** The share secret in this page's address, if it was opened from a link. */
export function shareFromLocation(hash = location.hash): string | undefined {
  return hash.match(/[#&]share=([A-Za-z0-9_-]{32,64})(?:&|$)/)?.[1];
}

/** The address to send someone. */
export function shareUrl(secret: string): string {
  return `${location.origin}${location.pathname}#share=${secret}`;
}

async function call<T>(path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint(path), {
      method: init.method ?? 'GET',
      headers: { Authorization: auth, ...(init.body !== undefined && { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new ShareError("Couldn't reach OpenFieldView's server. Check the connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ShareError(body.message ?? `Error ${res.status}${body.error ? `: ${body.error}` : ''}`, res.status, body.error);
  }
  return res.json() as Promise<T>;
}

/** Reads and uploads jobs through a share link, in place of the GitHub client. */
export class ShareClient {
  constructor(readonly secret: string) {}

  private get auth() {
    return `Share ${this.secret}`;
  }

  open(): Promise<SharedRepo> {
    return call<SharedRepo>('/share', this.auth);
  }

  async info(): Promise<RepoInfo> {
    const s = await this.open();
    return { private: s.private, defaultBranch: s.defaultBranch, canPush: s.upload, empty: false };
  }

  async readText(path: string, ref?: string): Promise<string | undefined> {
    const q = new URLSearchParams({ path, ...(ref && { ref }) });
    let res: Response;
    try {
      res = await fetch(endpoint(`/share/file?${q}`), { headers: { Authorization: this.auth }, cache: 'no-store' });
    } catch {
      throw new ShareError("Couldn't reach OpenFieldView's server. Check the connection and try again.", 0);
    }
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (body.error === 'no_file') return undefined;
      throw new ShareError(body.message ?? 'Not found', 404, body.error);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ShareError(body.message ?? `Error ${res.status}`, res.status);
    }
    return res.text();
  }

  commits(path: string): Promise<Commit[]> {
    return call<Commit[]>(`/share/commits?${new URLSearchParams({ path })}`, this.auth);
  }

  /** Upload a job; `by` is the uploader's name for the commit message. */
  upload(text: string, doc: JxlDocument, fileName: string, by: string): Promise<SaveResult> {
    return call<SaveResult>('/share/upload', this.auth, {
      method: 'POST',
      body: { text, entry: jobEntry(doc, jobName(doc, fileName)), by },
    });
  }
}

// ------------------------------------------------------------ managing links (repo admins)

async function bearer() {
  const token = await getToken();
  if (!token) throw new ShareError('Sign in with GitHub to share.', 401, 'sign_in');
  return `Bearer ${token}`;
}

export async function listLinks(repo: string): Promise<ShareLink[]> {
  return (await call<{ links: ShareLink[] }>(`/shares?${new URLSearchParams({ repo })}`, await bearer())).links;
}

export async function createLink(opts: { repo: string; label: string; upload: boolean; job?: string; expiresInDays?: number }): Promise<ShareLink> {
  return call<ShareLink>('/shares', await bearer(), { method: 'POST', body: opts });
}

export async function revokeLink(id: string): Promise<void> {
  await call('/shares/' + id, await bearer(), { method: 'DELETE' });
}

/** "view and download", "view, download and upload". */
export function describeAccess(l: Pick<ShareLink, 'upload' | 'job'>): string {
  return l.upload ? 'view, download and upload' : 'view and download';
}

export function describeExpiry(l: Pick<ShareLink, 'expiresAt'>): string {
  if (!l.expiresAt) return 'never expires';
  const d = new Date(l.expiresAt);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `until ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(!sameYear && { year: 'numeric' }) })}`;
}
