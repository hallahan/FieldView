// How jobs are laid out in the R2 bucket. Shared by the app and the Worker,
// so it has no DOM or Workers-only code in it.
//
//   index.json                                  every job: name, centroid, latest upload
//   <Job>/versions.json                         every upload of that job, newest first
//   <Job>/placement.json                        where a job in assumed coordinates was placed by hand
//   <Job>/2026-10-28T213627Z/<files>            one upload: the job file(s) as sent
//   <Job>/2026-10-28T213627Z/upload.json        who uploaded it, when, and what it holds
//   <Job>/media/<photo>                         photos and attachments, shared by every upload
//
// An upload folder is never changed once its upload.json is written, and a
// media file is never overwritten: a changed photo with the same name is kept
// beside it with the upload time in its name. index.json and versions.json
// can always be rebuilt from the upload.json files.


export const INDEX_KEY = 'index.json';
export const UPLOAD_FILE = 'upload.json';
export const VERSIONS_FILE = 'versions.json';
export const PLACEMENT_FILE = 'placement.json';
export const MEDIA_DIR = 'media';

/** Same shape as Placement in placement.ts, repeated so the Worker needn't compile the parsers. */
export interface StoredPlacement {
  north: number;
  east: number;
  lat: number;
  lon: number;
  rotation: number;
  updated: string;
}

/** What the parsed job says about itself, kept so the Jobs list doesn't need to open every file. */
export interface JobSummary {
  pointCount?: number;
  /** Centroid of the measured points, [lon, lat]. */
  center?: [number, number];
  /** [west, south, east, north] */
  bbox?: [number, number, number, number];
  format?: 'jxl' | 'rw5';
  controller?: string;
  product?: string;
  crs?: string;
  /** When the job file was last written on the controller. */
  jobTimeStamp?: string;
}

export interface StoredFile {
  name: string;
  /** Full key in the bucket. */
  key: string;
  size: number;
  /** Hex SHA-256 of the bytes. */
  sha256: string;
}

/** <Job>/<stamp>/upload.json */
export interface UploadRecord {
  app: 'OpenFieldView';
  job: string;
  folder: string;
  stamp: string;
  uploadedAt: string;
  /** Email from the Cloudflare Access sign-in. */
  uploadedBy: string;
  note?: string;
  /** The job files: the .jxl or .rw5, and the Trimble .job if it was sent too. */
  files: StoredFile[];
  /** Photos and attachments sent with this upload, in <Job>/media/. */
  media: StoredFile[];
  /** Which of `files` the app opens. */
  main?: string;
  summary: JobSummary;
}

/** <Job>/versions.json */
export interface VersionList {
  job: string;
  folder: string;
  versions: Omit<UploadRecord, 'app' | 'job' | 'folder'>[];
}

export interface IndexEntry extends JobSummary {
  job: string;
  folder: string;
  firstUpload: string;
  lastUpload: string;
  lastUploadedBy: string;
  uploads: number;
  /** Stamp of the newest upload folder. */
  latest: string;
  /** Key of the file to open from the newest upload. */
  main?: string;
  placement?: StoredPlacement;
}

/** index.json */
export interface JobIndex {
  app: 'OpenFieldView';
  updated: string;
  jobs: IndexEntry[];
}

/**
 * A job name as a folder name people can still read: spaces, dashes, dots,
 * brackets and underscores stay, anything that would make a path or confuse a
 * file manager becomes an underscore.
 */
export function jobFolder(name: string): string {
  const s = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()\-+,=@&#]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 120)
    .trim();
  return s || 'job';
}

/** A file name as a single key segment, keeping its extension. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const s = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()\-+,=@&#~]+/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(-160);
  return s || 'file';
}

/** UTC time as 2026-10-28T213627Z: sorts as text and is safe in every file system. */
export function stamp(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
}

export const isStamp = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(s);

/** The ISO time a stamp stands for. */
export function stampTime(s: string): string {
  return `${s.slice(0, 13)}:${s.slice(13, 15)}:${s.slice(15, 17)}Z`;
}

/** Name for a changed photo that would otherwise overwrite one already stored: IMG_0001 (2026-10-28T213627Z).jpg */
export function keptAlongsideName(name: string, at: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${at})${name.slice(dot)}` : `${name} (${at})`;
}

/** Job files the app can show; everything else uploaded alongside is stored as is. */
export const isViewable = (name: string) => /\.(jxl|rw5)$/i.test(name);

/** A Trimble Access .job is a binary database: stored with the upload, not opened here. */
export const isJobFile = (name: string) => /\.(jxl|rw5|job)$/i.test(name);
