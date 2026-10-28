// Reader for Trimble Access binary job files (.job).
//
// Trimble doesn't publish this format. The layout here was worked out by
// comparing JOB files with JobXML exported from the same jobs, and is written
// up in docs/job-format.md. In short: a 48-byte header, then a journal of
// length-prefixed records, each with a CRC. Records are never rewritten in
// place: an edit, a delete or a new set of feature attributes is a later
// record that points back at the one it changes, so the current state of a
// job is found by replaying the journal.
//
// Rather than build a second document model, the job is translated into
// JobXML and handed to the JobXML parser, so everything downstream (map,
// properties, linework) works the same for both. The JOB doesn't store the
// grid coordinates or ground positions Trimble Access computes, so GNSS shots
// are reduced here (base + vector, antenna height and tilt) and grid
// coordinates are projected from the job's own coordinate system.
//
// Read-only: nothing here writes JOB files.

import proj4 from 'proj4';
import { detectCrs } from './crs';
import { applyPlaneAdjustment } from './datum';
import { parseJxl, type JxlDocument, type ParseOptions } from './jxl';

export class JobParseError extends Error {}

const MAGIC = 'Trimble General Survey Journal';
const HEADER_LENGTH = 0x30;

/** Trimble's "no value" double (about 1e308). */
const NULL_DOUBLE = 1e307;

/** Record kinds: the 16-bit tag after the status byte. */
const KIND_NEW = 0x2a30;
const KIND_REPLACE = 0x2a31;
const KIND_CHILD_REPLACE = 0x2a32;
const KIND_CHILD = 0x2a33;

/** Record types seen so far. Names follow the matching JobXML record. */
export const RecordType = {
  Header: 0,
  Note: 1,
  Point: 2,
  GnssVector: 8,
  GnssVectorTilted: 9,
  Wgs84Position: 15,
  GridPosition: 17,
  Polar: 19,
  TotalStationObservation: 21,
  PointEnd: 31,
  QualityControl1: 32,
  QualityControl2: 33,
  Precision: 35,
  Ellipsoid: 36,
  Datum: 37,
  Projection: 38,
  HorizontalAdjustment: 39,
  VerticalAdjustment: 40,
  Corrections: 41,
  CalibrationPoint: 44,
  GpsEquipment: 45,
  Antenna: 46,
  Units: 51,
  Reference: 70,
  CoordinateSystem: 87,
  KinematicTransformations: 216,
  Deleted: 1000,
  JobName: 1003,
  Features: 1004,
} as const;

export interface JobRecord {
  /** Byte offset of the record's length field. */
  offset: number;
  /** First byte of the record. Its meaning isn't known yet (0-3). */
  status: number;
  kind: number;
  /** For a child or replacement record, the record it belongs to. */
  parent: number;
  type: number;
  id: number;
  /** Controller local time, as JobXML writes it: 2026-09-24T07:38:38. */
  time: string;
  /** Minutes to add to the local time to get UTC. */
  utcOffset: number;
  /** Everything after the 23-byte record header, without the CRC. */
  payload: Uint8Array;
}

export interface JobFile {
  /** Trimble Access database version from the header, e.g. "26.10.15". */
  version: string;
  records: JobRecord[];
}

/** True when the bytes start like a Trimble Access job file. */
export function isJob(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LENGTH) return false;
  return new TextDecoder('latin1').decode(bytes.subarray(0, MAGIC.length)) === MAGIC;
}

/** Split a job file into its records, checking each one's CRC. */
export function readJob(bytes: Uint8Array): JobFile {
  if (!isJob(bytes)) throw new JobParseError('Not a Trimble Access job file: the header is missing.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = `${bytes[0x2d]}.${bytes[0x2e]}.${bytes[0x2f]}`;
  const records: JobRecord[] = [];
  let o = HEADER_LENGTH;
  while (o + 4 <= bytes.length) {
    const n = view.getUint32(o, true);
    if (n < 25 || o + 4 + n > bytes.length) {
      throw new JobParseError(`Record at byte ${o} runs past the end of the file. The file may be truncated.`);
    }
    const body = bytes.subarray(o + 4, o + 4 + n);
    if (crc16(body.subarray(0, n - 2)) !== view.getUint16(o + 4 + n - 2, true)) {
      throw new JobParseError(`Record at byte ${o} fails its checksum. The file may be damaged.`);
    }
    const r = new Cursor(body);
    const status = r.u8();
    const kind = r.u16();
    const parent = r.u32();
    const type = r.u16();
    const id = r.u32();
    const seconds = r.f64Raw();
    const utcOffset = r.u16();
    records.push({ offset: o, status, kind, parent, type, id, time: localTime(seconds), utcOffset, payload: body.subarray(23, n - 2) });
    o += 4 + n;
  }
  return { version, records };
}

/** CRC-16/ARC (reflected 0x8005, initial value 0). */
export function crc16(data: Uint8Array): number {
  let c = 0;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  return c;
}

/** Seconds since 1980-01-01 in controller local time → "YYYY-MM-DDTHH:MM:SS". */
function localTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > NULL_DOUBLE) return '';
  return new Date(Date.UTC(1980, 0, 1) + Math.round(seconds) * 1000).toISOString().slice(0, 19);
}

