// Parser for Carlson SurvCE / SurvPC raw data files (.rw5).
//
// An RW5 file is a log of what the crew did: one record per line, a two- or
// three-letter record type, then comma-separated fields that each start with a
// two-letter tag (OP1, AR90.3015, ...). A trailing "--text" field is the
// point's description, which is its code here. Lines that start with "--" are
// notes. Angles are DDD.MMSS (or gon), distances in the file's units.
//
// Unlike JobXML, an RW5 only stores the raw observations for total station
// work, so shots are reduced to coordinates here. It also doesn't say which
// coordinate system its grid is in; the caller picks one.
//
// Records handled: JB MO OC BK LS SS TR BD BR FD FR SP GPS G0-G4, the --GS
// (local grid of a GPS point) and --HRMS quality notes, and plain -- notes.

import proj4 from 'proj4';
import { PRESETS, type CrsInfo } from './crs';
import { NAD83_TO_ITRF2020 } from './datum';
import type { Attrs, Coordinates, JxlDocument, JxlPoint, MetadataSection, ObservationType } from './jxl';
import { toMeterOf } from './projection';
import type { Prop, PropGroup } from './properties';

export type Rw5Units = 'usft' | 'ift' | 'm';

export const UNIT_LABELS: Record<Rw5Units, string> = {
  usft: 'US survey feet',
  ift: 'International feet',
  m: 'Metres',
};

const METRES: Record<Rw5Units, number> = { usft: 1200 / 3937, ift: 0.3048, m: 1 };

export interface Rw5Options {
  /** proj4 definition of the grid, and how to describe it. Defaults to CA zone 3. */
  projection?: { label: string; proj4: string; id?: string };
  /** Overrides the MO record's distance unit. */
  units?: Rw5Units;
}

/** True when the text looks like an RW5 rather than XML or a feature library. */
export function isRw5(text: string): boolean {
  const head = text.slice(0, 8192);
  if (/^\s*</.test(head)) return false;
  return /^(JB|MO|OC|BK|LS|SS|TR|SP|GPS|FD|BD),[A-Z]{2}/m.test(head);
}

interface Line {
  /** 1-based line number in the file. */
  n: number;
  raw: string;
  rec: string;
  fields: Map<string, string>;
  /** Text after "--": the point description. */
  desc: string;
}

interface Grid {
  north: number;
  east: number;
  elevation?: number;
}

/** A point built while reading the file, before conversion to JxlPoint. */
interface Draft {
  name: string;
  code: string;
  type: ObservationType;
  method: string;
  /** Grid in file units. */
  grid?: Grid;
  lat?: number;
  lon?: number;
  height?: number;
  reduced?: boolean;
  check?: boolean;
  stored: string;
  lines: Line[];
  notes: string[];
  observation: PropGroup[];
  attributes: Attrs;
}

interface Setup {
  station: string;
  at?: Grid;
  backsight?: string;
  /** Grid azimuth to the backsight, degrees. */
  bsAzimuth?: number;
  /** Circle reading on the backsight, degrees. */
  backCircle: number;
  /** Latest backsight readings in an angle set, by face. */
  setBack: { direct?: number; reverse?: number };
}

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;
/** Coefficient of refraction used with the curvature correction. */
const REFRACTION = 0.14;

export class Rw5ParseError extends Error {}

