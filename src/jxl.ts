// Parser for Trimble JobXML (.jxl) files.
//
// JobXML stores all distances in metres and all angles/geodetic coordinates in
// decimal degrees, regardless of the units shown in the field software.

import proj4 from 'proj4';
import { detectCrs, type CrsInfo } from './crs';
import { applyPlaneAdjustment } from './datum';
import { attrEntries, child, children, flatten, num, text_, type Attrs } from './xml';
import { reduceTotalStation, type TsContext } from './totalstation';

export type { Attrs } from './xml';

export interface Coordinates {
  lat?: number;
  lon?: number;
  height?: number;
  north?: number;
  east?: number;
  elevation?: number;
  /** Where the lat/lon came from. */
  source?: 'WGS84' | 'ECEF' | 'Grid';
  /** Grid position was computed here from a total station observation. */
  reduced?: boolean;
  /** Where to draw the point on the basemap, after any datum shift. */
  mapLat?: number;
  mapLon?: number;
}

export type ObservationType = 'GNSS' | 'Total station' | 'Computed' | 'Keyed in' | 'Other';

export interface JxlPoint {
  /** Stable index into JxlDocument.points. */
  index: number;
  id: string;
  name: string;
  code: string;
  coords: Coordinates;
  /** Where the point came from in the file. */
  origin: 'Reductions' | 'FieldBook';
  /** How the point was measured, from its FieldBook record. */
  type: ObservationType;
  deleted: boolean;
  /** Flattened attributes of the point (and its matching FieldBook record). */
  attributes: Attrs;
  /** Feature attributes captured in the field (Features/Feature/Attribute). */
  features: { name: string; attributes: Attrs }[];
}

export interface MetadataSection {
  title: string;
  entries: [string, string][];
}

export interface JxlDocument {
  points: JxlPoint[];
  metadata: MetadataSection[];
  /** Points that only have grid coordinates (need a projection to be mapped). */
  gridOnlyCount: number;
  crs: CrsInfo;
}

export class JxlParseError extends Error {}

export interface ParseOptions {
  /**
   * proj4 definition (metres) of the job's grid. Used to put GNSS-measured
   * total station setups on the grid. Defaults to the detected coordinate system.
   */
  proj4?: string;
}

export function parseJxl(text: string, options: ParseOptions = {}): JxlDocument {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const err = xml.getElementsByTagName('parsererror')[0];
  if (err) throw new JxlParseError(`Not valid XML: ${err.textContent?.trim().split('\n')[0] ?? ''}`);
  const root = xml.documentElement;
  if (root.tagName !== 'JOBFile') {
    throw new JxlParseError(`Expected a <JOBFile> root element, found <${root.tagName}>. Is this a Trimble JobXML file?`);
  }

  const fieldBook = child(root, 'FieldBook');
  const reductions = child(root, 'Reductions');
  const crs = detectCrs(root);
  const gridDef = options.proj4 ?? crs.projection?.proj4;
  const toGrid = gridDef ? proj4('EPSG:4326', gridDef) : undefined;

  const records = fieldBook ? children(fieldBook, 'PointRecord') : [];
  const recordsById = new Map<string, Element>();
  const recordsByName = new Map<string, Element>();
  for (const r of records) {
    const id = r.getAttribute('ID');
    if (id) recordsById.set(id, r);
    // Later records with the same name supersede earlier ones.
    if (!isDeleted(r)) recordsByName.set(text_(r, 'Name'), r);
  }

  // Positions of every FieldBook record, reducing total station shots that
  // don't carry their own coordinates. Records are processed in file order so
  // a setup on a previously observed point can use that point's position.
  const ts: TsContext = { fieldBook, gridByName: new Map() };
  const recordCoords = new Map<Element, Coordinates>();
  for (const r of records) {
    let c = coordinates(r);
    if (c.north === undefined && c.lat === undefined) c = { ...c, ...reduceTotalStation(r, ts) };
    recordCoords.set(r, c);
    if (isDeleted(r)) continue;
    if (c.north !== undefined && c.east !== undefined) {
      ts.gridByName.set(text_(r, 'Name'), { north: c.north, east: c.east, elevation: c.elevation });
    } else if (toGrid && c.lat !== undefined && c.lon !== undefined) {
      // A GNSS-measured setup or backsight. Its elevation needs a geoid model,
      // so shots from it get plan positions only.
      const [e, n] = toGrid.forward([c.lon, c.lat]);
      const [north, east] = crs.adjustment ? applyPlaneAdjustment(crs.adjustment, n, e) : [n, e];
      ts.gridByName.set(text_(r, 'Name'), { north, east });
    }
  }

  const points: JxlPoint[] = [];
  const reduced = reductions ? children(reductions, 'Point') : [];

  if (reduced.length) {
    for (const p of reduced) {
      const id = text_(p, 'ID');
      const name = text_(p, 'Name');
      const record = recordsById.get(id) ?? recordsByName.get(name);
      const attributes = flatten(p);
      let features: JxlPoint['features'] = [];
      if (record) {
        for (const [k, v] of Object.entries(flatten(record))) {
          if (!(k in attributes)) attributes[`FieldBook.${k}`] = v;
        }
        features = parseFeatures(record);
      }
      points.push({
        index: points.length,
        id,
        name,
        code: text_(p, 'Code') || (record ? text_(record, 'Code') : ''),
        coords: withFallback(coordinates(p), record && recordCoords.get(record)),
        origin: 'Reductions',
        type: observationType(record ?? p),
        deleted: false,
        attributes,
        features,
      });
    }
  } else {
    for (const r of records) {
      points.push({
        index: points.length,
        id: r.getAttribute('ID') ?? '',
        name: text_(r, 'Name'),
        code: text_(r, 'Code'),
        coords: recordCoords.get(r)!,
        origin: 'FieldBook',
        type: observationType(r),
        deleted: isDeleted(r),
        attributes: flatten(r),
        features: parseFeatures(r),
      });
    }
  }

  const gridOnlyCount = points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;

  return { points, metadata: metadata(root, points, crs), gridOnlyCount, crs };
}