class Cursor {
  private view: DataView;
  constructor(
    private bytes: Uint8Array,
    public o = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.bytes.length - this.o;
  }
  u8() {
    return this.bytes[this.o++];
  }
  u16() {
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  f64Raw() {
    const v = this.view.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }
  /** A double, or undefined for Trimble's null value. */
  f64() {
    const v = this.f64Raw();
    return Number.isFinite(v) && Math.abs(v) < NULL_DOUBLE ? v : undefined;
  }
  /** Null-terminated UTF-8 string. */
  str() {
    let e = this.o;
    while (e < this.bytes.length && this.bytes[e] !== 0) e++;
    const s = new TextDecoder().decode(this.bytes.subarray(this.o, e));
    this.o = e + 1;
    return s;
  }
  chars(n: number) {
    const s = new TextDecoder('latin1').decode(this.bytes.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
  at(o: number) {
    this.o = o;
    return this;
  }
}

// ---------------------------------------------------------------- decoders

export interface JobAttribute {
  name: string;
  /** JobXML attribute type: Numeric, Text, Menu, File, Photo... */
  type: string;
  value: string;
  itemIndex?: number;
}

export interface JobFeature {
  name: string;
  attributes: JobAttribute[];
}

export interface JobPointRecord {
  name: string;
  features: JobFeature[];
  description1: string;
  description2: string;
  /** Two-letter source tag: KI keyed in, TP topo, SI base, CN control... */
  source: string;
  method: string;
  surveyMethod: string;
  classification: string;
}

const ATTRIBUTE_TYPES: Record<number, string> = { 0: 'Numeric', 1: 'Text', 2: 'Menu', 5: 'File', 8: 'Photo' };

// Enum values seen so far, checked against JobXML. Anything else is shown as
// its number so it can be filled in later.
const METHODS: Record<number, string> = {
  1: 'Coordinates',
  6: 'BearingDistancePointIntersection',
  11: 'GpsStaticObservation',
  13: 'GpsRTKControlPoint',
  60: 'FromBase',
};
const SURVEY_METHODS: Record<number, string> = { 0: 'KeyedIn', 1: 'Autonomous', 14: 'RTK', 15: 'NetworkRTK' };
const CLASSIFICATIONS: Record<number, string> = { 3: 'Construction', 4: 'Normal', 7: 'Averaged', 9: 'Control' };

function enumName(map: Record<number, string>, v: number): string {
  return map[v] ?? `Unknown${v}`;
}

/** The feature codes and their attributes, as in a point or a type 1004 record. */
function readFeatures(c: Cursor): JobFeature[] {
  c.u8();
  const n = c.u32();
  const out: JobFeature[] = [];
  for (let i = 0; i < n; i++) {
    c.u8();
    const name = c.str();
    c.u8();
    c.u16();
    const count = c.u32();
    const attributes: JobAttribute[] = [];
    for (let k = 0; k < count; k++) {
      const t = c.u16();
      const attrName = c.str();
      const type = ATTRIBUTE_TYPES[t] ?? `Unknown${t}`;
      if (t === 0) {
        const v = c.f64();
        attributes.push({ name: attrName, type, value: v === undefined ? '' : num(v) });
      } else if (t === 2) {
        const itemIndex = c.u16();
        attributes.push({ name: attrName, type, value: c.str(), itemIndex });
      } else {
        attributes.push({ name: attrName, type, value: c.str() });
      }
    }
    out.push({ name, attributes });
  }
  return out;
}

export function decodePoint(payload: Uint8Array): JobPointRecord {
  const c = new Cursor(payload);
  const features = readFeatures(c);
  const description1 = c.str();
  // The point name and a fixed 12-byte trailer end the record. What sits
  // between the first description and the name (7 bytes when empty) isn't
  // fully known yet, so the name is found from the end.
  const trailer = payload.length - 12;
  let start = trailer - 1;
  while (start > c.o && payload[start - 1] !== 0) start--;
  const middle = new Cursor(payload.subarray(c.o, start));
  const description2 = middle.remaining > 7 ? middle.str() : '';
  const name = new Cursor(payload, start).str();
  const t = new Cursor(payload, trailer);
  const source = t.chars(2);
  const method = t.u16();
  const survey = t.u16();
  const cls = t.u16();
  return {
    name,
    features,
    description1,
    description2,
    source,
    method: enumName(METHODS, method),
    surveyMethod: enumName(SURVEY_METHODS, survey),
    classification: enumName(CLASSIFICATIONS, cls),
  };
}

interface Vector {
  dx: number;
  dy: number;
  dz: number;
  reference: number;
  antenna: number;
  /** Yaw, pitch and roll in radians, when the receiver's IMU measured tilt. */
  attitude?: { yaw: number; pitch: number; roll: number; sdYaw?: number; sdPitch?: number; sdRoll?: number };
}

function decodeVector(payload: Uint8Array): Vector {
  const c = new Cursor(payload, 1);
  const v: Vector = { dx: c.f64Raw(), dy: c.f64Raw(), dz: c.f64Raw(), reference: c.u32(), antenna: c.u32() };
  if (c.remaining >= 49 && c.u8() === 3) {
    v.attitude = { yaw: c.f64Raw(), pitch: c.f64Raw(), roll: c.f64Raw(), sdYaw: c.f64(), sdPitch: c.f64(), sdRoll: c.f64() };
  }
  return v;
}

interface Equipment {
  receiverType: string;
  receiverSerial: string;
  firmware?: number;
  antennaType: string;
  measurementMethod: string;
  antennaNumber: number;
  antennaMethod: number;
  tapeAdjustment?: number;
  horizontalOffset?: number;
  verticalOffset?: number;
}

function decodeEquipment(payload: Uint8Array): Equipment {
  const c = new Cursor(payload, 1);
  const receiverType = c.str();
  c.str();
  const receiverSerial = c.str();
  const firmware = c.f64();
  const antennaType = c.str();
  c.str();
  const measurementMethod = c.str();
  c.str();
  const antennaNumber = c.u16();
  const antennaMethod = c.u8();
  c.u8();
  return {
    receiverType,
    receiverSerial,
    firmware,
    antennaType,
    measurementMethod,
    antennaNumber,
    antennaMethod,
    tapeAdjustment: c.f64(),
    horizontalOffset: c.f64(),
    verticalOffset: c.f64(),
  };
}

function decodeAntenna(payload: Uint8Array) {
  const c = new Cursor(payload, 1);
  const measuredHeight = c.f64();
  const type = c.u8();
  c.u8();
  return { measuredHeight, measurementType: type === 3 ? 'Raw' : undefined, equipment: c.u32() };
}

// ---------------------------------------------------------------- geodesy

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = 180 / Math.PI;

type Vec3 = [number, number, number];

function geodeticToEcef(lat: number, lon: number, h: number): Vec3 {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + h) * Math.sin(lat)];
}

function ecefToGeodetic([x, y, z]: Vec3): Vec3 {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lat, lon, h];
}

