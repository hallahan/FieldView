// OpenFieldView's Cloudflare Worker. It does two jobs a static site can't:
//
// 1. Sign-in (POST /): swaps a GitHub sign-in code (or a refresh token) for an
//    access token. GitHub's token endpoint needs the app's client secret and
//    doesn't allow browser (CORS) requests.
//
// 2. Share links (/shares, /share/...): a repo admin makes a link, and anyone
//    holding it can see that repo's jobs, download them and, if the link
//    allows it, upload, without a GitHub account. The Worker checks the link
//    and makes the GitHub calls itself with a token for the OpenFieldView
//    GitHub App, scoped to that one repo and read-only unless uploads are on.
//    A link can only reach index.geojson and jobs/<name>/<name>.jxl|.rw5, and
//    can't delete anything: an upload over a job is a new commit.
//
// The link's secret travels after the # in the page URL, so it never reaches
// GitHub Pages, and the app sends it here in a header, not in a URL. Links
// are kept in Workers KV under a hash of the secret.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GITHUB_CLIENT_ID        the GitHub App's Client ID
//   GITHUB_CLIENT_SECRET    a client secret generated on the GitHub App (type: Secret)
//   ALLOWED_ORIGINS         comma-separated, e.g. https://hallahan.github.io,http://localhost:5173
// For share links (sign-in works without them):
//   GITHUB_APP_ID           the GitHub App's App ID (a number)
//   GITHUB_APP_PRIVATE_KEY  a private key generated on the GitHub App, the whole .pem file (type: Secret)
//   SHARES                  a KV namespace binding (Settings → Bindings → KV namespace)

const API = 'https://api.github.com';
const UA = 'openfieldview-auth';
/** Largest job file a link can upload. */
export const MAX_UPLOAD = 25 * 1024 * 1024;
/** Uploads per link per hour. */
export const UPLOADS_PER_HOUR = 30;
const INDEX_PATH = 'index.geojson';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        }
      : {};
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!cors['Access-Control-Allow-Origin']) return reply(403, { error: 'origin_not_allowed', origin });

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/') return await signIn(request, env, reply);
      if (path === '/shares' || path.startsWith('/shares/')) return await manageShares(request, env, reply, path);
      if (path === '/share' || path.startsWith('/share/')) return await useShare(request, env, reply, cors, path);
      return reply(404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof Refusal) return reply(e.status, { error: e.code, message: e.message });
      return reply(502, { error: 'failed', message: `Something went wrong talking to GitHub: ${e.message}` });
    }
  },
};

/** An error the person should see, with its HTTP status. */
export class Refusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------------ sign-in

async function signIn(request, env, reply) {
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return reply(500, { error: 'worker_not_configured' });

  const input = await readJson(request);
  const params = { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET };
  if (typeof input.code === 'string') {
    params.code = input.code;
    if (typeof input.redirect_uri === 'string') params.redirect_uri = input.redirect_uri;
    if (typeof input.code_verifier === 'string') params.code_verifier = input.code_verifier;
  } else if (typeof input.refresh_token === 'string') {
    params.grant_type = 'refresh_token';
    params.refresh_token = input.refresh_token;
  } else {
    return reply(400, { error: 'missing_code' });
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(params),
  });
  // GitHub answers 200 with an "error" field when the code is bad or used.
  const body = await res.json().catch(() => ({ error: 'bad_github_response' }));
  return reply(res.ok && !body.error ? 200 : 400, body);
}

// ------------------------------------------------------------------ making links (repo admins)

