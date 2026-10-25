// Move NAD83(2011) positions onto WGS84 / ITRF so they line up with web
// basemap imagery, and undo a Trimble site calibration on grid coordinates.
//
// NAD83(2011) is fixed to the North American plate; ITRF (and WGS84, which
// tracks it to a centimetre or so) is not. NGS defines NAD83(2011) only
// against ITRF2014, so reaching ITRF2020 (≈ WGS84(G2296)) chains two
// time-dependent 14-parameter transformations, as Trimble Access does:
// NAD83(2011) → ITRF2014 → ITRF2020. That handles the frame difference and
// plate motion. It does not model deformation within the plate, which is what
// HTDP adds: in coastal California that is a few centimetres a year, so expect
// a few decimetres of residual over a decade. That is also why epoch 2017.50
// and 2025.00 coordinates of the same mark get the same shift here.

import { child, num, text_ } from './xml';

export interface Helmert {
  name: string;
  source: string;
  target: string;
  /** Reference epoch of the parameters, decimal year. */
  epoch: number;
  /** Translations (m), rotations (mas), scale (ppb), and their yearly rates. */
  t: [number, number, number];
  dt: [number, number, number];
  r: [number, number, number];
  dr: [number, number, number];
  s: number;
  ds: number;
}

/** NGS ITRF2014 → NAD83(2011) parameters, as used by HTDP and NCAT. */
export const ITRF2014_TO_NAD83_2011: Helmert = {
  name: 'ITRF2014 to NAD83(2011) (NGS)',
  source: 'ITRF2014',
  target: 'NAD83(2011)',
  epoch: 2010.0,
  t: [1.0053, -1.90921, -0.54157],
  dt: [0.00079, -0.0006, -0.00144],
  r: [-26.78138, 0.42027, -10.93206],
  dr: [-0.06667, 0.75744, 0.05133],
  s: 0.36891,
  ds: -0.07201,
};

/** IERS ITRF2020 → ITRF2014 parameters. */
export const ITRF2020_TO_ITRF2014: Helmert = {
  name: 'ITRF2020 to ITRF2014 (IERS)',
  source: 'ITRF2020',
  target: 'ITRF2014',
  epoch: 2015.0,
  t: [-0.0014, -0.0009, 0.0014],
  dt: [0, -0.0001, 0.0002],
  r: [0, 0, 0],
  dr: [0, 0, 0],
  s: -0.42,
  ds: 0,
};

/** Transformations from NAD83(2011) out to ITRF2020, each given in its published (forward) direction. */
export const NAD83_TO_ITRF2020: Helmert[] = [ITRF2014_TO_NAD83_2011, ITRF2020_TO_ITRF2014];

/** A 14-parameter transformation Trimble Access stored in the job, if any. */
export function helmertFromJob(root: Element, source: string, target: string): Helmert | undefined {
  const fieldBook = child(root, 'FieldBook');
  const record = fieldBook && child(fieldBook, 'KinematicTransformationsRecord');
  if (!record) return undefined;
  for (const k of Array.from(record.children)) {
    if (text_(k, 'SourceRealization') !== source || text_(k, 'TargetRealization') !== target) continue;
    if (text_(k, 'Type') !== 'FourteenParameters') continue;
    const n = (tag: string) => num(k, tag);
    const vals = [
      'ReferenceEpoch', 'TranslationX', 'TranslationY', 'TranslationZ', 'RotationX', 'RotationY', 'RotationZ', 'Scale',
      'DerivativeTranslationX', 'DerivativeTranslationY', 'DerivativeTranslationZ',
      'DerivativeRotationX', 'DerivativeRotationY', 'DerivativeRotationZ', 'DerivativeScale',
    ].map(n);
    if (vals.some((v) => v === undefined)) continue;
    const [epoch, tx, ty, tz, rx, ry, rz, s, dtx, dty, dtz, drx, dry, drz, ds] = vals as number[];
    return {
      name: `${text_(k, 'Name')} (from job)`,
      source,
      target,
      epoch,
      t: [tx, ty, tz],
      dt: [dtx, dty, dtz],
      r: [rx, ry, rz],
      dr: [drx, dry, drz],
      s,
      ds,
    };
  }
  return undefined;
}

/** The NAD83(2011) → ITRF2020 chain, preferring the parameters stored in the job. */
export function nad83ChainFromJob(root: Element): Helmert[] {
  return NAD83_TO_ITRF2020.map((p) => helmertFromJob(root, p.source, p.target) ?? p);
}

// GRS80; WGS84 differs by 0.1 mm in the semi-minor axis.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;
const MAS = RAD / 3_600_000;