/** Local east/north/up offset → ECEF offset at lat/lon (radians). */
function enuToEcef(lat: number, lon: number, e: number, n: number, u: number): Vec3 {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return [-so * e - sl * co * n + cl * co * u, co * e - sl * so * n + cl * so * u, cl * n + sl * u];
}

function offset(pos: Vec3, d: Vec3): Vec3 {
  const x = geodeticToEcef(...pos);
  return ecefToGeodetic([x[0] + d[0], x[1] + d[1], x[2] + d[2]]);
}

/**
 * Ground point under a GNSS antenna. `height` is from the ground mark to the
 * antenna phase centre, along the pole. With IMU tilt the pole leans by pitch
 * (about the device's right axis) and roll (about its forward axis), and the
 * device faces `yaw`. These sign conventions reproduce Trimble Access's
 * reductions to well under a millimetre.
 */
export function groundUnderAntenna(apc: Vec3, height: number, attitude?: Vector['attitude']): Vec3 {
  let e = 0;
  let n = 0;
  let u = height;
  if (attitude) {
    const p = -attitude.pitch;
    const r = attitude.roll;
    const az = -attitude.yaw;
    const fwd = height * Math.sin(p) * Math.cos(r);
    const right = height * Math.sin(r);
    u = height * Math.cos(p) * Math.cos(r);
    e = fwd * Math.sin(az) + right * Math.cos(az);
    n = fwd * Math.cos(az) - right * Math.sin(az);
  }
  const d = enuToEcef(apc[0], apc[1], -e, -n, -u);
  return offset(apc, d);
}

// ---------------------------------------------------------------- the journal

