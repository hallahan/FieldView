// Getting an upload ready and sending it: the job file, an optional Trimble
// .job, and any photos or attachments, which can come as separate files or
// inside a .zip (Android Chrome can't pick a whole folder).

import { unzip } from 'fflate';
import { post, putFile } from './api';
import type { JxlDocument } from './jxl';
import { isJobFile, safeFileName, type JobSummary, type StoredPlacement, type UploadRecord } from './layout';
import { placeGrid } from './placement';

export type Kind = 'job' | 'media';

export interface UploadItem {
  name: string;
  blob: Blob;
  kind: Kind;
}

export function jobName(doc: JxlDocument | undefined, fileName: string): string {
  return doc?.job.jobName?.trim() || fileName.replace(/\.[^.]+$/, '');
}

/** Mean position and extent of what was measured, leaving out deleted points and far-off keyed-in control. */
export function footprint(doc: JxlDocument): { center: [number, number]; bbox: [number, number, number, number] } | undefined {
  // A job shown in its own assumed coordinates is on the earth only where it was placed, if anywhere.
  const where = (p: JxlDocument['points'][number]): [number, number] | undefined => {
    const c = p.coords;
    if (c.source === 'Local') return doc.placement && placeGrid(doc.placement, c.north!, c.east!);
    return c.lat !== undefined && c.lon !== undefined ? [c.lat, c.lon] : undefined;
  };
  const located = doc.points.filter((p) => where(p) && !p.deleted);
  const measured = located.filter((p) => p.type !== 'Keyed in');
  const pts = measured.length ? measured : located;
  if (!pts.length) return undefined;
  let lon = 0;
  let lat = 0;
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const [y, x] = where(p)!;
    lon += x;
    lat += y;
    bbox[0] = Math.min(bbox[0], x);
    bbox[1] = Math.min(bbox[1], y);
    bbox[2] = Math.max(bbox[2], x);
    bbox[3] = Math.max(bbox[3], y);
  }
  const round = (n: number) => Math.round(n * 1e7) / 1e7;
  return { center: [round(lon / pts.length), round(lat / pts.length)], bbox: bbox.map(round) as typeof bbox };
}

export function summarize(doc: JxlDocument | undefined): JobSummary {
  if (!doc) return {};
  const fp = footprint(doc);
  return {
    pointCount: doc.points.filter((p) => !p.deleted).length,
    ...(fp && { center: fp.center, bbox: fp.bbox }),
    format: doc.format ?? 'jxl',
    ...(doc.job.controllerSerialNumber && { controller: doc.job.controllerSerialNumber }),
    ...(doc.job.product && { product: [doc.job.product, doc.job.productVersion].filter(Boolean).join(' ') }),
    ...(doc.crs.projection?.label && { crs: doc.crs.projection.label }),
    ...(doc.job.TimeStamp && { jobTimeStamp: doc.job.TimeStamp }),
  };
}

const MEDIA = /[^\s<>"'\\/|]+\.(jpe?g|png|heic|heif|gif|bmp|tiff?|webp|mp4|mov|3gp|m4a|wav|mp3|amr|pdf)\b/gi;

/**
 * Photo and attachment file names a job mentions, in the order they appear.
 * Trimble Access and Carlson both store just the file name in the record, so
 * this looks for anything that reads like one.
 */
export function referencedMedia(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(MEDIA)) {
    const name = m[0];
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/** Files a folder or zip of a job carries that aren't the job's: macOS and Windows extras. */
export const isClutter = (path: string) => {
  const name = path.split('/').pop()!;
  return !name || path.startsWith('__MACOSX/') || name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini';
};

/** Files picked or dropped, with any .zip opened up. Folders and macOS extras inside a zip are skipped. */
export async function expandZips(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (!/\.zip$/i.test(f.name)) {
      out.push(f);
      continue;
    }
    const entries = await new Promise<Record<string, Uint8Array>>(async (resolve, reject) =>
      unzip(new Uint8Array(await f.arrayBuffer()), (err, data) => (err ? reject(new Error(`Couldn't open ${f.name}: ${err.message}`)) : resolve(data))),
    );
    for (const [path, bytes] of Object.entries(entries)) {
      const name = path.split('/').pop()!;
      if (path.endsWith('/') || isClutter(path)) continue;
      out.push(new File([bytes as Uint8Array<ArrayBuffer>], name, { lastModified: f.lastModified }));
    }
  }
  return out;
}

/** Job file or media, by extension. */
export const kindOf = (name: string): Kind => (isJobFile(name) ? 'job' : 'media');

/** Add files to an upload, replacing any earlier one with the same name. */
export function addItems(items: UploadItem[], files: File[]): UploadItem[] {
  const next = [...items];
  for (const f of files) {
    if (isClutter(f.name)) continue;
    const name = safeFileName(f.name);
    const kind = kindOf(name);
    const i = next.findIndex((x) => x.kind === kind && x.name.toLowerCase() === name.toLowerCase());
    const item = { name, blob: f, kind };
    if (i >= 0) next[i] = item;
    else next.push(item);
  }
  return next;
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Plan =
  | { status: 'unchanged'; folder: string; placed: boolean }
  | { status: 'upload'; folder: string; stamp: string; files: { name: string; key: string; size: number; sha256: string; kind: Kind; needed: boolean }[] };

export type UploadResult =
  | { status: 'unchanged' | 'placed'; folder: string }
  | { status: 'uploaded'; folder: string; record: UploadRecord; sent: number; reused: number };

export interface UploadRequest {
  job: string;
  items: UploadItem[];
  /** Name of the item the app opens (the .jxl or .rw5). */
  main?: string;
  note?: string;
  summary: JobSummary;
  placement?: StoredPlacement;
}

/** Send an upload. Files the bucket already has are skipped; `progress` reports bytes sent of bytes to send. */
export async function upload(req: UploadRequest, progress: (sent: number, total: number, name: string) => void = () => {}): Promise<UploadResult> {
  const hashed = await Promise.all(req.items.map(async (it) => ({ ...it, size: it.blob.size, sha256: await sha256(it.blob) })));
  const plan = await post<Plan>('uploads', {
    job: req.job,
    files: hashed.map(({ name, size, sha256, kind }) => ({ name, size, sha256, kind })),
    placement: req.placement,
  });
  if (plan.status === 'unchanged') return { status: plan.placed ? 'placed' : 'unchanged', folder: plan.folder };

  const byName = (kind: Kind, name: string) => hashed.find((h) => h.kind === kind && safeFileName(h.name) === name);
  const todo = plan.files.filter((f) => f.needed);
  const total = todo.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  for (const f of todo) {
    // A changed photo comes back under a new name; match it by content.
    const item = (f.kind === 'media' ? hashed.find((h) => h.kind === 'media' && h.sha256 === f.sha256) : undefined) ?? byName(f.kind, f.name);
    if (!item) throw new Error(`Lost track of ${f.name}`);
    progress(sent, total, f.name);
    await putFile(f.key, item.blob, f.sha256);
    sent += f.size;
  }
  progress(total, total, '');
  const main = req.main && plan.files.find((f) => f.kind === 'job' && f.name === safeFileName(req.main!))?.key;
  const record = await post<UploadRecord>('uploads/commit', {
    job: req.job,
    stamp: plan.stamp,
    note: req.note,
    files: plan.files.map(({ name, key, size, sha256, kind }) => ({ name, key, size, sha256, kind })),
    main,
    summary: req.summary,
    placement: req.placement,
  });
  return { status: 'uploaded', folder: plan.folder, record, sent: todo.length, reused: plan.files.length - todo.length };
}
