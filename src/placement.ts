// Placing a job that's in assumed coordinates (say 10000, 10000 with an
// assumed basis of bearing) on the map by hand. The job is pinned at one grid
// position, which is put at a lat/long, and turned about it. Distances stay
// as measured: the grid is laid on a plane tangent to the ellipsoid at the pin.

import type { JxlPoint } from './jxl';

export interface Placement {
  /** The grid position the job is pinned at, in metres like JobXML. */
  north: number;
  east: number;
  /** Where the pin sits on the map (WGS84). */
  lat: number;
  lon: number;
  /** Degrees added to a bearing in the job to give a true bearing. */
  rotation: number;
  /** When it was last changed, to pick the newer of two saved copies. */
  updated: string;
}

const RAD = Math.PI / 180;
const A = 6378137;
const E2 = 0.00669437999014;

/** Metres per radian north and east at a latitude, on WGS84. */
function radii(lat: number): [number, number] {
  const s = Math.sin(lat * RAD);
  const w = 1 - E2 * s * s;
  return [(A * (1 - E2)) / w ** 1.5, (A / Math.sqrt(w)) * Math.cos(lat * RAD)];
}

/** Where a grid position lands on the map: [lat, lon]. */
export function placeGrid(pl: Placement, north: number, east: number): [number, number] {
  const dn = north - pl.north;
  const de = east - pl.east;
  const c = Math.cos(pl.rotation * RAD);
  const s = Math.sin(pl.rotation * RAD);
  const n = dn * c - de * s;
  const e = dn * s + de * c;
  const [mn, me] = radii(pl.lat);
  return [pl.lat + n / mn / RAD, pl.lon + e / me / RAD];
}

/** Metres [east, north] from the pin to a position on the map. */
export function fromPin(pl: Placement, lat: number, lon: number): [number, number] {
  const [mn, me] = radii(pl.lat);
  return [(lon - pl.lon) * RAD * me, (lat - pl.lat) * RAD * mn];
}

/** True bearing in degrees from the pin to a position on the map. */
export function bearingFromPin(pl: Placement, lat: number, lon: number): number {
  const [e, n] = fromPin(pl, lat, lon);
  return Math.atan2(e, n) / RAD;
}

/** The same placement pinned at another grid position, so it turns about that one. */
export function repin(pl: Placement, north: number, east: number): Placement {
  const [lat, lon] = placeGrid(pl, north, east);
  return { ...pl, north, east, lat, lon };
}

/** An angle in -180..180. */
export function normalizeAngle(deg: number): number {
  const a = (((deg % 360) + 360) % 360);
  return a > 180 ? a - 360 : a;
}

/** Points whose map position would come from the placement. */
export function isPlaceable(p: JxlPoint): boolean {
  const c = p.coords;
  return c.north !== undefined && c.east !== undefined && (c.lat === undefined || c.source === 'Grid' || c.source === 'Placed');
}

/**
 * Whether the job can be placed by hand: it has grid positions and nothing
 * measured by GNSS or tied to the earth by a localization already.
 */
export function canPlace(points: JxlPoint[]): boolean {
  const tied = new Set(['WGS84', 'ECEF', 'Localized']);
  return points.some(isPlaceable) && !points.some((p) => tied.has(p.coords.source!));
}

/** Give every grid point its lat/long from the placement. Returns how many. */
export function applyPlacement(points: JxlPoint[], pl: Placement): number {
  let n = 0;
  for (const p of points) {
    if (!isPlaceable(p)) continue;
    const c = p.coords;
    [c.lat, c.lon] = placeGrid(pl, c.north!, c.east!);
    c.height = undefined;
    c.source = 'Placed';
    n++;
  }
  return n;
}

/** Take the placement off, so the points are grid-only again. */
export function removePlacement(points: JxlPoint[]) {
  for (const p of points) {
    const c = p.coords;
    if (c.source !== 'Placed') continue;
    c.lat = c.lon = c.mapLat = c.mapLon = c.source = undefined;
  }
}

/**
 * A first placement with the middle of the job at `lat`, `lon` and no
 * rotation. The pin is the point nearest the middle, so turning about it is
 * natural; deleted points and far-off keyed-in control are left out.
 */
export function initialPlacement(points: JxlPoint[], lat: number, lon: number, now = new Date().toISOString()): Placement | undefined {
  const grid = points.filter((p) => isPlaceable(p) && !p.deleted);
  const measured = grid.filter((p) => p.type !== 'Keyed in');
  const pts = measured.length ? measured : grid;
  if (!pts.length) return undefined;
  const n = pts.reduce((s, p) => s + p.coords.north!, 0) / pts.length;
  const e = pts.reduce((s, p) => s + p.coords.east!, 0) / pts.length;
  let best = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.hypot(p.coords.north! - n, p.coords.east! - e);
    if (d < bestD) [best, bestD] = [p, d];
  }
  return { north: best.coords.north!, east: best.coords.east!, lat, lon, rotation: 0, updated: now };
}

export function isPlacement(o: unknown): o is Placement {
  const p = o as Placement;
  return !!p && [p.north, p.east, p.lat, p.lon, p.rotation].every(Number.isFinite) && typeof p.updated === 'string';
}

export function samePlacement(a: Placement | undefined, b: Placement | undefined): boolean {
  if (!a || !b) return a === b;
  return a.north === b.north && a.east === b.east && a.lat === b.lat && a.lon === b.lon && a.rotation === b.rotation;
}

/** The newer of two saved placements. */
export function newer(a: Placement | undefined, b: Placement | undefined): Placement | undefined {
  if (!a || !b) return a ?? b;
  return a.updated >= b.updated ? a : b;
}

/**
 * Read an angle typed as decimal degrees ("12.5", "-3.25") or degrees,
 * minutes and seconds ("12°30'15\"", "12 30 15", "-12d30m"). Undefined if it
 * can't be read.
 */
export function parseAngle(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const sign = /^-/.test(t) ? -1 : 1;
  const parts = t
    .replace(/^[+-]/, '')
    .split(/[^\d.]+/)
    .filter(Boolean)
    .map(Number);
  if (!parts.length || parts.length > 3 || parts.some((v) => !Number.isFinite(v))) return undefined;
  if (/[^\d.\s°º'′"″dmsDMS+-]/.test(t)) return undefined;
  const [d, m = 0, s = 0] = parts;
  if (parts.length > 1 && (m >= 60 || s >= 60)) return undefined;
  return sign * (d + m / 60 + s / 3600);
}

/** An angle as degrees, minutes and seconds: 12°30'15.0". */
export function formatDms(deg: number, places = 1): string {
  const sign = deg < 0 ? '-' : '';
  const scale = 10 ** places;
  let total = Math.round(Math.abs(deg) * 3600 * scale) / scale;
  const d = Math.floor(total / 3600);
  total -= d * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${sign}${d}°${String(m).padStart(2, '0')}'${s.toFixed(places).padStart(places ? places + 3 : 2, '0')}"`;
}
