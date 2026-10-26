// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHub, gitBlobSha, parseRepo, toBase64 } from './github';
import { parseJxl } from './jxl';
import { footprint, INDEX_PATH, jobPath, parseIndex, saveJob } from './library';
import { applyPlacement, initialPlacement } from './placement';

const sample = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');
const local = readFileSync(resolve(__dirname, '../public/sample-local.jxl'), 'utf8');

describe('helpers', () => {
  it('computes the same blob id as git', async () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('base64-encodes UTF-8 and large text', () => {
    expect(toBase64('°')).toBe('wrA=');
    const big = 'x'.repeat(200_000);
    expect(atob(toBase64(big))).toBe(big);
  });

  it('parses repo names and URLs', () => {
    expect(parseRepo('hallahan/fieldview-data')).toEqual({ owner: 'hallahan', name: 'fieldview-data' });
    expect(parseRepo('https://github.com/hallahan/FieldView.git')).toEqual({ owner: 'hallahan', name: 'FieldView' });
    expect(parseRepo('not a repo')).toBeUndefined();
  });

  it('keeps job paths to safe characters', () => {
    expect(jobPath('25-050_GuardrailTopoNH4')).toBe('jobs/25-050_GuardrailTopoNH4/25-050_GuardrailTopoNH4.jxl');
    expect(jobPath('Walnut Creek Topo (sample)')).toBe('jobs/Walnut_Creek_Topo_sample_/Walnut_Creek_Topo_sample_.jxl');
  });

  it('puts the centroid inside the job', () => {
    const fp = footprint(parseJxl(sample))!;
    const [w, s, e, n] = fp.bbox;
    expect(fp.center[0]).toBeGreaterThan(w);
    expect(fp.center[0]).toBeLessThan(e);
    expect(fp.center[1]).toBeGreaterThan(s);
    expect(fp.center[1]).toBeLessThan(n);
  });
});

/** Just enough of the GitHub git API, kept in memory. */
class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  head: string | undefined;
  private seq = 0;
  /** Simulate someone else pushing just before our next ref update. */
  raceOnce: (() => void) | undefined;

  files(sha = this.head): Record<string, string> {
    if (!sha) return {};
    const tree = this.trees.get(this.commits.get(sha)!.tree)!;
    return Object.fromEntries(Object.entries(tree).map(([p, b]) => [p, this.blobs.get(b)!]));
  }

  commitFiles(files: Record<string, string>, message: string) {
    const tree = { ...(this.head ? this.trees.get(this.commits.get(this.head)!.tree) : {}) };
    for (const [p, text] of Object.entries(files)) {
      const b = this.id();
      this.blobs.set(b, text);
      tree[p] = b;
    }
    const t = this.id();
    this.trees.set(t, tree);
    const c = this.id();
    this.commits.set(c, { tree: t, parents: this.head ? [this.head] : [], message });
    this.head = c;
  }

  private id() {
    return (++this.seq).toString(16).padStart(40, '0');
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r/, ''));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

    if (path === '' && method === 'GET') return json({ private: true, default_branch: 'main', size: this.head ? 1 : 0, permissions: { push: true } });
    if (path === '/git/ref/heads/main') return this.head ? json({ object: { sha: this.head } }) : json({ message: 'Git Repository is empty.' }, 409);
    let m = path.match(/^\/contents\/(.+)$/);
    if (m && method === 'GET') {
      const text = this.files(u.searchParams.get('ref') ?? this.head)[m[1]];
      return text === undefined ? json({ message: 'Not Found' }, 404) : new Response(text);
    }
    if (m && method === 'PUT') {
      this.commitFiles({ [m[1]]: fromB64(body.content) }, body.message);
      return json({}, 201);
    }
    m = path.match(/^\/git\/commits\/(\w+)$/);
    if (m) return json({ tree: { sha: this.commits.get(m[1])!.tree } });
    if (path === '/git/blobs') {
      const b = this.id();
      this.blobs.set(b, fromB64(body.content));
      return json({ sha: b }, 201);
    }
    if (path === '/git/trees') {
      const t = this.id();
      const tree = { ...this.trees.get(body.base_tree) };
      for (const e of body.tree) tree[e.path] = e.sha;
      this.trees.set(t, tree);
      return json({ sha: t }, 201);
    }
    if (path === '/git/commits') {
      const c = this.id();
      this.commits.set(c, body);
      return json({ sha: c }, 201);
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      if (this.raceOnce) {
        this.raceOnce();
        this.raceOnce = undefined;
      }
      if (this.commits.get(body.sha)!.parents[0] !== this.head) return json({ message: 'Update is not a fast forward' }, 422);
      this.head = body.sha;
      return json({});
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
}

