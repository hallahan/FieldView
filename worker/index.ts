// OpenFieldView server: serves the app (from dist/, as static assets) and a
// small API for keeping jobs in an R2 bucket. Cloudflare Access sits in front
// of all of it, so only people the Access policy allows can open the site.
//
//   GET  /api/me                   the signed-in email
//   GET  /api/file/<key>           any file in the bucket (?download for a save-as)
//   POST /api/uploads              plan an upload
//   PUT  /api/file/<key>           send one file of a planned upload (X-Content-SHA256 header)
//   POST /api/uploads/commit       finish an upload
//   POST /api/rebuild              rebuild index.json and versions.json from the uploads
//
// Setup: docs/cloudflare-setup.md.

import { AccessError, signedInEmail, type AccessEnv } from './access';
import { commit, plan, putFile, rebuild, StoreError } from './store';

export interface Env extends AccessEnv {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    try {
      const email = await signedInEmail(request, env);
      if (!env.BUCKET) throw new StoreError('No R2 bucket is bound to this Worker as BUCKET', 503);
      return await route(request, url, env.BUCKET, email);
    } catch (e) {
      if (e instanceof AccessError || e instanceof StoreError) return reply({ error: e.message }, e.status);
      console.error(e);
      return reply({ error: 'Server error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, url: URL, bucket: R2Bucket, email: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/me' && method === 'GET') return reply({ email });
  if (path === '/api/uploads' && method === 'POST') return reply(await plan(bucket, await body(request)));
  if (path === '/api/uploads/commit' && method === 'POST') return reply(await commit(bucket, await body(request), email));
  if (path === '/api/rebuild' && method === 'POST') return reply(await rebuild(bucket));
  if (path.startsWith('/api/file/')) {
    const key = decodeKey(path.slice('/api/file/'.length));
    if (method === 'GET' || method === 'HEAD') return getFile(request, bucket, key, url.searchParams.has('download'));
    if (method === 'PUT') {
      if (!request.body) throw new StoreError('Empty body');
      const stored = await putFile(bucket, key, request.body, request.headers.get('X-Content-SHA256') ?? '', request.headers.get('Content-Type') ?? undefined, email);
      return reply(stored, 201);
    }
  }
  return reply({ error: 'Not found' }, 404);
}

function decodeKey(raw: string): string {
  try {
    return raw.split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new StoreError('Bad path');
  }
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new StoreError('Expected JSON');
  }
}

async function getFile(request: Request, bucket: R2Bucket, key: string, download: boolean): Promise<Response> {
  const obj = await bucket.get(key, { onlyIf: request.headers });
  if (!obj) return reply({ error: `${key} isn't in the bucket` }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  // Upload folders and media never change; the JSON indexes do.
  headers.set('Cache-Control', /\.json$/.test(key) ? 'private, no-cache' : 'private, max-age=31536000, immutable');
  const name = key.split('/').pop()!;
  headers.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
