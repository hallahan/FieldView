// Uploads into the R2 bucket, laid out as described in src/layout.ts.
//
// An upload takes three steps so each file goes up in its own request (a
// Worker request is capped at 100 MB) and nothing shows in the Jobs list
// until everything has arrived:
//   1. plan:   the app lists the files with their SHA-256; this answers which
//              need sending and where they go, or that nothing changed.
//   2. put:    each needed file, written only if its key is still free.
//   3. commit: writes upload.json, then versions.json and index.json.
// An upload that stops part way leaves a folder with no upload.json, which
// the Jobs list ignores.

import {
  INDEX_KEY,
  MEDIA_DIR,
  PLACEMENT_FILE,
  UPLOAD_FILE,
  VERSIONS_FILE,
  isStamp,
  jobFolder,
  keptAlongsideName,
  safeFileName,
  stamp as makeStamp,
  stampTime,
  type IndexEntry,
  type JobIndex,
  type JobSummary,
  type StoredFile,
  type StoredPlacement,
  type UploadRecord,
  type VersionList,
} from '../src/layout';

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Kind = 'job' | 'media';

export interface PlanFile {
  name: string;
  size: number;
  sha256: string;
  kind: Kind;
}

export interface PlanRequest {
  job: string;
  files: PlanFile[];
  placement?: StoredPlacement;
}

export interface PlannedFile extends StoredFile {
  kind: Kind;
  /** False when the bucket already has these exact bytes at `key`. */
  needed: boolean;
}

export type Plan =
  | { status: 'unchanged'; folder: string; placed: boolean }
  | { status: 'upload'; folder: string; stamp: string; files: PlannedFile[] };

export interface CommitRequest {
  job: string;
  stamp: string;
  note?: string;
  files: (StoredFile & { kind: Kind })[];
  main?: string;
  summary?: JobSummary;
  placement?: StoredPlacement;
}

/** How long after planning an upload its files may still be sent. */
const OPEN_FOR_MS = 6 * 3600_000;
const SHA = /^[0-9a-f]{64}$/;

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const JSON_META = { contentType: 'application/json; charset=utf-8' };

export async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | undefined> {
  const obj = await bucket.get(key);
  return obj ? ((await obj.json()) as T) : undefined;
}

/** Read-modify-write a JSON file, retrying when someone else wrote it in between. */
export async function updateJson<T>(bucket: R2Bucket, key: string, change: (current: T | undefined) => T): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const obj = await bucket.get(key);
    const current = obj ? ((await obj.json()) as T) : undefined;
    const next = change(current);
    const onlyIf = obj ? { etagMatches: obj.etag } : new Headers({ 'If-None-Match': '*' });
    const written = await bucket.put(key, json(next), { onlyIf, httpMetadata: JSON_META });
    if (written) return next;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 200 * (attempt + 1)));
  }
  throw new StoreError(`${key} is busy, try again`, 503);
}

function checkFiles(files: unknown): PlanFile[] {
  if (!Array.isArray(files) || !files.length) throw new StoreError('No files to upload');
  if (files.length > 500) throw new StoreError('Too many files in one upload (500 at most)');
  return files.map((f) => {
    if (typeof f?.name !== 'string' || !f.name || typeof f.size !== 'number' || f.size < 0 || typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) {
      throw new StoreError('Each file needs a name, size and sha256');
    }
    if (f.kind !== 'job' && f.kind !== 'media') throw new StoreError('Each file is a job file or media');
    return { name: safeFileName(f.name), size: f.size, sha256: f.sha256, kind: f.kind };
  });
}

