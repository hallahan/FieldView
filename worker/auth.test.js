import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { checkUpload, forgetTokens, isJobPath, upsertEntry, UPLOADS_PER_HOUR } from './auth.js';
import { FakeGitHub, FakeKV, makeKeys } from './test/fake-github.js';
import { upsertEntry as appUpsertEntry } from '../src/library';

const ORIGIN = 'https://hallahan.github.io';
const JXL = readFileSync(new URL('../src/fixtures/access-2026.jxl', import.meta.url), 'utf8');
const keys = makeKeys();
const index = (features) => JSON.stringify({ type: 'FeatureCollection', fieldview: { version: 1 }, features });
const feature = (name, extra = {}) => ({
  type: 'Feature',
  id: name,
  geometry: { type: 'Point', coordinates: [-121.5, 38.5] },
  properties: { jobName: name, path: `jobs/${name}/${name}.jxl`, blobSha: 'x', size: 3, pointCount: 1, firstUpload: '2026-01-01T00:00:00Z', lastUpload: '2026-01-01T00:00:00Z', uploadCount: 1, ...extra },
});

let github;
let env;

beforeEach(() => {
  forgetTokens();
  github = new FakeGitHub({
    publicKey: keys.publicKey,
    users: { 'nick-token': { login: 'hallahan', admin: new Set(['hallahan/OFVData', 'hallahan/Public']) }, 'crew-token': { login: 'crew', admin: new Set() } },
    repos: {
      'hallahan/OFVData': {
        private: true,
        files: {
          'index.geojson': index([feature('Guardrail'), feature('Bridge')]),
          'jobs/Guardrail/Guardrail.jxl': '<JOBFile>guardrail</JOBFile>',
          'jobs/Bridge/Bridge.jxl': '<JOBFile>bridge</JOBFile>',
          'secrets.txt': 'not for links',
        },
      },
      'hallahan/Public': {},
      'hallahan/NotInstalled': { installed: false },
    },
  });
  vi.stubGlobal('fetch', github.fetch);
  env = {
    GITHUB_CLIENT_ID: 'Iv1',
    GITHUB_CLIENT_SECRET: 's',
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: keys.pem,
    SHARES: new FakeKV(),
  };
});
afterEach(() => vi.unstubAllGlobals());