/**
 * NAD83(2011) lat/lon/height to the end of `chain` (ITRF2020 ≈ WGS84 by
 * default) at `epoch`. Each step runs its transformation in reverse.
 */
export function nad83ToWgs84(lat: number, lon: number, h: number, epoch: number, chain: Helmert[] = NAD83_TO_ITRF2020) {
  let xyz = toEcef(lat, lon, h);
  for (const p of chain) xyz = reverse(xyz, p, epoch);
  return toGeodetic(...xyz);
}

/** Apply `p` from its target frame back to its source frame at `epoch`. */
function reverse([x, y, z]: [number, number, number], p: Helmert, epoch: number): [number, number, number] {
  const dy = epoch - p.epoch;
  const t = p.t.map((v, i) => v + p.dt[i] * dy);
  const [rx, ry, rz] = p.r.map((v, i) => (v + p.dr[i] * dy) * MAS);
  const s = (p.s + p.ds * dy) * 1e-9;
  // NGS (HTDP) and IERS convention, source → target:
  //   X' = Tx + (1+s)X - Rz·Y + Ry·Z,  Y' = Ty + Rz·X + (1+s)Y - Rx·Z,  Z' = Tz - Ry·X + Rx·Y + (1+s)Z
  // The parameters are tiny, so negating them inverts it to well under a millimetre.
  return [
    -t[0] + (1 - s) * x + rz * y - ry * z,
    -t[1] - rz * x + (1 - s) * y + rx * z,
    -t[2] + ry * x - rx * y + (1 - s) * z,
  ];
}

function toEcef(lat: number, lon: number, h: number): [number, number, number] {
  const sin = Math.sin(lat * RAD);
  const cos = Math.cos(lat * RAD);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  return [(n + h) * cos * Math.cos(lon * RAD), (n + h) * cos * Math.sin(lon * RAD), (n * (1 - E2) + h) * sin];
}

function toGeodetic(x: number, y: number, z: number) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const sin = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sin * sin);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: lat / RAD, lon: lon / RAD, height: h };
}

/** Today as a decimal year. */
export function currentEpoch(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  return now.getUTCFullYear() + (now.getTime() - start) / (end - start);
}

// ---------------------------------------------------------------- calibration

/**
 * Trimble horizontal plane adjustment (site calibration): a 2D similarity
 * about an origin, applied to projected grid coordinates. Rotation is in
 * degrees. Checked against Trimble Access output to 0.1 mm.
 */
export interface PlaneAdjustment {
  originNorth: number;
  originEast: number;
  translationNorth: number;
  translationEast: number;
  rotation: number;
  scale: number;
}

export function planeAdjustmentFromJob(root: Element): PlaneAdjustment | undefined {
  const fieldBook = child(root, 'FieldBook');
  const records = fieldBook ? Array.from(fieldBook.children).filter((c) => c.tagName === 'HorizontalAdjustmentRecord') : [];
  const r = records[records.length - 1];
  if (!r || text_(r, 'Type') !== 'PlaneAdjustment') return undefined;
  const v = {
    originNorth: num(r, 'OriginNorth'),
    originEast: num(r, 'OriginEast'),
    translationNorth: num(r, 'TranslationNorth') ?? 0,
    translationEast: num(r, 'TranslationEast') ?? 0,
    rotation: num(r, 'Rotation') ?? 0,
    scale: num(r, 'ScaleFactor') ?? 1,
  };
  if (v.originNorth === undefined || v.originEast === undefined) return undefined;
  return v as PlaneAdjustment;
}

/** Projected grid → calibrated (job) grid. */
export function applyPlaneAdjustment(a: PlaneAdjustment, north: number, east: number): [number, number] {
  const dn = north - a.originNorth;
  const de = east - a.originEast;
  const c = Math.cos(a.rotation * RAD);
  const s = Math.sin(a.rotation * RAD);
  return [
    a.originNorth + a.translationNorth + a.scale * (dn * c - de * s),
    a.originEast + a.translationEast + a.scale * (dn * s + de * c),
  ];
}

/** Calibrated (job) grid → projected grid. */
export function removePlaneAdjustment(a: PlaneAdjustment, north: number, east: number): [number, number] {
  const dn = (north - a.originNorth - a.translationNorth) / a.scale;
  const de = (east - a.originEast - a.translationEast) / a.scale;
  const c = Math.cos(a.rotation * RAD);
  const s = Math.sin(a.rotation * RAD);
  return [a.originNorth + dn * c + de * s, a.originEast - dn * s + de * c];
}