function metadata(root: Element, points: JxlPoint[], crs: CrsInfo): MetadataSection[] {
  const sections: MetadataSection[] = [];

  sections.push({ title: 'Datum and projection', entries: crs.entries });
  sections.push({ title: 'Job', entries: attrEntries(root).filter(([k]) => !k.startsWith('xmlns') && !k.startsWith('xsi:')) });

  const fieldBook = child(root, 'FieldBook');
  if (fieldBook) {
    const singletons: [string, string][] = [
      ['JobPropertiesRecord', 'Job properties'],
      ['CoordinateSystemRecord', 'Coordinate system'],
      ['UnitsRecord', 'Units'],
    ];
    for (const [tag, title] of singletons) {
      const els = children(fieldBook, tag);
      const el = els[els.length - 1];
      // Skip the record's own @ID / @TimeStamp bookkeeping.
      if (el) sections.push({ title, entries: Object.entries(flatten(el)).filter(([k]) => !k.startsWith('@')) });
    }
  }

  const env = child(root, 'Environment');
  if (env) {
    const entries = Object.entries(flatten(env));
    if (entries.length) sections.push({ title: 'Environment', entries });
  }

  // Summary of what's in the file.
  const summary: [string, string][] = [];
  const fbCounts = new Map<string, number>();
  if (fieldBook) {
    for (const el of Array.from(fieldBook.children)) fbCounts.set(el.tagName, (fbCounts.get(el.tagName) ?? 0) + 1);
  }
  summary.push(['Points shown', String(points.length)]);
  summary.push(['Points with WGS84 position', String(points.filter((p) => p.coords.lat !== undefined).length)]);
  const codes = new Set(points.map((p) => p.code).filter(Boolean));
  summary.push(['Distinct codes', String(codes.size)]);
  for (const type of ['GNSS', 'Total station', 'Computed', 'Keyed in', 'Other'] as ObservationType[]) {
    const n = points.filter((p) => p.type === type).length;
    if (n) summary.push([`${type} points`, String(n)]);
  }
  const reducedHere = points.filter((p) => p.coords.reduced).length;
  if (reducedHere) summary.push(['Total station shots reduced by OpenFieldView', String(reducedHere)]);

  const stamps = Array.from(root.querySelectorAll('[TimeStamp]'))
    .map((e) => e.getAttribute('TimeStamp')!)
    .filter((s) => !Number.isNaN(Date.parse(s)))
    .sort();
  if (stamps.length) {
    summary.push(['First record', stamps[0]]);
    summary.push(['Last record', stamps[stamps.length - 1]]);
  }

  const located = points.filter((p) => p.coords.lat !== undefined);
  if (located.length) {
    const lats = located.map((p) => p.coords.lat!);
    const lons = located.map((p) => p.coords.lon!);
    summary.push([
      'Bounds (W, S, E, N)',
      [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((n) => n.toFixed(7)).join(', '),
    ]);
  }
  sections.push({ title: 'Summary', entries: summary });

  if (fbCounts.size) {
    sections.push({
      title: 'FieldBook records',
      entries: [...fbCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
    });
  }

  // Empty fields are common (unused job properties etc.) and only add noise.
  return sections
    .map((s) => ({ ...s, entries: s.entries.filter(([, v]) => v !== '') }))
    .filter((s) => s.entries.length);
}

function coordinates(el: Element): Coordinates {
  const c: Coordinates = {};
  const grid = child(el, 'Grid') ?? child(el, 'ComputedGrid');
  if (grid) {
    c.north = num(grid, 'North');
    c.east = num(grid, 'East');
    c.elevation = num(grid, 'Elevation');
  }
  const wgs = child(el, 'WGS84');
  const lat = wgs ? num(wgs, 'Latitude') : undefined;
  const lon = wgs ? num(wgs, 'Longitude') : undefined;
  if (wgs && lat !== undefined && lon !== undefined) {
    c.lat = lat;
    c.lon = lon;
    c.height = num(wgs, 'Height');
    c.source = 'WGS84';
    return c;
  }
  const ecef = child(el, 'ECEF');
  if (ecef) {
    const x = num(ecef, 'X');
    const y = num(ecef, 'Y');
    const z = num(ecef, 'Z');
    if (x !== undefined && y !== undefined && z !== undefined) {
      Object.assign(c, ecefToGeodetic(x, y, z), { source: 'ECEF' });
    }
  }
  return c;
}

function withFallback(c: Coordinates, fallback: Coordinates | undefined): Coordinates {
  if (!fallback) return c;
  const out = { ...c };
  if (out.north === undefined && fallback.north !== undefined) {
    Object.assign(out, { north: fallback.north, east: fallback.east, elevation: fallback.elevation, reduced: fallback.reduced });
  }
  if (out.lat === undefined && fallback.lat !== undefined) {
    Object.assign(out, { lat: fallback.lat, lon: fallback.lon, height: fallback.height, source: fallback.source });
  }
  return out;
}

/**
 * Classify a point by how it was measured. Total station shots reference a
 * station setup and carry circle readings; GNSS shots carry ECEF or delta
 * vectors; offsets and COGO points are computed from other points. Falls back
 * to the SurveyMethod / Method text, which Reductions points also carry.
 */
export function observationType(r: Element): ObservationType {
  if (child(r, 'Circle') || child(r, 'StationID') || child(r, 'BackBearingID') || child(r, 'TargetID')) return 'Total station';
  const method = text_(r, 'Method').toLowerCase();
  if (child(r, 'Polar') || child(r, 'SourcePoint') || /intersection|offset|cogo|computed/.test(method)) return 'Computed';
  if (child(r, 'ECEFDeltas') || child(r, 'ECEF') || child(r, 'AntennaID') || child(r, 'RTK_Base') || child(r, 'QualityControl1')) {
    return 'GNSS';
  }
  const survey = text_(r, 'SurveyMethod').toLowerCase();
  if (survey.includes('keyed') || method.includes('keyed')) return 'Keyed in';
  if (/rtk|gnss|gps|static|ppk/.test(survey + ' ' + method)) return 'GNSS';
  if (/conventional|totalstation|turnedangle|direct|backsight|resection/.test(survey + ' ' + method)) return 'Total station';
  return 'Other';
}

/** Convert WGS84 ECEF (metres) to geodetic lat/lon (degrees) and ellipsoidal height. */
export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; height: number } {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const sin = Math.sin(lat);
    const n = a / Math.sqrt(1 - e2 * sin * sin);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, height: h };
}

function parseFeatures(record: Element): JxlPoint['features'] {
  const out: JxlPoint['features'] = [];
  for (const feature of Array.from(record.getElementsByTagName('Feature'))) {
    const attributes: Attrs = {};
    for (const a of children(feature, 'Attribute')) {
      const name = text_(a, 'Name');
      if (name) attributes[name] = text_(a, 'Value');
    }
    out.push({ name: feature.getAttribute('Name') ?? text_(feature, 'Name'), attributes });
  }
  return out;
}

function isDeleted(el: Element): boolean {
  return text_(el, 'Deleted').toLowerCase() === 'true';
}