async function manageShares(request, env, reply, path) {
  requireShareSetup(env);
  const token = bearer(request, 'Bearer');
  if (!token) throw new Refusal(401, 'sign_in', 'Sign in with GitHub to manage share links.');

  if (request.method === 'GET' && path === '/shares') {
    const repo = await adminRepo(new URL(request.url).searchParams.get('repo'), token);
    const links = [];
    let cursor;
    do {
      const page = await env.SHARES.list({ prefix: 'share:', cursor });
      for (const k of page.keys) {
        if (k.metadata?.repo !== repo.full_name.toLowerCase()) continue;
        const s = await env.SHARES.get(k.name, 'json');
        if (s && !expired(s)) links.push(describe(s, true));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    links.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return reply(200, { links });
  }

  if (request.method === 'POST' && path === '/shares') {
    const input = await readJson(request);
    const repo = await adminRepo(input.repo, token);
    const job = input.job === undefined || input.job === null ? undefined : String(input.job);
    if (job !== undefined && !isJobPath(job)) throw new Refusal(400, 'bad_job', "That isn't a job in this repo.");
    const days = input.expiresInDays === null || input.expiresInDays === undefined ? undefined : Number(input.expiresInDays);
    if (days !== undefined && !(days > 0 && days <= 3660)) throw new Refusal(400, 'bad_expiry', 'Pick when the link should stop working.');
    // Fails early if the app can't reach the repo.
    await installationFor(env, repo.full_name);
    const secret = randomSecret();
    const id = await shareId(secret);
    const now = new Date();
    const share = {
      id,
      secret,
      repo: repo.full_name,
      private: repo.private,
      label: cleanText(input.label, 60) || (job ? jobNameOf(job) : 'Crew'),
      // A link to one job is for looking only.
      upload: !job && input.upload === true,
      ...(job && { job }),
      createdBy: repo.login,
      createdAt: now.toISOString(),
      ...(days && { expiresAt: new Date(now.getTime() + days * 86400_000).toISOString() }),
    };
    await env.SHARES.put(`share:${id}`, JSON.stringify(share), {
      metadata: { repo: repo.full_name.toLowerCase() },
      // KV drops it a day after it stops working.
      ...(share.expiresAt && { expiration: Math.floor(Date.parse(share.expiresAt) / 1000) + 86400 }),
    });
    return reply(201, describe(share, true));
  }

  const m = path.match(/^\/shares\/([0-9a-f]{64})$/);
  if (request.method === 'DELETE' && m) {
    const share = await env.SHARES.get(`share:${m[1]}`, 'json');
    if (!share) return reply(200, { revoked: true });
    await adminRepo(share.repo, token);
    await env.SHARES.delete(`share:${m[1]}`);
    return reply(200, { revoked: true });
  }
  return reply(405, { error: 'method_not_allowed' });
}

/** The repo, if the signed-in person administers it. */
async function adminRepo(slug, token) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(slug)) throw new Refusal(400, 'bad_repo', 'Pick a repo.');
  const [user, repo] = await Promise.all([gh(`/user`, token), gh(`/repos/${slug}`, token)]);
  if (user.status === 401) throw new Refusal(401, 'sign_in', 'Your GitHub sign-in has expired. Sign in again.');
  if (repo.status === 404) throw new Refusal(404, 'no_repo', `Can't find ${slug}, or OpenFieldView hasn't been given access to it.`);
  if (!user.ok || !repo.ok) throw new Error(`GitHub error ${user.ok ? repo.status : user.status}`);
  const r = await repo.json();
  if (!r.permissions?.admin) throw new Refusal(403, 'not_admin', `Only an admin of ${r.full_name} can share it.`);
  return { full_name: r.full_name, private: r.private, login: (await user.json()).login };
}

// ------------------------------------------------------------------ using a link (anyone holding it)

async function useShare(request, env, reply, cors, path) {
  requireShareSetup(env);
  const secret = bearer(request, 'Share');
  if (!secret || !/^[A-Za-z0-9_-]{32,64}$/.test(secret)) throw new Refusal(401, 'no_link', "That share link isn't complete. Check you copied all of it.");
  const share = await env.SHARES.get(`share:${await shareId(secret)}`, 'json');
  if (!share || share.secret !== secret || expired(share)) {
    throw new Refusal(404, 'link_off', 'This link has been turned off or has expired. Ask whoever sent it for a new one.');
  }
  const url = new URL(request.url);
  const repoPath = `/repos/${share.repo}`;

  if (request.method === 'GET' && path === '/share') {
    const token = await installationToken(env, share, 'read');
    const [repo, text] = await Promise.all([gh(repoPath, token), readFile(token, share.repo, INDEX_PATH)]);
    if (!repo.ok) throw new Refusal(404, 'no_repo', `${share.repo} isn't available any more.`);
    const index = parseIndex(text);
    if (share.job) index.features = index.features.filter((f) => f.properties?.path === share.job);
    const info = await repo.json();
    return reply(200, { ...describe(share, false), defaultBranch: info.default_branch, index });
  }

  if (request.method === 'GET' && (path === '/share/file' || path === '/share/commits')) {
    const file = url.searchParams.get('path') ?? '';
    if (!isJobPath(file) || (share.job && file !== share.job)) throw new Refusal(403, 'bad_path', "This link doesn't include that file.");
    const token = await installationToken(env, share, 'read');
    if (path === '/share/commits') {
      const res = await gh(`${repoPath}/commits?path=${encodeURIComponent(file)}&per_page=30`, token);
      if (!res.ok) throw new Error(`GitHub error ${res.status}`);
      const list = await res.json();
      return reply(
        200,
        list.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.author.date, author: c.commit.author.name })),
      );
    }
    const ref = url.searchParams.get('ref');
    if (ref && !/^[0-9a-f]{40}$/.test(ref)) throw new Refusal(400, 'bad_ref', "That version doesn't exist.");
    const res = await gh(`${repoPath}/contents/${encodePath(file)}${ref ? `?ref=${ref}` : ''}`, token, { accept: 'application/vnd.github.raw' });
    if (res.status === 404) throw new Refusal(404, 'no_file', `${file} isn't in ${share.repo} any more.`);
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    // Passed straight through, so big jobs aren't held in memory.
    return new Response(res.body, { status: 200, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST' && path === '/share/upload') {
    if (!share.upload) throw new Refusal(403, 'no_upload', "This link is for viewing only. Ask whoever sent it for one that allows uploads.");
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_UPLOAD * 1.1 + 64 * 1024) throw tooBig();
    const input = await readJson(request);
    const upload = checkUpload(input);
    await countUpload(env, share);
    const token = await installationToken(env, share, 'write');
    const result = await commitJob(token, share, upload);
    return reply(200, result);
  }
  return reply(405, { error: 'method_not_allowed' });
}