/** Current state of every record after replaying edits and deletes. */
class Journal {
  byId = new Map<number, JobRecord>();
  children = new Map<number, JobRecord[]>();
  position = new Map<JobRecord, number>();
  constructor(public file: JobFile) {
    file.records.forEach((r, i) => this.position.set(r, i));
    for (const r of file.records) {
      if (r.kind === KIND_NEW) this.byId.set(r.id, r);
      else if (r.kind === KIND_REPLACE) this.byId.set(r.parent, r);
      else if (r.kind === KIND_CHILD || r.kind === KIND_CHILD_REPLACE) {
        const list = this.children.get(r.parent) ?? [];
        list.push(r);
        this.children.set(r.parent, list);
      }
    }
  }
  /** Top-level records in file order, each in its latest version. */
  *topLevel(): Generator<JobRecord> {
    for (const r of this.file.records) if (r.kind === KIND_NEW) yield this.byId.get(r.id) ?? r;
  }
  latestChild(id: number, type: number): JobRecord | undefined {
    const list = this.children.get(id);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].type === type) return list[i];
    return undefined;
  }
  childrenOf(id: number, type: number): JobRecord[] {
    return (this.children.get(id) ?? []).filter((r) => r.type === type);
  }
}

// ---------------------------------------------------------------- JobXML output

class Xml {
  out: string[] = [];
  private depth = 1;
  open(tag: string, attrs: Record<string, string> = {}) {
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join('');
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${a}>`);
    this.depth++;
  }
  close(tag: string) {
    this.depth--;
    this.out.push(`${'  '.repeat(this.depth)}</${tag}>`);
  }
  el(tag: string, value: string | number | undefined, attrs: Record<string, string> = {}) {
    if (value === undefined) return;
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join('');
    const text = typeof value === 'number' ? num(value) : esc(value);
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${a}>${text}</${tag}>`);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(14)));
}

function hexId(id: number): string {
  return id.toString(16).padStart(8, '0');
}

const deg = (rad: number) => rad * DEG;
const degOrUndefined = (rad: number | undefined) => (rad === undefined ? undefined : rad * DEG);

const PROJECTION_TYPES: Record<number, string> = { 7: 'Lambert2Parallel' };
const HORIZONTAL_TYPES: Record<number, string> = { 0: 'NoAdjustment', 1: 'PlaneAdjustment' };
const VERTICAL_TYPES: Record<number, string> = { 3: 'GeoidModel', 5: 'GeoidModelAndInclinedPlane' };
const DISTANCES: Record<number, string> = { 0: 'GridDistance', 2: 'GroundDistance' };
const DISTANCE_UNITS: Record<number, string> = { 6: 'USSurveyFeet' };

interface PointState {
  record: JobRecord;
  point: JobPointRecord;
  deleted: boolean;
  wgs84?: Vec3;
  grid?: { north: number; east: number; elevation?: number };
}