async function call(path, { method = 'GET', auth, body, origin = ORIGIN } = {}) {
  const res = await worker.fetch(
    new Request(`https://auth.example.workers.dev${path}`, {
      method,
      headers: { Origin: origin, ...(auth && { Authorization: auth }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const create = (body, token = 'nick-token') => call('/shares', { method: 'POST', auth: `Bearer ${token}`, body: { repo: 'hallahan/OFVData', label: 'Crew 2', ...body } });
const share = (secret, path = '/share', init = {}) => call(path, { ...init, auth: `Share ${secret}` });
const upload = (secret, body) =>
  share(secret, '/share/upload', {
    method: 'POST',
    body: { text: JXL, entry: { jobName: 'New job', path: 'jobs/New_job/New_job.jxl', geometry: { type: 'Point', coordinates: [-121, 38] }, pointCount: 12 }, by: 'Sam', ...body },
  });

describe('making links', () => {
  it('lets a repo admin create, list and revoke links', async () => {
    const made = await create({ upload: true, expiresInDays: 30 });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ repo: 'hallahan/OFVData', private: true, label: 'Crew 2', upload: true, createdBy: 'hallahan' });
    expect(made.json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(made.json.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400_000);
    // Stored under a hash of the secret, never the secret itself.
    expect([...env.SHARES.data.keys()]).toEqual([`share:${made.json.id}`]);
    expect(made.json.id).not.toContain(made.json.secret);

    const list = await call('/shares?repo=hallahan/OFVData', { auth: 'Bearer nick-token' });
    expect(list.json.links.map((l) => l.id)).toEqual([made.json.id]);
    expect((await call('/shares?repo=hallahan/Public', { auth: 'Bearer nick-token' })).json.links).toEqual([]);

    expect((await share(made.json.secret)).status).toBe(200);
    expect((await call(`/shares/${made.json.id}`, { method: 'DELETE', auth: 'Bearer nick-token' })).status).toBe(200);
    const after = await share(made.json.secret);
    expect(after.status).toBe(404);
    expect(after.json.message).toMatch(/turned off or has expired/);
  });

  it('refuses people who are not admins of the repo, or not signed in', async () => {
    expect((await create({}, 'crew-token')).status).toBe(404); // private repo they can't see
    github.users['crew-token'].admin = new Set();
    github.repos['hallahan/public'].private = false;
    const r = await call('/shares', { method: 'POST', auth: 'Bearer crew-token', body: { repo: 'hallahan/Public' } });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/Only an admin/);
    expect((await create({}, 'bogus')).status).toBe(401);
    expect((await call('/shares', { method: 'POST', body: { repo: 'hallahan/OFVData' } })).status).toBe(401);
    const made = await create({});
    expect((await call(`/shares/${made.json.id}`, { method: 'DELETE', auth: 'Bearer crew-token' })).status).toBe(404);
    expect((await share(made.json.secret)).status).toBe(200);
  });

  it("says so when the app can't reach the repo", async () => {
    const r = await call('/shares', { method: 'POST', auth: 'Bearer nick-token', body: { repo: 'hallahan/NotInstalled' } });
    github.users['nick-token'].admin.add('hallahan/NotInstalled');
    const r2 = await call('/shares', { method: 'POST', auth: 'Bearer nick-token', body: { repo: 'hallahan/NotInstalled' } });
    expect(r.status).toBe(403);
    expect(r2.status).toBe(404);
    expect(r2.json.message).toMatch(/hasn't been given access/);
  });

  it('makes job links view only', async () => {
    const made = await create({ upload: true, job: 'jobs/Bridge/Bridge.jxl' });
    expect(made.json).toMatchObject({ upload: false, job: 'jobs/Bridge/Bridge.jxl', label: 'Crew 2' });
    expect((await create({ job: '../secrets.txt' })).status).toBe(400);
  });

  it('answers only the allowed origins', async () => {
    expect((await call('/share', { auth: 'Share x', origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('using a link', () => {
  it('shows the jobs and serves their files, without a GitHub account', async () => {
    const { secret } = (await create({})).json;
    const r = await share(secret);
    expect(r.json).toMatchObject({ repo: 'hallahan/OFVData', private: true, upload: false, label: 'Crew 2', defaultBranch: 'main' });
    expect(r.json.secret).toBeUndefined();
    expect(r.json.index.features.map((f) => f.properties.jobName)).toEqual(['Guardrail', 'Bridge']);

    const file = await share(secret, '/share/file?path=jobs/Guardrail/Guardrail.jxl');
    expect(file.status).toBe(200);
    expect(file.text).toBe('<JOBFile>guardrail</JOBFile>');
    expect(file.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

    const commits = await share(secret, '/share/commits?path=jobs/Guardrail/Guardrail.jxl');
    expect(commits.json).toHaveLength(1);
    const old = await share(secret, `/share/file?path=jobs/Guardrail/Guardrail.jxl&ref=${commits.json[0].sha}`);
    expect(old.text).toBe('<JOBFile>guardrail</JOBFile>');

    // GitHub was only asked with a read-only token for this one repo.
    const used = github.calls.filter((c) => c.auth.startsWith('inst-')).map((c) => c.auth);
    expect(used.every((t) => t.startsWith('inst-read'))).toBe(true);
  });

  it('only reaches job files', async () => {
    const { secret } = (await create({})).json;
    for (const path of ['secrets.txt', 'jobs/../secrets.txt', 'jobs/a/b.jxl', 'jobs/.x/.x.jxl', 'index.geojson']) {
      expect((await share(secret, `/share/file?path=${encodeURIComponent(path)}`)).status).toBe(403);
    }
    expect((await share(secret, '/share/file?path=jobs/Bridge/Bridge.jxl&ref=main')).status).toBe(400);
  });

  it('limits a job link to its job', async () => {
    const { secret } = (await create({ job: 'jobs/Bridge/Bridge.jxl' })).json;
    expect((await share(secret)).json.index.features.map((f) => f.properties.jobName)).toEqual(['Bridge']);
    expect((await share(secret, '/share/file?path=jobs/Bridge/Bridge.jxl')).status).toBe(200);
    expect((await share(secret, '/share/file?path=jobs/Guardrail/Guardrail.jxl')).status).toBe(403);
    expect((await upload(secret)).status).toBe(403);
  });

  it('turns away wrong, partial and expired links', async () => {
    const { secret } = (await create({ expiresInDays: 1 })).json;
    expect((await share(secret.slice(0, 20))).status).toBe(401);
    expect((await share(secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A'))).status).toBe(404);
    expect((await call('/share')).status).toBe(401);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 86400_000);
    try {
      expect((await share(secret)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't let a view-only link upload", async () => {
    const { secret } = (await create({})).json;
    const r = await upload(secret);
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/viewing only/);
  });
});

describe('uploading through a link', () => {
  it('commits the job and its index entry, saying who uploaded it', async () => {
    const { secret } = (await create({ upload: true })).json;
    const r = await upload(secret);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'saved', path: 'jobs/New_job/New_job.jxl' });
    const files = github.files('hallahan/OFVData');
    expect(files.get('jobs/New_job/New_job.jxl')).toBe(JXL);
    expect(files.get('secrets.txt')).toBe('not for links');
    const idx = JSON.parse(files.get('index.geojson'));
    expect(idx.features.map((f) => f.properties.path)).toEqual(['jobs/Bridge/Bridge.jxl', 'jobs/Guardrail/Guardrail.jxl', 'jobs/New_job/New_job.jxl']);
    const entry = idx.features[2];
    expect(entry).toMatchObject({ id: 'New_job', geometry: { coordinates: [-121, 38] }, properties: { jobName: 'New job', pointCount: 12, uploadCount: 1 } });
    expect(entry.properties.size).toBe(new TextEncoder().encode(JXL).length);
    expect(github.history('hallahan/OFVData')[0].message).toBe('Add New job (12 points)\n\nUploaded with the share link "Crew 2" by Sam');

    // The same file again changes nothing; a new version is a new commit.
    expect((await upload(secret)).json.status).toBe('unchanged');
    const again = await upload(secret, { text: JXL + '\n' });
    expect(again.json.status).toBe('saved');
    const updated = JSON.parse(github.files('hallahan/OFVData').get('index.geojson')).features[2].properties;
    expect(updated.uploadCount).toBe(2);
    expect(updated.firstUpload).toBe(entry.properties.firstUpload);
    expect(github.history('hallahan/OFVData')[0].message).toMatch(/^Update New job/);
  });

  it('starts the index in an empty repo', async () => {
    const made = await call('/shares', { method: 'POST', auth: 'Bearer nick-token', body: { repo: 'hallahan/Public', upload: true } });
    const r = await upload(made.json.secret);
    expect(r.json.status).toBe('saved');
    expect(JSON.parse(github.files('hallahan/Public').get('index.geojson')).features).toHaveLength(1);
  });

  it('turns away files that are not jobs, and bad entries', async () => {
    const { secret } = (await create({ upload: true })).json;
    const bad = async (body) => (await upload(secret, body)).json.message;
    expect(await bad({ text: '<html>hi</html>' })).toMatch(/isn't a Trimble JobXML/);
    expect(await bad({ entry: { jobName: 'x', path: 'index.geojson', pointCount: 1 } })).toMatch(/file name/);
    expect(await bad({ entry: { jobName: 'x', path: 'jobs/x/x.jxl', pointCount: 1, geometry: { type: 'Point', coordinates: [500, 0] } } })).toMatch(/off the map/);
    expect(await bad({ entry: { jobName: 'x', path: 'jobs/x/x.rw5', pointCount: 1 } })).toMatch(/Carlson/);
    expect(github.history('hallahan/OFVData')).toHaveLength(1);
  });

  it('limits uploads per hour', async () => {
    const { secret, id } = (await create({ upload: true })).json;
    await env.SHARES.put(`rate:${id}:${Math.floor(Date.now() / 3600_000)}`, String(UPLOADS_PER_HOUR));
    const r = await upload(secret);
    expect(r.status).toBe(429);
  });
});

describe('checks', () => {
  it('knows job paths', () => {
    expect(isJobPath('jobs/Guardrail_topo/Guardrail_topo.jxl')).toBe(true);
    expect(isJobPath('jobs/a.b/a.b.rw5')).toBe(true);
    expect(isJobPath('jobs/a/b.jxl')).toBe(false);
    expect(isJobPath('jobs/../...jxl')).toBe(false);
    expect(isJobPath('jobs/x/x.txt')).toBe(false);
  });

  it('cleans what goes into the index and the commit', () => {
    const u = checkUpload({
      text: JXL,
      by: 'Sam\n\nSigned-off-by: someone',
      entry: { jobName: 'A\u0000b', path: 'jobs/A_b/A_b.jxl', pointCount: 3, geometry: null, extra: 'dropped', crs: 'x'.repeat(500) },
    });
    expect(u.by).toBe('Sam Signed-off-by: someone');
    expect(u.entry).toEqual({ jobName: 'A b', path: 'jobs/A_b/A_b.jxl', pointCount: 3, geometry: null, crs: 'x'.repeat(200) });
  });

  it('writes index entries the same way the app does', () => {
    const idx = JSON.parse(index([feature('Bridge')]));
    const entry = {
      jobName: 'Bridge',
      path: 'jobs/Bridge/Bridge.jxl',
      geometry: { type: 'Point', coordinates: [1, 2] },
      pointCount: 5,
      bbox: [0, 1, 2, 3],
      controller: 'TSC7',
      crs: 'CA zone 3',
      placement: { north: 1, east: 2, lat: 3, lon: 4, rotation: 5, updated: 'now' },
    };
    expect(upsertEntry(idx, entry, 'abc', 10, '2026-10-28T00:00:00Z')).toEqual(appUpsertEntry(idx, entry, 'abc', 10, '2026-10-28T00:00:00Z'));
  });
});