/** Every stored media file of a job by its SHA-256, and the names in use. */
async function mediaInBucket(bucket: R2Bucket, folder: string) {
  const bySha = new Map<string, StoredFile>();
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${folder}/${MEDIA_DIR}/`, cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const name = o.key.slice(folder.length + MEDIA_DIR.length + 2);
      names.add(name);
      const sha = o.customMetadata?.sha256;
      if (sha && !bySha.has(sha)) bySha.set(sha, { name, key: o.key, size: o.size, sha256: sha });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { bySha, names };
}

export async function plan(bucket: R2Bucket, input: PlanRequest, now = new Date()): Promise<Plan> {
  if (typeof input?.job !== 'string' || !input.job.trim()) throw new StoreError('Missing job name');
  const folder = jobFolder(input.job);
  const files = checkFiles(input.files);
  const names = new Set<string>();
  for (const f of files) {
    const k = `${f.kind}:${f.name.toLowerCase()}`;
    if (names.has(k)) throw new StoreError(`${f.name} is in the upload twice`);
    names.add(k);
  }

  const versions = await readJson<VersionList>(bucket, `${folder}/${VERSIONS_FILE}`);
  const media = await mediaInBucket(bucket, folder);
  let at = makeStamp(now);
  // Two uploads of a job in the same second get the next free second.
  while ((versions?.versions ?? []).some((v) => v.stamp === at) || (await bucket.head(`${folder}/${at}/${UPLOAD_FILE}`))) {
    at = makeStamp(new Date(Date.parse(stampTime(at)) + 1000));
  }

  const taken = new Set(media.names);
  const planned: PlannedFile[] = files.map((f) => {
    if (f.kind === 'job') return { ...f, key: `${folder}/${at}/${f.name}`, needed: true };
    const same = media.bySha.get(f.sha256);
    if (same) return { ...f, name: same.name, key: same.key, needed: false };
    const name = taken.has(f.name) ? keptAlongsideName(f.name, at) : f.name;
    taken.add(name);
    return { ...f, name, key: `${folder}/${MEDIA_DIR}/${name}`, needed: true };
  });

  const latest = versions?.versions[0];
  const sig = (list: { name: string; sha256: string }[]) =>
    list
      .map((f) => `${f.name}\n${f.sha256}`)
      .sort()
      .join('\n');
  const jobFiles = planned.filter((f) => f.kind === 'job');
  const unchanged = !!latest && sig(latest.files) === sig(jobFiles) && planned.every((f) => f.kind === 'job' || !f.needed);
  if (unchanged) {
    const placed = input.placement ? await setPlacement(bucket, folder, input.placement) : false;
    if (placed) await updateIndexEntry(bucket, folder, versions!);
    return { status: 'unchanged', folder, placed };
  }
  return { status: 'upload', folder, stamp: at, files: planned };
}

/** Where a key may be written by an upload: its stamp folder, or the job's media folder. */
function writable(key: string, now: number): { folder: string; stamp?: string; name: string } {
  const parts = key.split('/');
  if (parts.length !== 3 || parts.some((p) => !p || p === '.' || p === '..')) throw new StoreError('Not an upload path', 403);
  const [folder, middle, name] = parts;
  if (folder !== jobFolder(folder) || name !== safeFileName(name)) throw new StoreError('Not an upload path', 403);
  if (middle === MEDIA_DIR) return { folder, name };
  if (!isStamp(middle)) throw new StoreError('Not an upload path', 403);
  if (name === UPLOAD_FILE) throw new StoreError('upload.json is written by the server', 403);
  const age = now - Date.parse(stampTime(middle));
  if (age > OPEN_FOR_MS || age < -60_000) throw new StoreError('That upload has closed. Start the upload again.', 409);
  return { folder, stamp: middle, name };
}

/** Store one file of an upload. Never overwrites: sending the same bytes again is fine, different bytes are refused. */
export async function putFile(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | ArrayBuffer,
  sha256: string,
  contentType: string | undefined,
  email: string,
  now = Date.now(),
): Promise<StoredFile> {
  if (!SHA.test(sha256)) throw new StoreError('Missing or bad X-Content-SHA256');
  const where = writable(key, now);
  if (where.stamp && (await bucket.head(`${where.folder}/${where.stamp}/${UPLOAD_FILE}`))) {
    throw new StoreError('That upload is already finished', 409);
  }
  const existing = await bucket.head(key);
  if (!existing) {
    try {
      const written = await bucket.put(key, body, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        sha256,
        httpMetadata: { contentType: contentType || 'application/octet-stream' },
        customMetadata: { sha256, uploadedBy: email },
      });
      if (written) return { name: where.name, key, size: written.size, sha256 };
    } catch (e) {
      if (/sha-?256|checksum|digest/i.test(String(e))) throw new StoreError(`${where.name} was damaged on the way up. Try again.`, 422);
      throw e;
    }
  }
  const now2 = existing ?? (await bucket.head(key));
  if (now2?.customMetadata?.sha256 === sha256) return { name: where.name, key, size: now2.size, sha256 };
  throw new StoreError(`${key} already holds a different file`, 409);
}

export async function commit(bucket: R2Bucket, input: CommitRequest, email: string, now = new Date()): Promise<UploadRecord> {
  if (typeof input?.job !== 'string' || !input.job.trim()) throw new StoreError('Missing job name');
  const folder = jobFolder(input.job);
  if (typeof input.stamp !== 'string' || !isStamp(input.stamp)) throw new StoreError('Missing upload stamp');
  const at = input.stamp;
  if (!Array.isArray(input.files) || !input.files.length) throw new StoreError('No files');
  const files: StoredFile[] = [];
  const media: StoredFile[] = [];
  for (const f of input.files) {
    const prefix = f?.kind === 'media' ? `${folder}/${MEDIA_DIR}/` : `${folder}/${at}/`;
    if (typeof f?.key !== 'string' || !f.key.startsWith(prefix) || f.key.slice(prefix.length).includes('/')) {
      throw new StoreError(`${f?.key} isn't part of this upload`);
    }
    const head = await bucket.head(f.key);
    if (!head) throw new StoreError(`${f.key} hasn't been sent yet`, 409);
    const sha = head.customMetadata?.sha256 ?? '';
    if (sha !== f.sha256) throw new StoreError(`${f.key} doesn't match what was sent`, 409);
    (f.kind === 'media' ? media : files).push({ name: f.key.slice(prefix.length), key: f.key, size: head.size, sha256: sha });
  }
  if (!files.length) throw new StoreError('An upload needs a job file');
  const main = files.find((f) => f.key === input.main)?.key ?? files.find((f) => /\.(jxl|rw5)$/i.test(f.name))?.key;
  const record: UploadRecord = {
    app: 'OpenFieldView',
    job: input.job.trim(),
    folder,
    stamp: at,
    uploadedAt: now.toISOString(),
    uploadedBy: email,
    ...(typeof input.note === 'string' && input.note.trim() && { note: input.note.trim().slice(0, 2000) }),
    files,
    media,
    ...(main && { main }),
    summary: cleanSummary(input.summary),
  };
  const written = await bucket.put(`${folder}/${at}/${UPLOAD_FILE}`, json(record), {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    httpMetadata: JSON_META,
  });
  if (!written) throw new StoreError('That upload is already finished', 409);

  const versions = await updateJson<VersionList>(bucket, `${folder}/${VERSIONS_FILE}`, (cur) => addVersion(cur, record));
  if (input.placement) await setPlacement(bucket, folder, input.placement);
  await updateIndexEntry(bucket, folder, versions);
  return record;
}