/** What the app is told about a link. Only admins get the secret back, to copy the link again. */
function describe(s, admin) {
  return {
    id: s.id,
    repo: s.repo,
    private: s.private,
    label: s.label,
    upload: s.upload,
    job: s.job,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    ...(admin && { secret: s.secret }),
  };
}

const expired = (s) => !!s.expiresAt && Date.now() > Date.parse(s.expiresAt);

async function countUpload(env, share) {
  // Approximate (KV isn't transactional), which is fine for stopping a flood.
  const key = `rate:${share.id}:${Math.floor(Date.now() / 3600_000)}`;
  const n = Number((await env.SHARES.get(key)) ?? 0);
  if (n >= UPLOADS_PER_HOUR) throw new Refusal(429, 'too_many', `This link has had ${UPLOADS_PER_HOUR} uploads in the last hour. Try again later.`);
  await env.SHARES.put(key, String(n + 1), { expirationTtl: 7200 });
}

// ------------------------------------------------------------------ checking an upload

const tooBig = () => new Refusal(413, 'too_big', `Job files can be up to ${MAX_UPLOAD / 1024 / 1024} MB through a share link.`);

/** A safe jobs/<name>/<name>.jxl|.rw5 path, as the app writes them. */
export function isJobPath(p) {
  const m = typeof p === 'string' && p.match(/^jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.(jxl|rw5)$/);
  return !!m && m[1] === m[2] && !m[1].includes('..');
}

const jobNameOf = (path) => path.split('/')[1];

export function looksLikeJob(text, format) {
  const head = text.slice(0, 8192);
  if (format === 'jxl') return /<JOBFile[\s>]/.test(head);
  return !/^\s*</.test(head) && /^(JB|MO|OC|BK|LS|SS|TR|SP|GPS|FD|BD),[A-Z]{2}/m.test(head);
}

