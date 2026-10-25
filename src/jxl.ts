// Parser for Trimble JobXML (.jxl) files.
//
// JobXML stores all distances in metres and all angles/geodetic coordinates in
// decimal degrees, regardless of the units shown in the field software.

export type Attrs = Record<string, string>;

export interface Coordinates {
  lat?: number;
  lon?: number;
  height?: number;
  north?: number;
  east?: number;
  elevation?: number;
  /** Where the lat/lon came from. */
  source?: 'WGS84' | 'ECEF' | 'Grid';
}

export interface JxlPoint {
  /** Stable index into JxlDocument.points. */
  index: number;
  id: string;
  name: string;
  code: string;
  coords: Coordinates;
  /** Where the point came from in the file. */
  origin: 'Reductions' | 'FieldBook';
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
}

export class JxlParseError extends Error {}

export function parseJxl(text: string): JxlDocument {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const err = xml.getElementsByTagName('parsererror')[0];
  if (err) throw new JxlParseError(`Not valid XML: ${err.textContent?.trim().split('\n')[0] ?? ''}`);
  const root = xml.documentElement;
  if (root.tagName !== 'JOBFile') {
    throw new JxlParseError(`Expected a <JOBFile> root element, found <${root.tagName}>. Is this a Trimble JobXML file?`);
  }

  const fieldBook = child(root, 'FieldBook');
  const reductions = child(root, 'Reductions');

  const records = fieldBook ? children(fieldBook, 'PointRecord') : [];
  const recordsById = new Map<string, Element>();
  const recordsByName = new Map<string, Element>();
  for (const r of records) {
    const id = r.getAttribute('ID');
    if (id) recordsById.set(id, r);
    // Later records with the same name supersede earlier ones.
    if (!isDeleted(r)) recordsByName.set(text_(r, 'Name'), r);
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
        coords: withFallback(coordinates(p), record && coordinates(record)),
        origin: 'Reductions',
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
        coords: coordinates(r),
        origin: 'FieldBook',
        deleted: isDeleted(r),
        attributes: flatten(r),
        features: parseFeatures(r),
      });
    }
  }

  const gridOnlyCount = points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;

  return { points, metadata: metadata(root, points), gridOnlyCount };
}

function metadata(root: Element, points: JxlPoint[]): MetadataSection[] {
  const sections: MetadataSection[] = [];

  sections.push({ title: 'Job', entries: attrEntries(root) });

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
      if (el) sections.push({ title, entries: Object.entries(flatten(el)) });
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

  return sections;
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
  if (c.lat !== undefined || !fallback || fallback.lat === undefined) return c;
  return { ...c, lat: fallback.lat, lon: fallback.lon, height: fallback.height, source: fallback.source };
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

/**
 * Flatten an element's subtree into dotted keys. XML attributes become
 * `path@attr`, repeated siblings get a `[n]` suffix.
 */
export function flatten(el: Element): Attrs {
  const out: Attrs = {};
  for (const [k, v] of attrEntries(el)) out[`@${k}`] = v;
  walk(el, '', out);
  return out;
}

function walk(el: Element, prefix: string, out: Attrs) {
  const kids = Array.from(el.children);
  const totals = new Map<string, number>();
  for (const k of kids) totals.set(k.tagName, (totals.get(k.tagName) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const k of kids) {
    const n = seen.get(k.tagName) ?? 0;
    seen.set(k.tagName, n + 1);
    const key = prefix + k.tagName + (totals.get(k.tagName)! > 1 ? `[${n + 1}]` : '');
    for (const [a, v] of attrEntries(k)) out[`${key}@${a}`] = v;
    if (k.children.length) walk(k, key + '.', out);
    else {
      const t = k.textContent?.trim() ?? '';
      if (t || !k.attributes.length) out[key] = t;
    }
  }
}

function attrEntries(el: Element): [string, string][] {
  return Array.from(el.attributes).map((a) => [a.name, a.value]);
}

function child(el: Element, tag: string): Element | undefined {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return undefined;
}

function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

function text_(el: Element, tag: string): string {
  return child(el, tag)?.textContent?.trim() ?? '';
}

function num(el: Element, tag: string): number | undefined {
  const t = text_(el, tag);
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function isDeleted(el: Element): boolean {
  return text_(el, 'Deleted').toLowerCase() === 'true';
}