/** Translate a JOB file into JobXML text. */
export function jobToJxl(bytes: Uint8Array, jobName = ''): string {
  const file = readJob(bytes);
  const j = new Journal(file);
  const x = new Xml();
  const positions = new Map<string, Vec3>();
  const references = new Map<number, { name: string; antenna: number }>();
  const points: PointState[] = [];
  let projectHeight: number | undefined;
  const header = file.records.find((r) => r.type === RecordType.Header);
  // The header names the job it was created as (often a template it was
  // copied from); a rename or copy adds a child of record 0 with the new name.
  const h = header ? new Cursor((j.byId.get(header.id) ?? header).payload, 1) : undefined;
  const created = h ? { name: h.str(), serial: (h.str(), h.str()), version: h.str() } : undefined;
  const renamed = j.latestChild(0, RecordType.JobName);
  const name = jobName || (renamed ? new Cursor(renamed.payload, 2).str() : (created?.name ?? ''));

  for (const r of j.topLevel()) {
    const c = new Cursor(r.payload);
    const attrs = { ID: hexId(r.id), TimeStamp: r.time };
    switch (r.type) {
      case RecordType.Units: {
        x.open('UnitsRecord', attrs);
        x.el('DistanceUnits', DISTANCE_UNITS[c.at(1).u16()]);
        x.el('HeightUnits', DISTANCE_UNITS[c.u16()]);
        x.close('UnitsRecord');
        break;
      }
      case RecordType.Corrections: {
        x.open('CorrectionsRecord', attrs);
        const d = c.at(16).u8();
        x.el('Distances', DISTANCES[d] ?? `Unknown${d}`);
        x.close('CorrectionsRecord');
        break;
      }
      case RecordType.Ellipsoid: {
        x.open('EllipsoidRecord', attrs);
        c.at(3);
        x.el('EarthRadius', c.f64());
        x.el('Flattening', c.f64());
        c.u32();
        x.el('LocalEllipsoidEPSG', c.i32());
        x.close('EllipsoidRecord');
        break;
      }
      case RecordType.Projection: {
        const type = c.at(3).u16();
        x.open('ProjectionRecord', attrs);
        x.open('Projection');
        x.el('Type', PROJECTION_TYPES[type] ?? `Unknown${type}`);
        // Angles are stored in radians.
        x.el('CentralLatitude', degOrUndefined(c.at(5).f64()));
        x.el('CentralLongitude', degOrUndefined(c.at(13).f64()));
        x.el('Scale', c.at(21).f64());
        x.el('FalseNorthing', c.at(29).f64());
        x.el('FalseEasting', c.at(37).f64());
        x.el('Parallel1', degOrUndefined(c.at(63).f64()));
        x.el('Parallel2', degOrUndefined(c.at(71).f64()));
        x.close('Projection');
        x.open('LocalSite');
        x.el('Type', 'Grid');
        // Older versions have two fewer bytes in the middle, so count from the end.
        projectHeight = c.at(r.payload.length - 41).f64();
        x.el('ProjectLocationHeight', projectHeight);
        x.close('LocalSite');
        x.close('ProjectionRecord');
        break;
      }
      case RecordType.Datum: {
        x.open('DatumRecord', attrs);
        x.el('ReferenceGlobalFrameID', c.at(62).i32());
        x.el('ReferenceGlobalFrameEPSG', c.i32());
        x.el('ReferenceGlobalFrameEpoch', c.at(74).f64()?.toFixed(2));
        x.el('ReferenceGlobalFrameName', c.at(82).str());
        x.el('DisplacementModelName', c.str());
        x.close('DatumRecord');
        break;
      }
      case RecordType.HorizontalAdjustment: {
        const type = c.at(3).u16();
        x.open('HorizontalAdjustmentRecord', attrs);
        x.el('Type', HORIZONTAL_TYPES[type] ?? `Unknown${type}`);
        x.el('OriginNorth', c.f64());
        x.el('OriginEast', c.f64());
        x.el('TranslationNorth', c.f64());
        x.el('TranslationEast', c.f64());
        x.el('Rotation', degOrUndefined(c.f64()));
        x.el('ScaleFactor', c.f64());
        x.close('HorizontalAdjustmentRecord');
        break;
      }
      case RecordType.VerticalAdjustment: {
        const type = c.at(3).u16();
        x.open('VerticalAdjustmentRecord', attrs);
        x.el('Type', VERTICAL_TYPES[type] ?? `Unknown${type}`);
        x.el('OriginNorth', c.f64());
        x.el('OriginEast', c.f64());
        x.el('SlopeNorthPerUnit', c.f64());
        x.el('SlopeEastPerUnit', c.f64());
        x.el('ConstantAdjustment', c.f64());
        x.el('GeoidName', c.str());
        x.close('VerticalAdjustmentRecord');
        break;
      }
      case RecordType.CoordinateSystem: {
        x.open('CoordinateSystemRecord', attrs);
        c.at(1);
        x.el('SystemName', c.str());
        x.el('ZoneName', c.str());
        x.el('DatumName', c.str());
        x.close('CoordinateSystemRecord');
        break;
      }
      case RecordType.KinematicTransformations:
        writeKinematic(x, c, attrs);
        break;
      case RecordType.GpsEquipment: {
        const e = decodeEquipment(r.payload);
        x.open('GPSEquipmentRecord', attrs);
        x.el('ReceiverType', e.receiverType);
        x.el('ReceiverSerialNumber', e.receiverSerial);
        x.el('ReceiverFirmwareVersion', e.firmware);
        x.el('AntennaType', e.antennaType);
        x.el('AntennaNumber', e.antennaNumber);
        x.el('AntennaMeasurementMethod', e.measurementMethod);
        x.el('AntennaMethod', e.antennaMethod);
        x.el('AntennaTapeAdjustment', e.tapeAdjustment);
        x.el('AntennaHorizontalOffset', e.horizontalOffset);
        x.el('AntennaVerticalOffset', e.verticalOffset);
        x.close('GPSEquipmentRecord');
        break;
      }
      case RecordType.Antenna: {
        const a = decodeAntenna(r.payload);
        const e = j.byId.get(a.equipment);
        const vertical = e ? (decodeEquipment(e.payload).verticalOffset ?? 0) : 0;
        x.open('AntennaRecord', attrs);
        x.el('MeasuredHeight', a.measuredHeight);
        x.el('MeasurementType', a.measurementType);
        x.el('GPSEquipmentID', hexId(a.equipment));
        if (a.measuredHeight !== undefined) x.el('ReducedHeight', a.measuredHeight + vertical);
        x.close('AntennaRecord');
        break;
      }
      case RecordType.Reference: {
        const name = c.at(1).str();
        const antenna = c.u32();
        references.set(r.id, { name, antenna });
        x.open('ReferenceRecord', attrs);
        x.el('PointName', name);
        x.el('AntennaID', hexId(antenna));
        x.close('ReferenceRecord');
        break;
      }
      case RecordType.Note: {
        x.open('NoteRecord', attrs);
        x.open('Notes');
        x.el('Note', noteText(r.payload));
        x.close('Notes');
        x.close('NoteRecord');
        break;
      }
      case RecordType.Point: {
        const state = writePoint(x, j, r, positions, references, name);
        points.push(state);
        break;
      }
    }
  }

  x.close('FieldBook');

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<JOBFile jobName="${esc(name)}" product="Trimble Access" productDBVersion="${file.version}"` +
      ` controllerSerialNumber="${esc(created?.serial ?? '')}" originalProductVersion="${esc(created?.version ?? '')}"` +
      ` sourceFormat="JOB" TimeStamp="${header?.time ?? ''}">`,
    '  <FieldBook>',
  ];

  // Trimble Access works out grid coordinates and the combined scale factor
  // when it exports; the JOB only has the coordinate system. Read it back from
  // the records written so far and do the same here.
  const fieldBook = new DOMParser().parseFromString([...head, ...x.out, '</JOBFile>'].join('\n'), 'application/xml');
  const crs = detectCrs(fieldBook.documentElement);
  const toGrid = crs.projection ? proj4('EPSG:4326', crs.projection.proj4) : undefined;
  const grid = (p: Vec3) => {
    const [e, n] = toGrid!.forward([deg(p[1]), deg(p[0])]);
    return crs.adjustment ? applyPlaneAdjustment(crs.adjustment, n, e) : [n, e];
  };

  x.open('Reductions');
  for (const p of points) {
    if (p.deleted) continue;
    x.open('Point');
    x.el('ID', hexId(p.record.id));
    x.el('Name', p.point.name);
    x.el('Code', codeOf(p.point.features));
    x.el('SurveyMethod', p.point.surveyMethod);
    x.el('Classification', p.point.classification);
    writeWgs84(x, p.wgs84);
    // Elevations of measured points need the geoid model, which isn't here.
    const g = p.grid ?? (toGrid && p.wgs84 ? { north: grid(p.wgs84)[0], east: grid(p.wgs84)[1], elevation: undefined } : undefined);
    if (g) {
      x.open('Grid');
      x.el('North', g.north);
      x.el('East', g.east);
      x.el('Elevation', g.elevation);
      x.close('Grid');
    }
    x.close('Point');
  }
  x.close('Reductions');

  const located = points.filter((p) => !p.deleted && p.wgs84).map((p) => p.wgs84!);
  if (toGrid && located.length && projectHeight !== undefined) {
    const lat = located.reduce((s, p) => s + p[0], 0) / located.length;
    const lon = located.reduce((s, p) => s + p[1], 0) / located.length;
    x.open('Environment');
    x.open('CoordinateSystem');
    x.open('CombinedScaleFactor');
    x.open('Location');
    x.el('Latitude', deg(lat));
    x.el('Longitude', deg(lon));
    x.el('Height', projectHeight);
    x.close('Location');
    x.el('Scale', combinedScaleFactor(toGrid, lat, lon, projectHeight));
    x.close('CombinedScaleFactor');
    x.close('CoordinateSystem');
    x.close('Environment');
  }

  return [...head, ...x.out, '</JOBFile>', ''].join('\n');
}

function writeKinematic(x: Xml, c: Cursor, attrs: Record<string, string>) {
  c.at(1);
  const n = c.u32();
  x.open('KinematicTransformationsRecord', attrs);
  for (let i = 0; i < n; i++) {
    const systemId = c.u32();
    const type = c.u32();
    const name = c.str();
    const source = c.str();
    const target = c.str();
    const epoch = c.f64();
    c.o += 16;
    const v = Array.from({ length: 14 }, () => c.f64Raw());
    c.o += 2;
    x.open('KinematicTransformation');
    x.el('Name', name);
    x.el('SystemID', systemId);
    x.el('SourceRealization', source);
    x.el('TargetRealization', target);
    x.el('ReferenceEpoch', epoch?.toFixed(2));
    x.el('Type', type === 1 ? 'FourteenParameters' : `Unknown${type}`);
    const tags = [
      'RotationX', 'RotationY', 'RotationZ', 'TranslationX', 'TranslationY', 'TranslationZ', 'Scale',
      'DerivativeRotationX', 'DerivativeRotationY', 'DerivativeRotationZ',
      'DerivativeTranslationX', 'DerivativeTranslationY', 'DerivativeTranslationZ', 'DerivativeScale',
    ];
    tags.forEach((t, k) => x.el(t, v[k]));
    x.close('KinematicTransformation');
  }
  x.close('KinematicTransformationsRecord');
}

function noteText(payload: Uint8Array): string {
  return new TextDecoder().decode(payload).replace(/\0+$/, '').trim();
}

function codeOf(features: JobFeature[]): string {
  return features.map((f) => f.name).join(' ');
}

function writeWgs84(x: Xml, p: Vec3 | undefined) {
  if (!p) return;
  x.open('WGS84');
  x.el('Latitude', deg(p[0]));
  x.el('Longitude', deg(p[1]));
  x.el('Height', p[2]);
  x.close('WGS84');
}

function writePoint(
  x: Xml,
  j: Journal,
  r: JobRecord,
  positions: Map<string, Vec3>,
  references: Map<number, { name: string; antenna: number }>,
  jobName: string,
): PointState {
  const point = decodePoint(r.payload);
  // A later attribute edit carries the point's whole feature list again.
  const edited = j.latestChild(r.id, RecordType.Features);
  if (edited) point.features = readFeatures(new Cursor(edited.payload));
  const del = j.latestChild(r.id, RecordType.Deleted);
  const deleted = !!del && del.payload[1] === 0;
  const state: PointState = { record: r, point, deleted };

  x.open('PointRecord', { ID: hexId(r.id), TimeStamp: r.time });
  x.el('Name', point.name);
  x.el('Code', codeOf(point.features));
  if (point.description1 || point.description2) {
    x.el('Description1', point.description1, { Name: '' });
    x.el('Description2', point.description2, { Name: '' });
  }
  x.el('Method', point.method);
  x.el('SurveyMethod', point.surveyMethod);
  x.el('Classification', point.classification);
  x.el('Deleted', String(deleted));
  // Like JobXML, only codes that carry feature attributes are listed as
  // features. Plain codes and control codes (BL, EL...) are only in the code.
  const withAttributes = point.features.filter((f) => f.attributes.length);
  if (withAttributes.length) {
    x.open('Features');
    for (const f of withAttributes) {
      x.open('Feature', { Name: f.name });
      for (const a of f.attributes) {
        x.open('Attribute');
        x.el('Name', a.name);
        // Photos live in the job's "<job> Files" folder, which JobXML spells out.
        x.el('Value', a.type === 'Photo' && a.value ? `${jobName} Files/${a.value}` : a.value);
        x.el('Type', a.type);
        x.el('ItemIndex', a.itemIndex);
        x.close('Attribute');
      }
      x.close('Feature');
    }
    x.close('Features');
  }

  const wgs = j.latestChild(r.id, RecordType.Wgs84Position);
  const grid = j.latestChild(r.id, RecordType.GridPosition);
  const vector = j.latestChild(r.id, RecordType.GnssVectorTilted) ?? j.latestChild(r.id, RecordType.GnssVector);
  const polar = j.latestChild(r.id, RecordType.Polar);

  if (wgs) {
    const c = new Cursor(wgs.payload, 1);
    state.wgs84 = [c.f64Raw(), c.f64Raw(), c.f64Raw()];
    writeWgs84(x, state.wgs84);
  }
  if (grid) {
    const c = new Cursor(grid.payload, 1);
    state.grid = { north: c.f64Raw(), east: c.f64Raw(), elevation: c.f64() };
    x.open('Grid');
    x.el('North', state.grid.north);
    x.el('East', state.grid.east);
    x.el('Elevation', state.grid.elevation);
    x.close('Grid');
  }
  if (vector) {
    const v = decodeVector(vector.payload);
    const reference = references.get(v.reference);
    const baseName = reference?.name ?? '';
    x.open('ECEFDeltas');
    x.el('DeltaX', v.dx);
    x.el('DeltaY', v.dy);
    x.el('DeltaZ', v.dz);
    x.close('ECEFDeltas');
    x.el('ReferenceRecordID', hexId(v.reference));
    x.el('RTK_Base', baseName);
    x.el('AntennaID', hexId(v.antenna));
    if (v.attitude) {
      x.open('DeviceAxisOrientation');
      x.el('Type', 'InertialTiltComp');
      x.open('Attitude');
      x.el('Pitch', deg(v.attitude.pitch));
      x.el('Roll', deg(v.attitude.roll));
      x.el('Yaw', deg(v.attitude.yaw));
      x.close('Attitude');
      x.close('DeviceAxisOrientation');
    }
    // The vector runs between the two antennas' phase centres.
    const mark = positions.get(baseName);
    const height = antennaHeight(j, v.antenna);
    if (mark && height !== undefined) {
      const baseHeight = (reference && antennaHeight(j, reference.antenna)) ?? 0;
      const base = offset(mark, enuToEcef(mark[0], mark[1], 0, 0, baseHeight));
      const apc = offset(base, [v.dx, v.dy, v.dz]);
      state.wgs84 = groundUnderAntenna(apc, height, v.attitude);
    }
  }
  if (polar) {
    const c = new Cursor(polar.payload, 1);
    const source = c.str();
    const azimuth = c.f64Raw();
    const hd = c.f64Raw();
    const vd = c.f64() ?? 0;
    const azimuthType = c.u8();
    const distanceType = c.u8();
    x.el('SourcePoint', source);
    x.open('Polar');
    x.el('Azimuth', deg(azimuth));
    x.el('HorizontalDistance', hd);
    x.el('VerticalDistance', vd);
    x.close('Polar');
    x.el('AzimuthType', azimuthType === 0x49 ? 'WGS84' : `Unknown${azimuthType}`);
    x.el('DistanceType', distanceType === 4 ? 'Ground' : `Unknown${distanceType}`);
    const from = positions.get(source);
    if (from) state.wgs84 = offset(from, enuToEcef(from[0], from[1], hd * Math.sin(azimuth), hd * Math.cos(azimuth), vd));
  }

  const precision = nextOfType(j, r, RecordType.Precision);
  if (precision) {
    const c = new Cursor(precision.payload, 1);
    x.open('Precision');
    x.el('Horizontal', c.f64());
    x.el('Vertical', c.f64());
    x.close('Precision');
  }
  const qc = nextOfType(j, r, RecordType.QualityControl1);
  if (qc) writeQc1(x, new Cursor(qc.payload));

  // Each note record repeats the earlier ones, newest first, a line each.
  const note = j.latestChild(r.id, RecordType.Note);
  const notes = note ? noteText(note.payload).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (notes.length) {
    x.open('Notes');
    for (const n of notes) x.el('Note', n);
    x.close('Notes');
  }
  x.close('PointRecord');

  if (!deleted && state.wgs84) positions.set(point.name, state.wgs84);
  return state;
}

/**
 * Precision and quality-control records follow their point as top-level
 * records rather than children. Find one before the point's end marker.
 */
function nextOfType(j: Journal, point: JobRecord, type: number): JobRecord | undefined {
  const records = j.file.records;
  let i = j.position.get(point) ?? -1;
  if (i < 0) return undefined;
  for (i++; i < records.length; i++) {
    const r = records[i];
    if (r.kind !== KIND_NEW) continue;
    if (r.type === type) return r;
    if (r.type === RecordType.PointEnd || r.type === RecordType.Point) return undefined;
  }
  return undefined;
}

function writeQc1(x: Xml, c: Cursor) {
  c.at(1);
  // Satellites used, then the minimum during the occupation: total, then by system.
  const used = Array.from({ length: 7 }, () => c.u16());
  const min = Array.from({ length: 7 }, () => c.u16());
  const systems = ['GPS', 'GLONASS', 'Galileo', 'QZSS', 'BeiDou', 'NavIC'];
  x.open('QualityControl1');
  x.el('MinimumNumberOfSatellites', min[0]);
  systems.slice(0, 5).forEach((s, i) => x.el(`Min${s}SVs`, min[i + 1]));
  x.el('NumberOfSatellites', used[0]);
  systems.forEach((s, i) => x.el(`Num${s}SVs`, used[i + 1]));
  x.el('PDOP', c.at(30).f64());
  x.el('GDOP', c.f64());
  x.el('HDOP', c.f64());
  x.el('VDOP', c.f64());
  x.el('NumberOfPositionsUsed', c.at(102).u16());
  x.open('StartTime');
  x.el('GPSWeek', c.at(154).u16());
  x.el('Seconds', c.f64());
  x.close('StartTime');
  x.open('EndTime');
  x.el('GPSWeek', c.at(164).u16());
  x.el('Seconds', c.f64());
  x.close('EndTime');
  const age = c.at(176).f64();
  x.el('RTCMAge', age === undefined ? undefined : Math.round(age * 1e6) / 1e6);
  x.close('QualityControl1');
}

/**
 * Grid distance ÷ ground distance near lat/lon (radians) at ellipsoid height
 * h: the projection's point scale times the elevation factor R / (R + h).
 */
function combinedScaleFactor(toGrid: proj4.Converter, lat: number, lon: number, h: number): number {
  const d = 50;
  const ends = [-d, d].map((e) => {
    const [la, lo] = offset([lat, lon, 0], enuToEcef(lat, lon, e, e, 0));
    return toGrid.forward([deg(lo), deg(la)]);
  });
  const k = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) / (2 * d * Math.SQRT2);
  const sin2 = Math.sin(lat) ** 2;
  const m = (A * (1 - E2)) / (1 - E2 * sin2) ** 1.5;
  const n = A / Math.sqrt(1 - E2 * sin2);
  const r = Math.sqrt(m * n);
  return (k * r) / (r + h);
}

/** Ground mark to antenna phase centre: measured height plus the antenna's offset. */
function antennaHeight(j: Journal, antennaId: number): number | undefined {
  const a = j.byId.get(antennaId);
  if (!a) return undefined;
  const ant = decodeAntenna(a.payload);
  if (ant.measuredHeight === undefined) return undefined;
  const e = j.byId.get(ant.equipment);
  return ant.measuredHeight + (e ? (decodeEquipment(e.payload).verticalOffset ?? 0) : 0);
}

/** Parse a JOB file into the same document the JobXML parser produces. */
export function parseJob(bytes: Uint8Array, options: ParseOptions & { jobName?: string } = {}): JxlDocument {
  return { ...parseJxl(jobToJxl(bytes, options.jobName), options), format: 'job' };
}
