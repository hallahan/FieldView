// Talks to the OpenFieldView Worker (worker/index.ts), which keeps jobs in R2.
//
// The site is behind Cloudflare Access, so the browser already carries the
// sign-in cookie and nothing here handles tokens. When the Access session
// runs out, Access answers API calls with a redirect to its login page; that
// shows up here as SignInExpired, and a page reload signs in again.

import type { JobIndex, UploadRecord, VersionList } from './layout';

export class SignInExpired extends Error {
  constructor() {
    super('Your sign-in has run out. Reload the page to sign in again.');
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const BASE = '/api/';

/** URL of a file in the bucket, for links and downloads. */
export function fileUrl(key: string, download = false): string {
  return `${BASE}file/${key.split('/').map(encodeURIComponent).join('/')}${download ? '?download' : ''}`;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, redirect: 'manual', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError("Couldn't reach OpenFieldView. Check the connection and try again.", 0);
  }
  if (res.type === 'opaqueredirect' || res.status === 401) throw new SignInExpired();
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const type = res.headers.get('Content-Type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => undefined) : undefined;
  if (!res.ok) throw new ApiError((body as { error?: string } | undefined)?.error ?? `Server error ${res.status}`, res.status);
  if (body === undefined) throw new ApiError('Not an OpenFieldView server', res.status);
  return body as T;
}

export type Who = { email: string } | { none: 'no-server' | 'not-set-up'; message?: string };

/** Who's signed in, or why there's no one: this copy of the site has no server (GitHub Pages), or Access isn't set up yet. */
export async function whoAmI(): Promise<Who> {
  const res = await call(`${BASE}me`);
  if (!(res.headers.get('Content-Type') ?? '').includes('json')) return { none: 'no-server' };
  if (res.status === 503) return { none: 'not-set-up', message: ((await res.json().catch(() => ({}))) as { error?: string }).error };
  return json<{ email: string }>(res);
}

/** A JSON file from the bucket, or undefined if it isn't there yet. */
export async function readJson<T>(key: string): Promise<T | undefined> {
  const res = await call(fileUrl(key));
  if (res.status === 404) return undefined;
  return json<T>(res);
}

export const loadIndex = () => readJson<JobIndex>('index.json');
export const loadVersions = (folder: string) => readJson<VersionList>(`${folder}/versions.json`);

export async function readFile(key: string): Promise<Blob> {
  const res = await call(fileUrl(key));
  if (!res.ok) await json(res);
  return res.blob();
}

export async function post<T>(path: 'uploads' | 'uploads/commit' | 'rebuild', body?: unknown): Promise<T> {
  return json<T>(
    await call(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

export async function putFile(key: string, blob: Blob, sha256: string): Promise<void> {
  await json(
    await call(fileUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Content-SHA256': sha256 },
      body: blob,
    }),
  );
}

export type { JobIndex, UploadRecord, VersionList };