export function parseRw5(text: string, options: Rw5Options = {}): JxlDocument {
  const lines = text.split(/\r?\n/).map((raw, i) => splitLine(raw.trim(), i + 1)).filter((l): l is Line => !!l);
  if (!lines.some((l) => /^(OC|SS|TR|SP|GPS|FD)$/.test(l.rec))) {
    throw new Rw5ParseError('No points found. Is this a Carlson RW5 raw data file?');
  }

  const job: Attrs = {};
  const mode = { units: undefined as Rw5Units | undefined, south: false, scale: 1, curvature: false, gon: false, edmOffset: '' };
  const counts = new Map<string, number>();
  const jobNotes: string[] = [];
  const drafts: Draft[] = [];
  /** Best known grid of each point name, in file units. First fix wins, later shots are checks. */
  const known = new Map<string, Grid>();
  let setup: Setup | undefined;
  let hi = 0;
  let hr = 0;
  let date = '';
  /** Point that following notes and G0-G4 lines belong to. */
  let last: Draft | undefined;
  /** Angle-set records (BD FD FR BR) at the current setup, reduced once the setup ends. */
  let setRecords: { l: Line; setup: Setup; hi: number; hr: number; draft?: Draft }[] = [];

  const angle = (v: string | undefined) => parseAngle(v, mode.gon);
  const azimuth = (v: string | undefined) => {
    const a = angle(v);
    return a === undefined ? undefined : norm(mode.south ? a + 180 : a);
  };

  const flushSets = () => {
    // Each BD starts a set. Its foresights are turned from that set's
    // backsight readings, BD for face 1 and BR for face 2, which SurvCE
    // writes in the order BD FD.. FR.. BR.
    const sets = new Map<string, Draft[]>();
    let group: typeof setRecords = [];
    const reduceGroup = () => {
      const bd = group.find((r) => r.l.rec === 'BD');
      const br = group.find((r) => r.l.rec === 'BR');
      for (const r of group) {
        if (!r.draft) continue;
        const s: Setup = { ...r.setup, setBack: { direct: angle(bd?.l.fields.get('AR')), reverse: angle(br?.l.fields.get('AR')) } };
        const shot = reduce(r.l, s, { hi: r.hi, hr: r.hr, face2: r.l.rec === 'FR', ...mode, angle, azimuth, radius: EARTH_RADIUS_M / metres() });
        if (shot) {
          r.draft.grid = shot;
          r.draft.reduced = true;
        }
        const name = r.draft.name;
        sets.set(name, [...(sets.get(name) ?? []), r.draft]);
      }
      group = [];
    };
    for (const r of setRecords) {
      if (r.l.rec === 'BD' && group.some((g) => g.l.rec !== 'BD')) reduceGroup();
      group.push(r);
    }
    reduceGroup();
    setRecords = [];
    for (const [name, obs] of sets) {
      const located = obs.filter((d) => d.grid);
      const first = obs[0];
      const out: Draft = { ...first, method: `Angle set (${obs.length} observations)`, lines: obs.flatMap((d) => d.lines), notes: obs.flatMap((d) => d.notes) };
      if (located.length) {
        const mean = (f: (g: Grid) => number | undefined) => {
          const vals = located.map((d) => f(d.grid!)).filter((v): v is number => v !== undefined);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
        };
        out.grid = { north: mean((g) => g.north)!, east: mean((g) => g.east)!, elevation: mean((g) => g.elevation) };
        const spread = Math.max(...located.map((d) => Math.hypot(d.grid!.north - out.grid!.north, d.grid!.east - out.grid!.east)));
        out.observation = [
          ...first.observation,
          { title: 'Angle set', props: [{ label: 'Observations', value: obs.length }, { label: 'Largest spread from mean', value: spread * metres(), kind: 'length' }] },
        ];
        if (!known.has(name)) known.set(name, out.grid);
        else out.check = true;
      }
      drafts.push(out);
    }
  };

  // Units come from MO, which may follow other records; read it first.
  const mo = lines.find((l) => l.rec === 'MO');
  if (mo) {
    mode.units = ({ '0': 'ift', '1': 'm', '2': 'usft' } as Record<string, Rw5Units>)[mo.fields.get('UN') ?? ''];
    mode.south = mo.fields.get('AD') === '1';
    mode.scale = Number(mo.fields.get('SF')) || 1;
    mode.curvature = mo.fields.get('EC') === '1';
    mode.gon = mo.fields.get('AU') === '1';
    mode.edmOffset = mo.fields.get('EO') ?? '';
  }
  const units: Rw5Units = options.units ?? mode.units ?? 'usft';
  const metres = () => METRES[units];

  for (const l of lines) {
    counts.set(l.rec, (counts.get(l.rec) ?? 0) + 1);
    const f = (tag: string) => l.fields.get(tag);
    const n = (tag: string) => num(f(tag));

    switch (l.rec) {
      case 'JB':
        if (f('NM')) job.jobName = f('NM')!;
        if (f('DT')) job.date = date = f('DT')!;
        if (f('TM')) job.time = f('TM')!;
        last = undefined;
        break;
      case 'MO':
        last = undefined;
        break;
      case 'OC': {
        flushSets();
        const name = f('OP') ?? '';
        const north = n('N');
        const east = n('E');
        if (north !== undefined && east !== undefined) {
          const g = { north, east, elevation: n('EL') };
          if (!known.has(name)) {
            known.set(name, g);
            drafts.push(draft(l, name, 'Keyed in', 'Occupied point coordinates', date, { grid: g }));
          }
        }
        setup = { station: name, at: known.get(name), backCircle: 0, setBack: {} };
        last = undefined;
        break;
      }
      case 'BK': {
        flushSets();
        if (!setup || (f('OP') && f('OP') !== setup.station)) {
          const name = f('OP') ?? setup?.station ?? '';
          setup = { station: name, at: known.get(name), backCircle: 0, setBack: {} };
        }
        setup.backsight = f('BP');
        setup.backCircle = angle(f('BC')) ?? 0;
        setup.bsAzimuth = azimuth(f('BS'));
        const bp = setup.backsight && known.get(setup.backsight);
        if (setup.bsAzimuth === undefined && bp && setup.at) {
          setup.bsAzimuth = norm(Math.atan2(bp.east - setup.at.east, bp.north - setup.at.north) / RAD);
        }
        last = undefined;
        break;
      }
      case 'LS':
        if (f('HI') !== undefined) hi = n('HI') ?? 0;
        if (f('HR') !== undefined) hr = n('HR') ?? 0;
        last = undefined;
        break;
      case 'SS':
      case 'TR':
      case 'FD':
      case 'FR':
      case 'BD':
      case 'BR': {
        const name = f('FP') ?? '';
        const rod = n('HR') ?? hr;
        if (l.rec === 'BD' || l.rec === 'BR') {
          if (setup) setRecords.push({ l, setup: { ...setup }, hi, hr: rod });
          last = undefined;
          break;
        }
        const d = draft(l, name, 'Total station', (({ SS: 'Side shot', TR: 'Traverse' }) as Record<string, string>)[l.rec] ?? 'Angle set', date);
        d.observation = [observationGroup(l, setup, hi, rod, mode.gon, metres())];
        if (l.rec === 'FD' || l.rec === 'FR') {
          if (setup) setRecords.push({ l, setup: { ...setup }, hi, hr: rod, draft: d });
        } else {
          const shot = setup && reduce(l, setup, { hi, hr: rod, face2: false, ...mode, angle, azimuth, radius: EARTH_RADIUS_M / metres() });
          if (shot) {
            d.grid = shot;
            d.reduced = true;
          }
          if (shot) {
            if (known.has(name)) d.check = true;
            else known.set(name, shot);
          }
          drafts.push(d);
        }
        last = d;
        break;
      }
      case 'SP': {
        flushSets();
        const name = f('PN') ?? '';
        const north = n('N');
        const east = n('E');
        const d = draft(l, name, 'Keyed in', 'Stored point', date);
        if (north !== undefined && east !== undefined) {
          d.grid = { north, east, elevation: n('EL') };
          known.set(name, d.grid);
        }
        drafts.push(d);
        last = d;
        break;
      }
      case 'GPS': {
        flushSets();
        const name = f('PN') ?? '';
        const d = draft(l, name, 'GNSS', 'GPS position', date);
        // GPS lat/long are DD.MMSSssss, not decimal degrees.
        d.lat = parseAngle(f('LA'), false);
        d.lon = parseAngle(f('LN'), false);
        d.height = n('EL');
        d.observation = [{ title: 'GNSS', props: [] }];
        drafts.push(d);
        last = d;
        break;
      }
      case 'G0':
      case 'G1':
      case 'G2':
      case 'G3':
      case 'G4':
        if (last?.type === 'GNSS') gnssLine(last, l);
        break;
      case '--': {
        const note = l.desc;
        const gs = note.match(/^GS,(.*)$/);
        if (gs) {
          // Local grid of the GPS point just stored (through any localization).
          const g = splitLine(`GS,${gs[1]}`, l.n)!;
          const pn = g.fields.get('PN');
          const target = last?.type === 'GNSS' && last.name === pn ? last : [...drafts].reverse().find((d) => d.type === 'GNSS' && d.name === pn);
          const north = num(g.fields.get('N'));
          const east = num(g.fields.get('E'));
          if (target && north !== undefined && east !== undefined) {
            target.grid = { north, east, elevation: num(g.fields.get('EL')) };
            target.lines.push(l);
            known.set(target.name, target.grid);
            if (!target.code && g.desc) target.code = g.desc;
          }
          break;
        }
        if (last?.type === 'GNSS' && /^(HRMS|VRMS|STATUS|SATS|PDOP)\b/i.test(note)) {
          gnssQualityNote(last, note);
          last.lines.push(l);
          break;
        }
        if (last) last.notes.push(note);
        else if (note) jobNotes.push(note);
        break;
      }
      default:
        last = undefined;
    }
  }
  flushSets();

  const projection = options.projection ?? { label: PRESETS[0].label, proj4: PRESETS[0].proj4, id: PRESETS[0].id };
  const scale = metres();
  const points: JxlPoint[] = drafts.map((d, index) => toPoint(d, index, scale));
  const localization = localize(points, projection.proj4);

  const crs = rw5Crs(projection, units, mode.units, localization, mo?.fields.has('SF') ? mode.scale : undefined);
  const gridOnlyCount = points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;
  return {
    points,
    metadata: metadata(job, points, crs, mode, units, counts, jobNotes),
    gridOnlyCount,
    crs,
    job,
    format: 'rw5',
  };
}