describe('saveJob', () => {
  let fake: FakeGitHub;
  const gh = () => new GitHub({ owner: 'o', name: 'r' }, 'token');
  const doc = parseJxl(sample);

  beforeEach(() => {
    fake = new FakeGitHub();
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => fake.fetch(url, init)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts an empty repo and commits the job with its index entry', async () => {
    const r = await saveJob(gh(), sample, doc, 'sample.jxl', '2026-10-25T12:00:00Z');
    expect(r.status).toBe('saved');
    const files = fake.files();
    expect(files[jobPath('Walnut Creek Topo (sample)')]).toBe(sample);
    const index = parseIndex(files[INDEX_PATH]);
    expect(index.features).toHaveLength(1);
    expect(index.features[0].geometry?.type).toBe('Point');
    expect(index.features[0].properties).toMatchObject({ jobName: 'Walnut Creek Topo (sample)', uploadCount: 1, pointCount: 29 });
    // The job and its index entry land in the same commit.
    expect(fake.commits.size).toBe(2);
  });

  it('skips an identical upload and versions a changed one', async () => {
    await saveJob(gh(), sample, doc, 'sample.jxl', '2026-10-25T12:00:00Z');
    expect((await saveJob(gh(), sample, doc, 'sample.jxl')).status).toBe('unchanged');

    const edited = sample.replace('</JOBFile>', '<!-- day 2 -->\n</JOBFile>');
    await saveJob(gh(), edited, parseJxl(edited), 'sample.jxl', '2026-10-26T12:00:00Z');
    const p = parseIndex(fake.files()[INDEX_PATH]).features[0].properties;
    expect(p).toMatchObject({ uploadCount: 2, firstUpload: '2026-10-25T12:00:00Z', lastUpload: '2026-10-26T12:00:00Z' });
    expect(fake.commits.get(fake.head!)!.message).toMatch(/^Update Walnut Creek Topo/);
  });

  it('keeps a job someone else saved at the same moment', async () => {
    await saveJob(gh(), sample, doc, 'sample.jxl');
    const other = sample.replace('Walnut Creek Topo (sample)', 'Other job');
    fake.raceOnce = () => {
      const index = parseIndex(fake.files()[INDEX_PATH]);
      index.features.push({ ...index.features[0], properties: { ...index.features[0].properties, path: 'jobs/x/x.jxl', jobName: 'x' } });
      fake.commitFiles({ [INDEX_PATH]: JSON.stringify(index), 'jobs/x/x.jxl': 'x' }, 'other device');
    };
    await saveJob(gh(), other, parseJxl(other), 'other.jxl');
    const names = parseIndex(fake.files()[INDEX_PATH]).features.map((f) => f.properties.jobName);
    expect(names.sort()).toEqual(['Other job', 'Walnut Creek Topo (sample)', 'x']);
  });

  it('keeps where a job in assumed coordinates was placed, and saves a new placement on its own', async () => {
    const placed = parseJxl(local);
    placed.placement = initialPlacement(placed.points, 37.9, -122.06, '2026-10-26T12:00:00Z');
    applyPlacement(placed.points, placed.placement!);
    await saveJob(gh(), local, placed, 'sample-local.jxl', '2026-10-26T12:00:00Z');
    let f = parseIndex(fake.files()[INDEX_PATH]).features[0];
    expect(f.properties.placement).toEqual(placed.placement);
    // The job's pin on the Jobs map is where it was placed.
    expect(f.geometry?.coordinates[0]).toBeCloseTo(-122.06, 3);
    expect(f.geometry?.coordinates[1]).toBeCloseTo(37.9, 3);
    expect((await saveJob(gh(), local, placed, 'sample-local.jxl')).status).toBe('unchanged');

    placed.placement = { ...placed.placement!, rotation: 15, updated: '2026-10-26T13:00:00Z' };
    expect((await saveJob(gh(), local, placed, 'sample-local.jxl')).status).toBe('saved');
    f = parseIndex(fake.files()[INDEX_PATH]).features[0];
    expect(f.properties.placement?.rotation).toBe(15);
    expect(fake.commits.get(fake.head!)!.message).toBe('Place Assumed Coordinates (sample) on the map');
  });
});