function cleanSummary(s: JobSummary | undefined): JobSummary {
  if (!s || typeof s !== 'object') return {};
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
  const out: JobSummary = {};
  if (num(s.pointCount)) out.pointCount = s.pointCount;
  if (Array.isArray(s.center) && s.center.length === 2 && s.center.every(num)) out.center = s.center;
  if (Array.isArray(s.bbox) && s.bbox.length === 4 && s.bbox.every(num)) out.bbox = s.bbox;
  if (s.format === 'jxl' || s.format === 'rw5') out.format = s.format;
  for (const k of ['controller', 'product', 'crs', 'jobTimeStamp'] as const) {
    const v = str(s[k]);
    if (v) out[k] = v;
  }
  return out;
}

function toVersion(r: UploadRecord): VersionList['versions'][number] {
  const { app: _app, job: _job, folder: _folder, ...v } = r;
  return v;
}

export function addVersion(cur: VersionList | undefined, r: UploadRecord): VersionList {
  const versions = (cur?.versions ?? []).filter((v) => v.stamp !== r.stamp).concat(toVersion(r));
  versions.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return { job: r.job, folder: r.folder, versions };
}

async function setPlacement(bucket: R2Bucket, folder: string, p: StoredPlacement): Promise<boolean> {
  const ok = ['north', 'east', 'lat', 'lon', 'rotation'].every((k) => Number.isFinite((p as unknown as Record<string, number>)[k])) && typeof p.updated === 'string';
  if (!ok) return false;
  let changed = false;
  await updateJson<StoredPlacement>(bucket, `${folder}/${PLACEMENT_FILE}`, (cur) => {
    const same = cur && cur.north === p.north && cur.east === p.east && cur.lat === p.lat && cur.lon === p.lon && cur.rotation === p.rotation;
    changed = !same && (!cur || p.updated >= cur.updated);
    return changed || !cur ? { north: p.north, east: p.east, lat: p.lat, lon: p.lon, rotation: p.rotation, updated: p.updated } : cur;
  });
  return changed;
}