function draft(l: Line, name: string, type: ObservationType, method: string, stored: string, extra: Partial<Draft> = {}): Draft {
  const attributes: Attrs = { Record: l.rec };
  for (const [k, v] of l.fields) attributes[k] = v;
  if (l.desc) attributes.Description = l.desc;
  return { name, code: l.desc, type, method, stored, lines: [l], notes: [], observation: [], attributes, ...extra };
}

interface ReduceContext {
  hi: number;
  hr: number;
  face2: boolean;
  scale: number;
  curvature: boolean;
  radius: number;
  angle: (v: string | undefined) => number | undefined;
  azimuth: (v: string | undefined) => number | undefined;
}

/** Grid of a total station shot from the current setup, in file units. */
function reduce(l: Line, s: Setup, c: ReduceContext): Grid | undefined {
  if (!s.at) return undefined;
  const f = (tag: string) => l.fields.get(tag);
  const az = direction(l, s, c);
  if (az === undefined) return undefined;

  // Zenith angle; face 2 readings are 360 - zenith.
  let zenith = c.angle(f('ZE'));
  if (zenith === undefined && f('VA') !== undefined) zenith = 90 - c.angle(f('VA'))!;
  if (zenith !== undefined && c.face2 && zenith > 180) zenith = 360 - zenith;
  const sd = num(f('SD'));
  let hd = num(f('HD'));
  let vd: number | undefined;
  if (sd !== undefined) {
    const z = (zenith ?? 90) * RAD;
    hd = sd * Math.sin(z);
    vd = zenith === undefined ? undefined : sd * Math.cos(z);
  } else if (hd !== undefined && zenith !== undefined && Math.abs(Math.sin(zenith * RAD)) > 1e-9) {
    vd = hd / Math.tan(zenith * RAD);
  }
  if (f('CE') !== undefined) vd = num(f('CE'));
  if (hd === undefined) return undefined;
  if (c.curvature && vd !== undefined && f('CE') === undefined) vd += ((1 - REFRACTION) * hd * hd) / (2 * c.radius);
  hd *= c.scale;

  const grid: Grid = {
    north: s.at.north + hd * Math.cos(az * RAD),
    east: s.at.east + hd * Math.sin(az * RAD),
  };
  if (s.at.elevation !== undefined && vd !== undefined) {
    // A CE value is already the change in elevation to the ground.
    grid.elevation = f('CE') !== undefined ? s.at.elevation + vd : s.at.elevation + c.hi + vd - c.hr;
  }
  return grid;
}

