// A small in-memory stand-in for the parts of api.github.com the worker uses,
// plus an in-memory Workers KV, for tests and for trying the share pages
// locally (worker/test/dev-server.js).

import { createVerify, generateKeyPairSync } from 'node:crypto';

export function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // GitHub hands out PKCS#1 keys.
  return { pem: privateKey.export({ type: 'pkcs1', format: 'pem' }), publicKey };
}

export class FakeKV {
  data = new Map();
  async get(key, type) {
    const v = this.data.get(key);
    if (!v || (v.expiration && v.expiration * 1000 < Date.now())) return null;
    return type === 'json' ? JSON.parse(v.value) : v.value;
  }
  async put(key, value, opts = {}) {
    this.data.set(key, { value, metadata: opts.metadata, expiration: opts.expiration ?? (opts.expirationTtl && Date.now() / 1000 + opts.expirationTtl) });
  }
  async delete(key) {
    this.data.delete(key);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.data.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata }));
    return { keys, list_complete: true };
  }
}

let n = 0;
const sha = () => (++n).toString(16).padStart(40, '0');

export class FakeGitHub {
  /**
   * users: token → { login, admin: Set of repo slugs }.
   * repos: slug → { private, files: { path: text } } (empty files: no commits).
   */
  constructor({ publicKey, appId = '123', users = {}, repos = {} }) {
    this.publicKey = publicKey;
    this.appId = appId;
    this.users = users;
    this.repos = {};
    this.tokens = new Map();
    this.calls = [];
    for (const [slug, r] of Object.entries(repos)) this.addRepo(slug, r);
  }

  addRepo(slug, { private: priv = false, files = {}, installed = true }) {
    const repo = { slug, private: priv, installed, commits: new Map(), trees: new Map(), blobs: new Map(), head: undefined };
    if (Object.keys(files).length) this.commit(repo, new Map(Object.entries(files)), 'Initial', undefined);
    this.repos[slug.toLowerCase()] = repo;
    return repo;
  }

  commit(repo, tree, message, parent) {
    const treeSha = sha();
    repo.trees.set(treeSha, tree);
    const c = sha();
    repo.commits.set(c, { tree: treeSha, message, parent, date: new Date().toISOString() });
    repo.head = c;
    return c;
  }

  files(slug, ref) {
    const repo = this.repos[slug.toLowerCase()];
    const c = repo.commits.get(ref ?? repo.head);
    return c ? repo.trees.get(c.tree) : new Map();
  }

  history(slug) {
    const repo = this.repos[slug.toLowerCase()];
    const out = [];
    for (let c = repo.head; c; c = repo.commits.get(c).parent) out.push({ sha: c, ...repo.commits.get(c) });
    return out;
  }

  verifyJwt(jwt) {
    const [h, p, s] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    if (!v.verify(this.publicKey, Buffer.from(s, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    return claims.iss === this.appId && claims.exp > Date.now() / 1000;
  }

  /** A fetch for api.github.com. */
  fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const auth = (init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const raw = init.headers?.Accept === 'application/vnd.github.raw';
    this.calls.push({ method, path: url.pathname + url.search, auth });
    const res = (status, b) => new Response(typeof b === 'string' ? b : JSON.stringify(b ?? {}), { status });
    const p = url.pathname;

    if (p === '/user') {
      const u = this.users[auth];
      return u ? res(200, { login: u.login }) : res(401, { message: 'Bad credentials' });
    }

    let m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m && method === 'POST') {
      if (!this.verifyJwt(auth)) return res(401, { message: 'bad jwt' });
      const repo = Object.values(this.repos).find((r) => r.slug.split('/')[1].toLowerCase() === body.repositories[0].toLowerCase());
      if (!repo?.installed) return res(404, { message: 'Not Found' });
      const token = `inst-${body.permissions.contents}-${sha().slice(-6)}`;
      this.tokens.set(token, { repo: repo.slug.toLowerCase(), write: body.permissions.contents === 'write' });
      return res(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return res(404, { message: 'Not Found' });
    const slug = m[1].toLowerCase();
    const rest = m[2] ?? '';
    const repo = this.repos[slug];
    if (!repo) return res(404, { message: 'Not Found' });

    if (rest === '/installation') {
      if (!this.verifyJwt(auth)) return res(401, { message: 'bad jwt' });
      return repo.installed ? res(200, { id: 7 }) : res(404, { message: 'Not Found' });
    }

    const user = this.users[auth];
    const inst = this.tokens.get(auth);
    if (inst && inst.repo !== slug) return res(404, { message: 'Not Found' });
    if (!inst && repo.private && !user?.admin?.has(repo.slug)) return res(404, { message: 'Not Found' });
    const canWrite = inst?.write || user?.admin?.has(repo.slug);

    if (rest === '') {
      return res(200, {
        full_name: repo.slug,
        private: repo.private,
        default_branch: 'main',
        size: repo.head ? 1 : 0,
        ...(user && { permissions: { admin: !!user.admin?.has(repo.slug), push: !!user.admin?.has(repo.slug) } }),
      });
    }

    m = rest.match(/^\/contents\/(.+)$/);
    if (m && method === 'GET') {
      const path = decodeURIComponent(m[1]);
      const ref = url.searchParams.get('ref') ?? undefined;
      if (!repo.head) return res(404, { message: 'This repository is empty.' });
      const text = this.files(repo.slug, ref)?.get(path);
      if (text === undefined) return res(404, { message: 'Not Found' });
      return raw ? new Response(text, { status: 200 }) : res(200, { content: Buffer.from(text).toString('base64') });
    }
    if (m && method === 'PUT') {
      if (!canWrite) return res(403, { message: 'Resource not accessible by integration' });
      const files = new Map(this.files(repo.slug));
      files.set(decodeURIComponent(m[1]), Buffer.from(body.content, 'base64').toString());
      return res(201, { commit: { sha: this.commit(repo, files, body.message, repo.head) } });
    }

    if (rest === '/commits') {
      const path = url.searchParams.get('path');
      const list = this.history(repo.slug).filter((c, i, all) => {
        const now = repo.trees.get(c.tree).get(path);
        const before = all[i + 1] && repo.trees.get(all[i + 1].tree).get(path);
        return now !== undefined && now !== before;
      });
      return res(
        200,
        list.map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: 'someone', date: c.date } } })),
      );
    }

    if (rest === '/git/ref/heads/main') {
      return repo.head ? res(200, { object: { sha: repo.head } }) : res(409, { message: 'Git Repository is empty.' });
    }
    m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/);
    if (m) return res(200, { tree: { sha: repo.commits.get(m[1]).tree } });

    if (!canWrite) return res(403, { message: 'Resource not accessible by integration' });
    if (rest === '/git/blobs') {
      const s = sha();
      repo.blobs.set(s, body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString() : body.content);
      return res(201, { sha: s });
    }
    if (rest === '/git/trees') {
      const tree = new Map(repo.trees.get(body.base_tree));
      for (const e of body.tree) tree.set(e.path, repo.blobs.get(e.sha));
      const s = sha();
      repo.trees.set(s, tree);
      return res(201, { sha: s });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const s = sha();
      repo.commits.set(s, { tree: body.tree, message: body.message, parent: body.parents[0], date: new Date().toISOString() });
      return res(201, { sha: s });
    }
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      if (repo.commits.get(body.sha).parent !== repo.head) return res(422, { message: 'Update is not a fast forward' });
      repo.head = body.sha;
      return res(200, { object: { sha: body.sha } });
    }
    return res(404, { message: 'Not Found' });
  };
}