/** The upload, checked; throws a Refusal saying what's wrong. */
export function checkUpload(input) {
  const bad = (msg) => new Refusal(400, 'bad_upload', msg);
  if (!input || typeof input.text !== 'string' || typeof input.entry !== 'object' || !input.entry) throw bad('The upload was incomplete.');
  if (new TextEncoder().encode(input.text).length > MAX_UPLOAD) throw tooBig();
  const e = input.entry;
  if (!isJobPath(e.path)) throw bad("The job's name can't be used as a file name.");
  const format = e.path.endsWith('.rw5') ? 'rw5' : 'jxl';
  if (!looksLikeJob(input.text, format)) throw bad(format === 'jxl' ? "That isn't a Trimble JobXML (.jxl) file." : "That isn't a Carlson raw (.rw5) file.");
  const jobName = cleanText(e.jobName, 200);
  if (!jobName) throw bad('The job has no name.');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!Number.isInteger(e.pointCount) || e.pointCount < 0) throw bad('The point count is missing.');
  let geometry = null;
  if (e.geometry) {
    const [lon, lat] = e.geometry.coordinates ?? [];
    if (e.geometry.type !== 'Point' || !num(lon) || !num(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw bad("The job's position is off the map.");
    geometry = { type: 'Point', coordinates: [lon, lat] };
  }
  if (e.bbox !== undefined && !(Array.isArray(e.bbox) && e.bbox.length === 4 && e.bbox.every(num))) throw bad("The job's extent is off the map.");
  let placement;
  if (e.placement !== undefined) {
    const p = e.placement;
    if (!p || !['north', 'east', 'lat', 'lon', 'rotation'].every((k) => num(p[k])) || typeof p.updated !== 'string') throw bad("The job's placement is incomplete.");
    placement = { north: p.north, east: p.east, lat: p.lat, lon: p.lon, rotation: p.rotation, updated: cleanText(p.updated, 40) };
  }
  const opt = (k) => (typeof e[k] === 'string' && cleanText(e[k], 200) ? { [k]: cleanText(e[k], 200) } : {});
  return {
    text: input.text,
    by: cleanText(input.by, 60),
    entry: {
      jobName,
      path: e.path,
      geometry,
      pointCount: e.pointCount,
      ...(e.bbox && { bbox: e.bbox }),
      ...opt('controller'),
      ...opt('product'),
      ...opt('jobTimeStamp'),
      ...opt('crs'),
      ...(placement && { placement }),
    },
  };
}

/** One line of plain text, trimmed and cut to `max` characters. */
function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

// ------------------------------------------------------------------ committing

function parseIndex(text) {
  if (!text) return { type: 'FeatureCollection', fieldview: { version: 1 }, features: [] };
  const parsed = JSON.parse(text);
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Refusal(409, 'bad_index', `${INDEX_PATH} isn't an OpenFieldView job index.`);
  return parsed;
}

/** Add or update a job's entry, as library.ts's upsertJob does in the app. */
export function upsertEntry(index, entry, blobSha, size, now) {
  const prev = index.features.find((f) => f.properties.path === entry.path);
  const { jobName, path, geometry, pointCount, bbox, controller, product, jobTimeStamp, crs, placement } = entry;
  const feature = {
    type: 'Feature',
    id: path.split('/')[1],
    geometry,
    properties: {
      jobName,
      path,
      blobSha,
      size,
      pointCount,
      ...(bbox && { bbox }),
      firstUpload: prev?.properties.firstUpload ?? now,
      lastUpload: now,
      uploadCount: (prev?.properties.uploadCount ?? 0) + 1,
      ...(controller && { controller }),
      ...(product && { product }),
      ...(jobTimeStamp && { jobTimeStamp }),
      ...(crs && { crs }),
      ...(placement && { placement }),
    },
  };
  const features = index.features.filter((f) => f.properties.path !== path).concat(feature);
  features.sort((a, b) => a.properties.path.localeCompare(b.properties.path));
  return { ...index, features };
}

const samePlacement = (a, b) =>
  !a || !b ? a === b : a.north === b.north && a.east === b.east && a.lat === b.lat && a.lon === b.lon && a.rotation === b.rotation;

async function commitJob(token, share, { text, by, entry }, now = new Date().toISOString()) {
  const base = `/repos/${share.repo}`;
  const repo = await json(gh(base, token));
  const branch = repo.default_branch;
  const head0 = await gh(`${base}/git/ref/heads/${encodePath(branch)}`, token);
  if (head0.status === 404 || head0.status === 409) {
    // An empty repo: the git data endpoints need a first commit.
    await json(
      gh(`${base}/contents/${INDEX_PATH}`, token, {
        method: 'PUT',
        body: { message: 'Start OpenFieldView job index', content: btoa(JSON.stringify(parseIndex(''), null, 2) + '\n') },
      }),
    );
  }
  const bytes = new TextEncoder().encode(text);
  const blobSha = await gitBlobSha(bytes);
  for (let attempt = 1; ; attempt++) {
    const head = (await json(gh(`${base}/git/ref/heads/${encodePath(branch)}`, token))).object.sha;
    const index = parseIndex(await readFile(token, share.repo, INDEX_PATH, head));
    const prev = index.features.find((f) => f.properties.path === entry.path);
    const sameFile = prev?.properties.blobSha === blobSha;
    if (sameFile && samePlacement(prev.properties.placement, entry.placement)) return { status: 'unchanged', path: entry.path };
    const next = upsertEntry(index, entry, blobSha, bytes.length, now);
    const message = [
      sameFile ? `Place ${entry.jobName} on the map` : `${prev ? 'Update' : 'Add'} ${entry.jobName} (${entry.pointCount} points)`,
      '',
      `Uploaded with the share link "${share.label}"${by ? ` by ${by}` : ''}`,
      ...(entry.controller ? [`Controller ${entry.controller}`] : []),
    ].join('\n');
    const headCommit = await json(gh(`${base}/git/commits/${head}`, token));
    const files = [
      { path: entry.path, content: text },
      { path: INDEX_PATH, content: JSON.stringify(next, null, 2) + '\n' },
    ];
    const tree = [];
    for (const f of files) {
      const blob = await json(gh(`${base}/git/blobs`, token, { method: 'POST', body: { content: f.content, encoding: 'utf-8' } }));
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await json(gh(`${base}/git/trees`, token, { method: 'POST', body: { base_tree: headCommit.tree.sha, tree } }));
    const commit = await json(gh(`${base}/git/commits`, token, { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } }));
    const res = await gh(`${base}/git/refs/heads/${encodePath(branch)}`, token, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    if (res.ok) return { status: 'saved', path: entry.path, commit: commit.sha };
    // 422: not a fast-forward, someone else pushed first.
    if (res.status !== 422 || attempt >= 3) throw new Error(`GitHub error ${res.status}`);
  }
}

async function readFile(token, repo, path, ref) {
  const res = await gh(`/repos/${repo}/contents/${encodePath(path)}${ref ? `?ref=${ref}` : ''}`, token, { accept: 'application/vnd.github.raw' });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.text();
}

/** The id git gives this content as a blob. */
async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}

// ------------------------------------------------------------------ GitHub App tokens

function requireShareSetup(env) {
  if (!env.SHARES || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Refusal(501, 'shares_not_configured', "Share links aren't set up on this site yet (docs/share-links.md).");
  }
}

// Installation ids and tokens, kept while this Worker instance lives.
const installations = new Map();
const tokens = new Map();

/** For tests, which each start a fresh GitHub. */
export function forgetTokens() {
  installations.clear();
  tokens.clear();
}

async function installationFor(env, repo) {
  if (installations.has(repo)) return installations.get(repo);
  const res = await gh(`/repos/${repo}/installation`, await appJwt(env));
  if (res.status === 404) throw new Refusal(404, 'not_installed', `OpenFieldView hasn't been given access to ${repo}.`);
  if (!res.ok) throw new Error(`GitHub error ${res.status} finding the app's installation`);
  const id = (await res.json()).id;
  installations.set(repo, id);
  return id;
}

/** A token for the link's one repo: contents read, or read and write. */
async function installationToken(env, share, access) {
  const key = `${share.repo}|${access}`;
  const hit = tokens.get(key);
  if (hit && hit.expires > Date.now() + 5 * 60_000) return hit.token;
  const installation = await installationFor(env, share.repo);
  const res = await gh(`/app/installations/${installation}/access_tokens`, await appJwt(env), {
    method: 'POST',
    body: { repositories: [share.repo.split('/')[1]], permissions: { contents: access, metadata: 'read' } },
  });
  if (res.status === 404 || res.status === 422) {
    // Reinstalled since, perhaps: look it up afresh next time.
    installations.delete(share.repo);
    throw new Refusal(404, 'not_installed', `OpenFieldView no longer has access to ${share.repo}.`);
  }
  if (!res.ok) throw new Error(`GitHub error ${res.status} getting an app token`);
  const t = await res.json();
  tokens.set(key, { token: t.token, expires: Date.parse(t.expires_at) });
  return t.token;
}

let signingKey;

/** A short-lived JWT that identifies the GitHub App itself. */
async function appJwt(env) {
  signingKey ??= importKey(env.GITHUB_APP_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => base64Url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: String(env.GITHUB_APP_ID).trim() })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey, new TextEncoder().encode(body));
  return `${body}.${base64Url(new Uint8Array(sig))}`;
}

/** GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto wants PKCS#8. */
export function importKey(pem) {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (pkcs1) der = pkcs1ToPkcs8(der);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export function pkcs1ToPkcs8(pkcs1) {
  const len = (n) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  const tlv = (tag, body) => [tag, ...len(body.length), ...body];
  // version 0, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING { the PKCS#1 key }
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = tlv(0x04, Array.from(pkcs1));
  return new Uint8Array(tlv(0x30, [...version, ...algorithm, ...octet]));
}

// ------------------------------------------------------------------ helpers

async function gh(path, token, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
}

async function json(resPromise) {
  const res = await resPromise;
  if (!res.ok) {
    const detail = await res.json().then((b) => b.message, () => '');
    throw new Error(`GitHub error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Refusal(400, 'bad_json', 'The request was garbled. Try again.');
  }
}

function bearer(request, scheme) {
  const m = (request.headers.get('Authorization') ?? '').match(new RegExp(`^${scheme} (\\S+)$`));
  return m?.[1];
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** 32 random bytes as base64url: 43 characters. */
function randomSecret() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function shareId(secret) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
}

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