/** Grid azimuth of a shot, degrees. */
function direction(l: Line, s: Setup, c: ReduceContext): number | undefined {
  const f = (tag: string) => l.fields.get(tag);
  if (f('AZ') !== undefined) return c.azimuth(f('AZ'));
  if (f('BR') !== undefined) return bearing(f('BR')!, c.angle);
  const bs = s.bsAzimuth;
  if (bs === undefined) return undefined;
  const ar = c.angle(f('AR'));
  if (ar !== undefined) {
    // AR is the circle reading; the backsight reading is BC, or BD/BR in a set.
    const back = l.rec === 'FR' ? (s.setBack.reverse ?? norm(s.backCircle + 180)) : l.rec === 'FD' ? (s.setBack.direct ?? s.backCircle) : s.backCircle;
    return norm(bs + ar - back);
  }
  const al = c.angle(f('AL'));
  if (al !== undefined) return norm(bs - al);
  const dr = c.angle(f('DR'));
  if (dr !== undefined) return norm(bs + 180 + dr);
  const dl = c.angle(f('DL'));
  if (dl !== undefined) return norm(bs + 180 - dl);
  return undefined;
}

/** "N12.3456E" → azimuth in degrees. */
function bearing(v: string, angle: (v: string) => number | undefined): number | undefined {
  const m = v.trim().match(/^([NS])\s*([\d.]+)\s*([EW])$/i);
  if (!m) return undefined;
  const a = angle(m[2]);
  if (a === undefined) return undefined;
  const ns = m[1].toUpperCase();
  const ew = m[3].toUpperCase();
  if (ns === 'N') return ew === 'E' ? a : norm(360 - a);
  return ew === 'E' ? 180 - a : 180 + a;
}

