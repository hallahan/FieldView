// Runs the upload steps against wrangler's local R2, which behaves like the
// real bucket for conditional writes and checksums.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import type { IndexEntry, JobIndex, UploadRecord, VersionList } from '../src/layout';
import { commit, plan, putFile, rebuild, StoreError, type Kind, type Plan } from './store';

let bucket: R2Bucket;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ BUCKET: R2Bucket }>({ persist: false });
  bucket = proxy.env.BUCKET;
  dispose = proxy.dispose;
}, 60_000);
afterAll(() => dispose?.());

beforeEach(async () => {
  for (;;) {
    const page = await bucket.list();
    if (!page.objects.length) break;
    await bucket.delete(page.objects.map((o) => o.key));
  }
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL = 'crew@example.com';
const T0 = new Date('2026-10-28T21:36:27.123Z');
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

interface F {
  name: string;
  body: string;
  kind: Kind;
}

/** All three steps, as the app does them. */
async function send(job: string, files: F[], now = T0, note?: string) {
  const p = await plan(bucket, { job, files: files.map((f) => ({ name: f.name, size: f.body.length, sha256: sha(f.body), kind: f.kind })) }, now);
  if (p.status !== 'upload') return { plan: p };
  for (const f of p.files.filter((x) => x.needed)) {
    const src = files.find((x) => sha(x.body) === f.sha256)!;
    await putFile(bucket, f.key, new TextEncoder().encode(src.body).buffer as ArrayBuffer, f.sha256, 'text/plain', EMAIL, now.getTime());
  }
  const record = await commit(bucket, { job, stamp: p.stamp, note, files: p.files, summary: { pointCount: 3, center: [-122, 38] } }, EMAIL, now);
  return { plan: p, record };
}

const read = async <T>(key: string) => (await (await bucket.get(key))?.json()) as T;
const text = async (key: string) => (await bucket.get(key))?.text();

describe('uploads', () => {
  it('lays a first upload out by job name and UTC time', async () => {
    const { plan: p, record } = await send(
      '25-050 Guardrail Topo',
      [
        { name: '25-050 Guardrail Topo.jxl', body: '<JOBFile/>', kind: 'job' },
        { name: '25-050 Guardrail Topo.job', body: 'binary', kind: 'job' },
        { name: 'IMG_0001.jpg', body: 'photo 1', kind: 'media' },
      ],
      T0,
      'North side done',
    );
    expect((p as Extract<Plan, { status: 'upload' }>).stamp).toBe('2026-10-28T213627Z');
    const keys = (await bucket.list()).objects.map((o) => o.key).sort();
    expect(keys).toEqual([
      '25-050 Guardrail Topo/2026-10-28T213627Z/25-050 Guardrail Topo.job',
      '25-050 Guardrail Topo/2026-10-28T213627Z/25-050 Guardrail Topo.jxl',
      '25-050 Guardrail Topo/2026-10-28T213627Z/upload.json',
      '25-050 Guardrail Topo/media/IMG_0001.jpg',
      '25-050 Guardrail Topo/versions.json',
      'index.json',
    ]);
    expect(record!.uploadedBy).toBe(EMAIL);
    expect(record!.note).toBe('North side done');
    expect(record!.main).toBe('25-050 Guardrail Topo/2026-10-28T213627Z/25-050 Guardrail Topo.jxl');
    const saved = await read<UploadRecord>('25-050 Guardrail Topo/2026-10-28T213627Z/upload.json');
    expect(saved.media.map((m) => m.name)).toEqual(['IMG_0001.jpg']);
    // Pretty-printed, for people reading the bucket.
    expect(await text('index.json')).toContain('\n  "jobs": [\n');
    const index = await read<JobIndex>('index.json');
    expect(index.jobs).toHaveLength(1);
    expect(index.jobs[0]).toMatchObject<Partial<IndexEntry>>({ job: '25-050 Guardrail Topo', uploads: 1, latest: '2026-10-28T213627Z', center: [-122, 38], lastUploadedBy: EMAIL });
  });

  it('skips an upload that changes nothing', async () => {
    const files: F[] = [
      { name: 'A.jxl', body: 'v1', kind: 'job' },
      { name: 'p.jpg', body: 'photo', kind: 'media' },
    ];
    await send('A', files);
    const again = await send('A', files, later(5));
    expect(again.plan).toEqual({ status: 'unchanged', folder: 'A', placed: false });
    expect((await read<VersionList>('A/versions.json')).versions).toHaveLength(1);
  });

  it('keeps every upload of a job in its own time folder, newest first', async () => {
    await send('A', [{ name: 'A.jxl', body: 'v1', kind: 'job' }]);
    await send('A', [{ name: 'A.jxl', body: 'v2', kind: 'job' }], later(90));
    const v = await read<VersionList>('A/versions.json');
    expect(v.versions.map((x) => x.stamp)).toEqual(['2026-10-28T230627Z', '2026-10-28T213627Z']);
    expect(await text('A/2026-10-28T213627Z/A.jxl')).toBe('v1');
    expect(await text('A/2026-10-28T230627Z/A.jxl')).toBe('v2');
    expect((await read<JobIndex>('index.json')).jobs[0]).toMatchObject({ uploads: 2, latest: '2026-10-28T230627Z' });
  });

  it('never overwrites a photo: a changed one is kept beside it, an unchanged one is reused', async () => {
    await send('A', [
      { name: 'A.jxl', body: 'v1', kind: 'job' },
      { name: 'IMG_1.jpg', body: 'first', kind: 'media' },
    ]);
    const { plan: p, record } = await send(
      'A',
      [
        { name: 'A.jxl', body: 'v2', kind: 'job' },
        { name: 'IMG_1.jpg', body: 'retaken', kind: 'media' },
        { name: 'IMG_2.jpg', body: 'new', kind: 'media' },
      ],
      later(10),
    );
    expect(await text('A/media/IMG_1.jpg')).toBe('first');
    expect(await text('A/media/IMG_1 (2026-10-28T214627Z).jpg')).toBe('retaken');
    expect(record!.media.map((m) => m.name)).toEqual(['IMG_1 (2026-10-28T214627Z).jpg', 'IMG_2.jpg']);
    const third = await send(
      'A',
      [
        { name: 'A.jxl', body: 'v3', kind: 'job' },
        { name: 'IMG_1.jpg', body: 'retaken', kind: 'media' },
      ],
      later(20),
    );
    const planned = (third.plan as Extract<Plan, { status: 'upload' }>).files.find((f) => f.kind === 'media')!;
    expect(planned).toMatchObject({ key: 'A/media/IMG_1 (2026-10-28T214627Z).jpg', needed: false });
    expect(p.status).toBe('upload');
  });

  it('gives two uploads in the same second different folders', async () => {
    await send('A', [{ name: 'A.jxl', body: 'v1', kind: 'job' }]);
    const { plan: p } = await send('A', [{ name: 'A.jxl', body: 'v2', kind: 'job' }]);
    expect((p as Extract<Plan, { status: 'upload' }>).stamp).toBe('2026-10-28T213628Z');
  });

  it('only accepts files into an open upload or a media folder, and never replaces bytes', async () => {
    const body = () => new TextEncoder().encode('x').buffer as ArrayBuffer;
    const put = (key: string, s = sha('x'), at = T0.getTime()) => putFile(bucket, key, body(), s, undefined, EMAIL, at);
    await expect(put('A/../index.json')).rejects.toThrow(StoreError);
    await expect(put('index.json')).rejects.toThrow(StoreError);
    await expect(put('A/2026-10-28T213627Z/upload.json')).rejects.toThrow('written by the server');
    await expect(put('A/versions.json/x')).rejects.toThrow(StoreError);
    await expect(put('A/2026-10-28T213627Z/A.jxl', sha('x'), later(7 * 60).getTime())).rejects.toThrow('closed');
    await put('A/media/x.jpg');
    await put('A/media/x.jpg'); // the same bytes again is fine
    await expect(putFile(bucket, 'A/media/x.jpg', new TextEncoder().encode('y').buffer as ArrayBuffer, sha('y'), undefined, EMAIL)).rejects.toThrow('different file');
    await expect(put('A/media/y.jpg', sha('not x'))).rejects.toThrow('damaged');
  });

  it("won't finish an upload whose files haven't all arrived", async () => {
    const p = (await plan(bucket, { job: 'A', files: [{ name: 'A.jxl', size: 2, sha256: sha('v1'), kind: 'job' }] }, T0)) as Extract<Plan, { status: 'upload' }>;
    await expect(commit(bucket, { job: 'A', stamp: p.stamp, files: p.files }, EMAIL, T0)).rejects.toThrow("hasn't been sent");
    expect(await bucket.get('index.json')).toBeNull();
  });

  it('saves where a job in assumed coordinates was placed, without a new upload', async () => {
    const files: F[] = [{ name: 'A.jxl', body: 'v1', kind: 'job' }];
    await send('A', files);
    const placement = { north: 3048, east: 3048, lat: 37.9, lon: -122.06, rotation: 12.5, updated: later(1).toISOString() };
    const p = await plan(bucket, { job: 'A', files: files.map((f) => ({ name: f.name, size: 2, sha256: sha(f.body), kind: f.kind })), placement }, later(2));
    expect(p).toEqual({ status: 'unchanged', folder: 'A', placed: true });
    expect(await read('A/placement.json')).toEqual(placement);
    expect((await read<JobIndex>('index.json')).jobs[0].placement).toEqual(placement);
  });

  it('rebuilds index.json and versions.json from the upload folders', async () => {
    await send('A', [{ name: 'A.jxl', body: 'v1', kind: 'job' }]);
    await send('A', [{ name: 'A.jxl', body: 'v2', kind: 'job' }], later(30));
    await send('B job', [{ name: 'B.rw5', body: 'rw5', kind: 'job' }], later(40));
    // An upload that stopped part way.
    await bucket.put('B job/2026-10-29T000000Z/B.rw5', 'half');
    const before = await read<JobIndex>('index.json');
    const versions = await read<VersionList>('A/versions.json');
    await bucket.delete(['index.json', 'A/versions.json', 'B job/versions.json']);
    const rebuilt = await rebuild(bucket);
    expect(rebuilt.jobs).toEqual(before.jobs);
    expect(await read<VersionList>('A/versions.json')).toEqual(versions);
  });
});
