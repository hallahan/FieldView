// Jobs saved to a GitHub repo.
//
// Layout of a data repo:
//   index.geojson                       one Point per job at its centroid
//   jobs/<jobName>/<jobName>.jxl        the latest upload (.rw5 for Carlson raw files);
//                                       git history holds the rest
//
// Uploading the same job again overwrites its file, so every field visit is a
// commit and GitHub's history and compare views show what changed.

import type { Feature, FeatureCollection, Point } from 'geojson';
import { gitBlobSha, type GitHub } from './github';
import type { JxlDocument } from './jxl';

export const INDEX_PATH = 'index.geojson';

export interface JobProps {
  jobName: string;
  path: string;
  /** Git blob id of the latest upload, to skip uploads that changed nothing. */
  blobSha: string;
  size: number;
  pointCount: number;
  /** Bounding box of the measured points: [west, south, east, north]. */
  bbox?: [number, number, number, number];
  firstUpload: string;
  lastUpload: string;
  uploadCount: number;
  controller?: string;
  product?: string;
  /** When the job file was last written on the controller. */
  jobTimeStamp?: string;
  crs?: string;
}

export type JobFeature = Feature<Point | null, JobProps>;

export interface JobIndex extends FeatureCollection<Point | null, JobProps> {
  fieldview: { version: 1 };
}

export function emptyIndex(): JobIndex {
  return { type: 'FeatureCollection', fieldview: { version: 1 }, features: [] };
}

export function parseIndex(text: string | undefined): JobIndex {
  if (!text) return emptyIndex();
  const parsed = JSON.parse(text) as JobIndex;
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error(`${INDEX_PATH} isn't an OpenFieldView job index`);
  return parsed;
}

export async function loadIndex(gh: GitHub): Promise<JobIndex> {
  return parseIndex(await gh.readText(INDEX_PATH));
}

export function jobName(doc: JxlDocument, fileName: string): string {
  return doc.job.jobName?.trim() || fileName.replace(/\.(jxl|rw5)$/i, '');
}

/** A job name as a single safe path segment. */
export function jobSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'job';
}

export function jobPath(name: string, format: JxlDocument['format'] = 'jxl'): string {
  const slug = jobSlug(name);
  return `jobs/${slug}/${slug}.${format ?? 'jxl'}`;
}

/** Mean position and extent of what was measured, leaving out deleted points and far-off keyed-in control. */
export function footprint(doc: JxlDocument): { center: [number, number]; bbox: [number, number, number, number] } | undefined {
  const located = doc.points.filter((p) => p.coords.lat !== undefined && p.coords.lon !== undefined && !p.deleted);
  const measured = located.filter((p) => p.type !== 'Keyed in');
  const pts = measured.length ? measured : located;
  if (!pts.length) return undefined;
  let lon = 0;
  let lat = 0;
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const x = p.coords.lon!;
    const y = p.coords.lat!;
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

/** Add or update a job's entry, keeping the index sorted by name so diffs stay small. */
export function upsertJob(index: JobIndex, doc: JxlDocument, name: string, blobSha: string, size: number, now: string): JobIndex {
  const path = jobPath(name, doc.format);
  const prev = index.features.find((f) => f.properties.path === path);
  const fp = footprint(doc);
  const feature: JobFeature = {
    type: 'Feature',
    id: jobSlug(name),
    geometry: fp ? { type: 'Point', coordinates: fp.center } : null,
    properties: {
      jobName: name,
      path,
      blobSha,
      size,
      pointCount: doc.points.filter((p) => !p.deleted).length,
      ...(fp && { bbox: fp.bbox }),
      firstUpload: prev?.properties.firstUpload ?? now,
      lastUpload: now,
      uploadCount: (prev?.properties.uploadCount ?? 0) + 1,
      ...(doc.job.controllerSerialNumber && { controller: doc.job.controllerSerialNumber }),
      ...(doc.job.product && { product: [doc.job.product, doc.job.productVersion].filter(Boolean).join(' ') }),
      ...(doc.job.TimeStamp && { jobTimeStamp: doc.job.TimeStamp }),
      ...(doc.crs.projection?.label && { crs: doc.crs.projection.label }),
    },
  };
  const features = index.features.filter((f) => f.properties.path !== path).concat(feature);
  features.sort((a, b) => a.properties.path.localeCompare(b.properties.path));
  return { ...index, features };
}

export function serializeIndex(index: JobIndex): string {
  return JSON.stringify(index, null, 2) + '\n';
}

export type SaveResult = { status: 'saved'; path: string; commit: string } | { status: 'unchanged'; path: string };

/** Commit a JXL and the updated index together. */
export async function saveJob(gh: GitHub, text: string, doc: JxlDocument, fileName: string, now = new Date().toISOString()): Promise<SaveResult> {
  const info = await gh.info();
  const name = jobName(doc, fileName);
  const path = jobPath(name, doc.format);
  if (info.empty) await gh.initialize(INDEX_PATH, serializeIndex(emptyIndex()), 'Start OpenFieldView job index');
  const blobSha = await gitBlobSha(text);
  const size = new TextEncoder().encode(text).length;
  const commit = await gh.commitFiles(info.defaultBranch, async (read) => {
    const index = parseIndex(await read(INDEX_PATH));
    const prev = index.features.find((f) => f.properties.path === path);
    if (prev?.properties.blobSha === blobSha) return undefined;
    const next = upsertJob(index, doc, name, blobSha, size, now);
    const n = next.features.find((f) => f.properties.path === path)!.properties.pointCount;
    const verb = prev ? 'Update' : 'Add';
    return {
      message: `${verb} ${name} (${n} points)${doc.job.controllerSerialNumber ? `\n\nController ${doc.job.controllerSerialNumber}` : ''}`,
      files: [
        { path, content: text },
        { path: INDEX_PATH, content: serializeIndex(next) },
      ],
    };
  });
  return commit ? { status: 'saved', path, commit } : { status: 'unchanged', path };
}