function observationGroup(l: Line, s: Setup | undefined, hi: number, hr: number, gon: boolean, metres: number): PropGroup {
  const props: Prop[] = [];
  const f = (tag: string) => l.fields.get(tag);
  const ang = (tag: string, label: string) => {
    const a = parseAngle(f(tag), gon);
    if (a !== undefined) props.push({ label, value: a, kind: 'angle' });
  };
  const len = (tag: string, label: string) => {
    const v = num(f(tag));
    if (v !== undefined) props.push({ label, value: v * metres, kind: 'length' });
  };
  if (s) props.push({ label: 'Station', value: s.station });
  if (s?.backsight) props.push({ label: 'Backsight', value: s.backsight });
  if (s?.bsAzimuth !== undefined) props.push({ label: 'Backsight azimuth', value: s.bsAzimuth, kind: 'angle' });
  ang('AR', 'Angle right (circle)');
  ang('AL', 'Angle left');
  ang('DR', 'Deflection right');
  ang('DL', 'Deflection left');
  ang('AZ', 'Azimuth');
  if (f('BR')) props.push({ label: 'Bearing', value: f('BR')! });
  ang('ZE', 'Zenith angle');
  ang('VA', 'Vertical angle');
  len('SD', 'Slope distance');
  len('HD', 'Horizontal distance');
  len('CE', 'Change in elevation');
  props.push({ label: 'Instrument height', value: hi * metres, kind: 'length' });
  props.push({ label: 'Rod height', value: hr * metres, kind: 'length' });
  if (!s?.at) props.push({ label: 'Not reduced', value: 'The station has no coordinates' });
  else if (s.bsAzimuth === undefined && !f('AZ') && !f('BR')) props.push({ label: 'Not reduced', value: 'No backsight azimuth' });
  return { title: 'Total station observation', props };
}