export function indexEntry(versions: VersionList, placement?: StoredPlacement): IndexEntry {
  const [latest] = versions.versions;
  const oldest = versions.versions[versions.versions.length - 1];
  return {
    job: versions.job,
    folder: versions.folder,
    ...latest.summary,
    firstUpload: oldest.uploadedAt,
    lastUpload: latest.uploadedAt,
    lastUploadedBy: latest.uploadedBy,
    uploads: versions.versions.length,
    latest: latest.stamp,
    ...(latest.main && { main: latest.main }),
    ...(placement && { placement }),
  };
}

function withEntry(cur: JobIndex | undefined, entry: IndexEntry, now: string): JobIndex {
  const jobs = (cur?.jobs ?? []).filter((j) => j.folder !== entry.folder).concat(entry);
  jobs.sort((a, b) => a.folder.localeCompare(b.folder));
  return { app: 'OpenFieldView', updated: now, jobs };
}

async function updateIndexEntry(bucket: R2Bucket, folder: string, versions: VersionList) {
  const placement = await readJson<StoredPlacement>(bucket, `${folder}/${PLACEMENT_FILE}`);
  const entry = indexEntry(versions, placement);
  await updateJson<JobIndex>(bucket, INDEX_KEY, (cur) => withEntry(cur, entry, new Date().toISOString()));
}

async function listPrefixes(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: '/', cursor });
    out.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Rebuild every versions.json and index.json from the upload.json files, for when they're lost or edited by hand. */
export async function rebuild(bucket: R2Bucket, now = new Date()): Promise<JobIndex> {
  const jobs: IndexEntry[] = [];
  for (const jobPrefix of await listPrefixes(bucket, '')) {
    const folder = jobPrefix.slice(0, -1);
    let list: VersionList | undefined;
    for (const p of await listPrefixes(bucket, jobPrefix)) {
      const s = p.slice(jobPrefix.length, -1);
      if (!isStamp(s)) continue;
      const r = await readJson<UploadRecord>(bucket, `${p}${UPLOAD_FILE}`);
      if (r) list = addVersion(list, { ...r, folder });
    }
    if (!list) continue;
    await bucket.put(`${folder}/${VERSIONS_FILE}`, json(list), { httpMetadata: JSON_META });
    jobs.push(indexEntry(list, await readJson<StoredPlacement>(bucket, `${folder}/${PLACEMENT_FILE}`)));
  }
  jobs.sort((a, b) => a.folder.localeCompare(b.folder));
  const index: JobIndex = { app: 'OpenFieldView', updated: now.toISOString(), jobs };
  await bucket.put(INDEX_KEY, json(index), { httpMetadata: JSON_META });
  return index;
}
