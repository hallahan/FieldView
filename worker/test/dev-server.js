// Runs worker/auth.js locally against the fake GitHub, to try share links in
// the app without a GitHub App or Cloudflare account:
//
//   node worker/test/dev-server.js        (listens on http://localhost:8787)
//   VITE_AUTH_URL=http://localhost:8787 VITE_GITHUB_CLIENT_ID=dev npm run dev
//
// It prints a view link and an upload link for a private repo, and accepts
// "dev-admin" as a signed-in admin's GitHub token.

import { createServer } from 'node:http';
import worker from '../auth.js';
import { FakeGitHub, FakeKV, makeKeys } from './fake-github.js';

const PORT = Number(process.env.PORT ?? 8787);
const APP = process.env.APP ?? 'http://localhost:5173/';
const keys = makeKeys();
export const github = new FakeGitHub({
  publicKey: keys.publicKey,
  users: { 'dev-admin': { login: 'hallahan', admin: new Set(['hallahan/OFVData']) } },
  repos: { 'hallahan/OFVData': { private: true } },
});
const env = {
  GITHUB_CLIENT_ID: 'dev',
  GITHUB_CLIENT_SECRET: 'dev',
  ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:4173',
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: keys.pem,
  SHARES: new FakeKV(),
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (String(input).startsWith('https://api.github.com/') ? github.fetch(input, init) : realFetch(input, init));

async function handle(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  // The app's own GitHub calls when signed in as dev-admin, for browser tests that route api.github.com here.
  if (req.url.startsWith('/__github/')) {
    const h = req.headers;
    const out = await github.fetch(`https://api.github.com/${req.url.slice('/__github/'.length)}`, {
      method: req.method,
      headers: { Authorization: h.authorization ?? '', Accept: h.accept ?? '' },
      body: body?.toString(),
    });
    res.writeHead(out.status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}

async function link(body) {
  const res = await worker.fetch(
    new Request(`http://localhost:${PORT}/shares`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', Authorization: 'Bearer dev-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'hallahan/OFVData', ...body }),
    }),
    env,
  );
  return (await res.json()).secret;
}

createServer((req, res) => handle(req, res).catch((e) => (res.writeHead(500), res.end(String(e))))).listen(PORT, async () => {
  const view = await link({ label: 'Office', expiresInDays: 30 });
  const upload = await link({ label: 'Crew 2', upload: true, expiresInDays: 90 });
  console.log(JSON.stringify({ worker: `http://localhost:${PORT}`, view: `${APP}#share=${view}`, upload: `${APP}#share=${upload}` }));
});