function gnssLine(d: Draft, l: Line) {
  d.lines.push(l);
  const group = d.observation[0];
  const f = (tag: string) => l.fields.get(tag);
  switch (l.rec) {
    case 'G0':
      // "G0,07/28/2011 11:55:10,(Average) - Base ID read at rover: 0000"
      group.props.push({ label: 'Solution', value: l.raw.slice(3).replace(/^'/, '') });
      break;
    case 'G1':
      if (f('BP')) group.props.push({ label: 'Base point', value: f('BP')! });
      for (const k of ['DX', 'DY', 'DZ']) if (num(f(k)) !== undefined) group.props.push({ label: `Vector ${k}`, value: num(f(k))!, kind: 'length' });
      break;
    default:
      for (const [k, v] of l.fields) group.props.push({ label: `${l.rec} ${k}`, value: v });
  }
  for (const [k, v] of l.fields) d.attributes[`${l.rec}.${k}`] = v;
}

function gnssQualityNote(d: Draft, note: string) {
  const group = d.observation[0];
  const labels: Record<string, string> = { HRMS: 'Horizontal RMS', VRMS: 'Vertical RMS', STATUS: 'Solution', SATS: 'Satellites', PDOP: 'PDOP', HDOP: 'HDOP', VDOP: 'VDOP' };
  for (const part of note.split(',')) {
    const m = part.match(/^\s*([A-Z]+)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    d.attributes[`Quality.${key}`] = m[2];
    const label = labels[key] ?? key;
    // HRMS and VRMS are metres in SurvCE's quality line.
    if ((key === 'HRMS' || key === 'VRMS') && num(m[2]) !== undefined) group.props.push({ label, value: num(m[2])!, kind: 'length' });
    else group.props.push({ label, value: m[2] });
  }
}

function toPoint(d: Draft, index: number, metres: number): JxlPoint {
  const coords: Coordinates = {};
  if (d.grid) {
    coords.north = d.grid.north * metres;
    coords.east = d.grid.east * metres;
    if (d.grid.elevation !== undefined) coords.elevation = d.grid.elevation * metres;
    if (d.reduced) coords.reduced = true;
  }
  if (d.lat !== undefined && d.lon !== undefined) {
    coords.lat = d.lat;
    coords.lon = d.lon;
    coords.height = d.height;
    coords.source = 'WGS84';
  }
  const observation = d.observation.filter((g) => g.props.length);
  if (d.notes.length) observation.push({ title: 'Notes', props: d.notes.map((n) => ({ label: 'Note', value: n })) });
  observation.push({ title: 'Raw data', props: d.lines.map((l) => ({ label: `Line ${l.n}`, value: l.raw })) });
  return {
    index,
    id: String(d.lines[0].n),
    name: d.name,
    code: d.code,
    coords,
    origin: 'FieldBook',
    type: d.type,
    deleted: false,
    attributes: d.attributes,
    features: [],
    method: d.method,
    surveyMethod: '',
    classification: d.check ? 'Check shot' : '',
    stored: d.stored,
    observation,
  };
}

export interface Localization {
  pairs: number;
  /** Root mean square misfit of the GPS points, metres. */
  rms: number;
  scale: number;
  /** Degrees, local grid to projection grid, counter-clockwise. */
  rotation: number;
  placed: number;
}

/**
 * Place grid-only points through the GPS points that have both lat/long and
 * a local grid (--GS). That covers jobs on assumed coordinates that were
 * localized in the field: a 2D similarity from the local grid to the chosen
 * projection is fitted to those points.
 */
function localize(points: JxlPoint[], def: string): Localization | undefined {
  const both = points.filter((p) => p.coords.lat !== undefined && p.coords.north !== undefined);
  const gridOnly = points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined);
  if (both.length < 2 || !gridOnly.length) return undefined;
  let toGrid: proj4.Converter;
  try {
    toGrid = proj4('EPSG:4326', def);
  } catch {
    return undefined;
  }
  const unit = toMeterOf(def);
  const pairs = both.map((p) => {
    const [x, y] = toGrid.forward([p.coords.lon!, p.coords.lat!]);
    return { from: [p.coords.east!, p.coords.north!] as const, to: [x * unit, y * unit] as const };
  });
  const fit = fitSimilarity(pairs);
  if (!fit || fit.rms > 0.15) return undefined;
  for (const p of gridOnly) {
    const [x, y] = fit.apply(p.coords.east!, p.coords.north!);
    const [lon, lat] = toGrid.inverse([x / unit, y / unit]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    p.coords.lat = lat;
    p.coords.lon = lon;
    p.coords.source = 'Localized';
  }
  return { pairs: pairs.length, rms: fit.rms, scale: fit.scale, rotation: fit.rotation, placed: gridOnly.length };
}

/** Least-squares 2D similarity (Helmert) transformation. */
export function fitSimilarity(pairs: { from: readonly [number, number]; to: readonly [number, number] }[]) {
  const n = pairs.length;
  const mean = (f: (p: (typeof pairs)[0]) => number) => pairs.reduce((s, p) => s + f(p), 0) / n;
  const fx = mean((p) => p.from[0]);
  const fy = mean((p) => p.from[1]);
  const tx = mean((p) => p.to[0]);
  const ty = mean((p) => p.to[1]);
  let sxx = 0;
  let sab = 0;
  let sba = 0;
  for (const p of pairs) {
    const x = p.from[0] - fx;
    const y = p.from[1] - fy;
    const u = p.to[0] - tx;
    const v = p.to[1] - ty;
    sxx += x * x + y * y;
    sab += x * u + y * v;
    sba += x * v - y * u;
  }
  if (sxx < 1) return undefined;
  const a = sab / sxx;
  const b = sba / sxx;
  const apply = (x: number, y: number): [number, number] => [tx + a * (x - fx) - b * (y - fy), ty + b * (x - fx) + a * (y - fy)];
  const rms = Math.sqrt(pairs.reduce((s, p) => {
    const [u, v] = apply(p.from[0], p.from[1]);
    return s + (u - p.to[0]) ** 2 + (v - p.to[1]) ** 2;
  }, 0) / n);
  return { apply, rms, scale: Math.hypot(a, b), rotation: Math.atan2(b, a) / RAD };
}

function rw5Crs(
  projection: NonNullable<Rw5Options['projection']>,
  units: Rw5Units,
  fileUnits: Rw5Units | undefined,
  loc: Localization | undefined,
  scale: number | undefined,
): CrsInfo {
  // GRS80 grids in North America are NAD83; anything else is left unshifted.
  const nad83 = /ellps=GRS80|NAD83/i.test(projection.proj4) || projection.label.includes('NAD83');
  const entries: [string, string][] = [
    ['Coordinate system', `${projection.label} (chosen in OpenFieldView; RW5 files don't record it)`],
    ['Distance units', `${UNIT_LABELS[units]}${fileUnits && fileUnits !== units ? ` (file says ${UNIT_LABELS[fileUnits]})` : fileUnits ? '' : ' (not stated in the file)'}`],
  ];
  if (loc) {
    entries.push([
      'Localization from GPS points',
      `${loc.pairs} points, ${loc.rms.toFixed(3)} m RMS, rotation ${dmsString(loc.rotation)}, scale ${loc.scale.toFixed(6)}; placed ${loc.placed} grid points`,
    ]);
  }
  if (nad83) entries.push(['NAD83 → WGS84 for the map', 'NAD83(2011) → ITRF2014 → ITRF2020 (≈ WGS84 G2296)']);
  return {
    systemName: '',
    zoneName: '',
    datumName: nad83 ? 'NAD83(2011)' : '',
    referenceFrame: nad83 ? 'NAD83(2011)' : '',
    epochs: [],
    distanceUnits: UNIT_LABELS[units],
    projection,
    // Distances measured on the ground were multiplied by it to put them on the grid.
    scaleFactor: scale !== undefined ? { value: scale, name: 'scale factor (SF in the MO record)' } : undefined,
    nad83,
    datumChain: nad83 ? NAD83_TO_ITRF2020 : [],
    entries,
  };
}

function metadata(
  job: Attrs,
  points: JxlPoint[],
  crs: CrsInfo,
  mode: { south: boolean; scale: number; curvature: boolean; gon: boolean; edmOffset: string },
  units: Rw5Units,
  counts: Map<string, number>,
  notes: string[],
): MetadataSection[] {
  const sections: MetadataSection[] = [{ title: 'Coordinate system', entries: crs.entries }];
  const jobEntries: [string, string][] = [['Format', 'Carlson raw data (RW5)']];
  if (job.jobName) jobEntries.push(['Job name', job.jobName]);
  if (job.date) jobEntries.push(['Date', [job.date, job.time].filter(Boolean).join(' ')]);
  sections.push({ title: 'Job', entries: jobEntries });
  sections.push({
    title: 'Mode (MO record)',
    entries: [
      ['Distance units', UNIT_LABELS[units]],
      ['Angle units', mode.gon ? 'Gon' : 'Degrees'],
      ['Azimuths from', mode.south ? 'South' : 'North'],
      ['Scale factor', String(mode.scale)],
      ['Earth curvature and refraction', mode.curvature ? 'Applied' : 'Off'],
      ['EDM offset (in)', mode.edmOffset],
    ],
  });
  const summary: [string, string][] = [['Points shown', String(points.length)]];
  for (const type of ['GNSS', 'Total station', 'Keyed in'] as ObservationType[]) {
    const n = points.filter((p) => p.type === type).length;
    if (n) summary.push([`${type} points`, String(n)]);
  }
  const reduced = points.filter((p) => p.coords.reduced).length;
  if (reduced) summary.push(['Total station shots reduced by OpenFieldView', String(reduced)]);
  const checks = points.filter((p) => p.classification === 'Check shot').length;
  if (checks) summary.push(['Check shots (did not move the point)', String(checks)]);
  const unreduced = points.filter((p) => p.type === 'Total station' && p.coords.north === undefined).length;
  if (unreduced) summary.push(['Shots that could not be reduced', String(unreduced)]);
  summary.push(['Distinct codes', String(new Set(points.map((p) => p.code).filter(Boolean)).size)]);
  sections.push({ title: 'Summary', entries: summary });
  if (notes.length) sections.push({ title: 'Notes', entries: notes.map((n, i) => [String(i + 1), n]) });
  sections.push({
    title: 'Records',
    entries: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k === '--' ? 'Notes (--)' : k, String(v)]),
  });
  return sections.map((s) => ({ ...s, entries: s.entries.filter(([, v]) => v !== '') })).filter((s) => s.entries.length);
}

function splitLine(raw: string, n: number): Line | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('--')) return { n, raw, rec: '--', fields: new Map(), desc: raw.slice(2).trim() };
  const parts = raw.split(',');
  const rec = parts[0].trim().toUpperCase();
  const fields = new Map<string, string>();
  let desc = '';
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.trimStart().startsWith('--')) {
      desc = parts.slice(i).join(',').trimStart().slice(2).trim();
      break;
    }
    const t = p.trim();
    // Northing and easting have one-letter tags and a space: "N 5000.000".
    const ne = t.match(/^([NE])\s+(.*)$/i);
    if (ne) fields.set(ne[1].toUpperCase(), ne[2].trim());
    else if (t.length >= 2 && /^[A-Z]{2}/i.test(t)) fields.set(t.slice(0, 2).toUpperCase(), t.slice(2).trim());
  }
  return { n, raw, rec, fields, desc };
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

/** DDD.MMSSsss (or decimal gon) to decimal degrees. */
export function parseAngle(v: string | undefined, gon: boolean): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!/^[-+]?\d*\.?\d*$/.test(s) || !/\d/.test(s)) return undefined;
  if (gon) return Number(s) * 0.9;
  const neg = s.startsWith('-');
  const [d, frac = ''] = s.replace(/^[-+]/, '').split('.');
  const mm = Number(frac.slice(0, 2).padEnd(2, '0'));
  const ssRaw = frac.slice(2);
  const ss = ssRaw ? Number(`${ssRaw.slice(0, 2).padEnd(2, '0')}.${ssRaw.slice(2)}`) : 0;
  const deg = Number(d || 0) + mm / 60 + ss / 3600;
  return neg ? -deg : deg;
}

function norm(a: number): number {
  return ((a % 360) + 360) % 360;
}

function dmsString(deg: number): string {
  const sign = deg < 0 ? '-' : '';
  let s = Math.abs(deg) * 3600;
  const d = Math.floor(s / 3600);
  s -= d * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${sign}${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}
