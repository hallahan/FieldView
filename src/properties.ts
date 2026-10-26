// How a point was measured, grouped like the Properties pane in Trimble
// Business Center: GNSS quality, antenna, tilt, total station observation,
// computed-point inputs and notes. Values stay in JobXML units (metres and
// decimal degrees); formatProp converts them for display.

import { child, children, num, text_ } from './xml';

export interface Prop {
  label: string;
  value: string | number;
  /** length: metres, shown in the job's units. angle: degrees, shown as DMS. html: markup built by the app. */
  kind?: 'length' | 'angle' | 'html';
  /** What the field means, such as the FXL attribute description. */
  hint?: string;
  /** Opens a point (its index) or a line (its fid) when the row is tapped. */
  link?: { point: number } | { line: number };
}

export interface PropGroup {
  title: string;
  props: Prop[];
  /** A sentence or two under the rows, such as what its distances mean. */
  note?: string;
}

/**
 * FieldBook records by tag and ID attribute, for following AntennaID etc.
 * Keyed by tag too, since not every writer keeps IDs unique across record types.
 */
export class RecordIndex {
  private byKey = new Map<string, Element>();
  constructor(fieldBook: Element | undefined) {
    for (const el of fieldBook ? Array.from(fieldBook.children) : []) {
      const id = el.getAttribute('ID');
      if (id) this.byKey.set(`${el.tagName}#${id}`, el);
    }
  }
  get(tag: string, id: string): Element | undefined {
    return id ? this.byKey.get(`${tag}#${id}`) : undefined;
  }
}

const METHODS: Record<string, string> = {
  GpsStaticObservation: 'GNSS observation',
  MeanTurnedAngle: 'Mean turned angle',
  BearingDistancePointIntersection: 'Bearing-distance from a point',
  Coordinates: 'Keyed-in coordinates',
  FromBase: 'From base',
};

/** "NetworkRTK" → "Network RTK", "KeyedIn" → "Keyed in". */
export function humanize(s: string): string {
  if (METHODS[s]) return METHODS[s];
  const words = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ');
  return words.map((w, i) => (i && !/^[A-Z0-9]{2,}$/.test(w) ? w.toLowerCase() : w)).join(' ');
}

export function observationProperties(record: Element | undefined, records: RecordIndex): PropGroup[] {
  if (!record) return [];
  const groups: PropGroup[] = [gnssQuality(record), antenna(record, records), tilt(record), totalStation(record, records), computed(record), notes(record)];
  return groups.filter((g) => g.props.length);
}

function gnssQuality(r: Element): PropGroup {
  const props: Prop[] = [];
  const precision = child(r, 'Precision');
  if (precision) {
    length(props, 'Horizontal precision', num(precision, 'Horizontal'));
    length(props, 'Vertical precision', num(precision, 'Vertical'));
  }
  const qc = child(r, 'QualityControl1');
  if (qc) {
    const total = num(qc, 'NumberOfSatellites');
    if (total !== undefined) {
      const systems = (
        [
          ['GPS', 'NumGPSSVs'],
          ['GLONASS', 'NumGLONASSSVs'],
          ['Galileo', 'NumGalileoSVs'],
          ['BeiDou', 'NumBeiDouSVs'],
          ['QZSS', 'NumQZSSSVs'],
          ['NavIC', 'NumNavICSVs'],
        ] as const
      )
        .map(([name, tag]) => [name, num(qc, tag)] as const)
        .filter(([, n]) => n)
        .map(([name, n]) => `${name} ${n}`);
      props.push({ label: 'Satellites', value: `${total}${systems.length ? ` (${systems.join(', ')})` : ''}` });
    }
    for (const dop of ['PDOP', 'HDOP', 'VDOP', 'GDOP']) {
      const v = num(qc, dop);
      if (v !== undefined) props.push({ label: dop, value: v.toFixed(1) });
    }
    const epochs = num(qc, 'NumberOfPositionsUsed');
    if (epochs !== undefined) props.push({ label: 'Epochs', value: String(epochs) });
    const span = duration(qc);
    if (span !== undefined) props.push({ label: 'Occupation', value: `${span} s` });
    const age = num(qc, 'RTCMAge');
    if (age !== undefined) props.push({ label: 'Correction age', value: `${age.toFixed(1)} s` });
    const monitor = text_(qc, 'MonitorStatus');
    if (monitor && monitor !== 'NotMonitored') props.push({ label: 'Monitor status', value: humanize(monitor) });
    const warnings = child(qc, 'Warnings');
    if (warnings) {
      // Only warnings that were active when the point was stored, as the field crew saw them.
      const active = Array.from(warnings.children)
        .filter((w) => w.tagName.endsWith('AtStorage') && w.textContent?.trim() === 'Yes')
        .map((w) => humanize(w.tagName.replace(/(Warning)?AtStorage$/, '')));
      props.push({ label: 'Warnings at storage', value: active.length ? active.join(', ') : 'None' });
    }
  }
  const base = text_(r, 'RTK_Base');
  if (base) props.push({ label: 'RTK base', value: base });
  return { title: 'GNSS quality', props };
}

/** Seconds between QC1 StartTime and EndTime, counting GPS week rollovers. */
function duration(qc: Element): number | undefined {
  const t = (tag: string) => {
    const el = child(qc, tag);
    const week = el && num(el, 'GPSWeek');
    const s = el && num(el, 'Seconds');
    return week !== undefined && s !== undefined ? week * 604800 + s : undefined;
  };
  const start = t('StartTime');
  const end = t('EndTime');
  return start !== undefined && end !== undefined ? Math.round((end - start) * 10) / 10 : undefined;
}

function antenna(r: Element, records: RecordIndex): PropGroup {
  const props: Prop[] = [];
  const ant = records.get('AntennaRecord', text_(r, 'AntennaID'));
  if (ant) {
    length(props, 'Antenna height', num(ant, 'MeasuredHeight'));
    const method = text_(ant, 'MeasurementType');
    const equipment = records.get('GPSEquipmentRecord', text_(ant, 'GPSEquipmentID'));
    const type = equipment ? text_(equipment, 'AntennaType') : '';
    if (type) props.push({ label: 'Antenna type', value: type });
    const measuredTo = equipment ? text_(equipment, 'AntennaMeasurementMethod') : '';
    if (measuredTo || method) props.push({ label: 'Measured to', value: [measuredTo, method && humanize(method)].filter(Boolean).join(', ') });
  }
  return { title: 'Antenna', props };
}

function tilt(r: Element): PropGroup {
  const props: Prop[] = [];
  const axis = child(r, 'DeviceAxisOrientation');
  if (axis) {
    const type = text_(axis, 'Type');
    if (type) props.push({ label: 'Tilt method', value: type === 'InertialTiltComp' ? 'IMU tilt compensation' : humanize(type) });
    const attitude = child(axis, 'Attitude');
    const pitch = attitude && num(attitude, 'Pitch');
    const roll = attitude && num(attitude, 'Roll');
    if (pitch !== undefined && roll !== undefined) {
      // Tilt of the pole from vertical.
      const t = Math.acos(Math.cos((pitch * Math.PI) / 180) * Math.cos((roll * Math.PI) / 180));
      props.push({ label: 'Pole tilt', value: `${((t * 180) / Math.PI).toFixed(2)}°` });
      props.push({ label: 'Pitch / roll', value: `${pitch.toFixed(2)}° / ${roll.toFixed(2)}°` });
    }
    const state = text_(axis, 'IMUAlignmentState');
    if (state) props.push({ label: 'IMU alignment', value: humanize(state) });
  }
  return { title: 'Tilt', props };
}

function totalStation(r: Element, records: RecordIndex): PropGroup {
  const props: Prop[] = [];
  const station = records.get('StationRecord', text_(r, 'StationID'));
  if (station) {
    props.push({ label: 'Station', value: text_(station, 'StationName') });
    length(props, 'Instrument height', num(station, 'TheodoliteHeight'));
  }
  const bb = records.get('BackBearingRecord', text_(r, 'BackBearingID'));
  if (bb && text_(bb, 'BackSight')) props.push({ label: 'Backsight', value: text_(bb, 'BackSight') });
  const circle = child(r, 'Circle');
  if (circle) {
    const ha = num(circle, 'HorizontalCircle');
    const va = num(circle, 'VerticalCircle');
    const sd = num(circle, 'EDMDistance');
    if (ha !== undefined) props.push({ label: 'Horizontal angle', value: ha, kind: 'angle' });
    if (va !== undefined) props.push({ label: 'Vertical angle', value: va, kind: 'angle' });
    length(props, 'Slope distance', sd);
    if (sd !== undefined && va !== undefined) {
      length(props, 'Horizontal distance', sd * Math.sin((va * Math.PI) / 180));
      length(props, 'Vertical distance', sd * Math.cos((va * Math.PI) / 180));
    }
    const face = text_(circle, 'Face');
    if (face) props.push({ label: 'Face', value: face.replace('Face', 'Face ') });
  }
  const target = records.get('TargetRecord', text_(r, 'TargetID'));
  if (target) {
    length(props, 'Target height', num(target, 'TargetHeight'));
    const pc = num(target, 'PrismConstant');
    if (pc !== undefined) props.push({ label: 'Prism constant', value: `${(pc * 1000).toFixed(1)} mm` });
  }
  return { title: 'Total station', props };
}

function computed(r: Element): PropGroup {
  const props: Prop[] = [];
  const source = text_(r, 'SourcePoint');
  if (source) props.push({ label: 'From point', value: source });
  const polar = child(r, 'Polar');
  if (polar) {
    const az = num(polar, 'Azimuth');
    if (az !== undefined) props.push({ label: `Azimuth${text_(r, 'AzimuthType') ? ` (${text_(r, 'AzimuthType')})` : ''}`, value: az, kind: 'angle' });
    length(props, `Horizontal distance${text_(r, 'DistanceType') ? ` (${text_(r, 'DistanceType').toLowerCase()})` : ''}`, num(polar, 'HorizontalDistance'));
    length(props, 'Vertical distance', num(polar, 'VerticalDistance'));
  }
  return { title: 'Computed from', props };
}

function notes(r: Element): PropGroup {
  const el = child(r, 'Notes');
  const lines = el ? children(el, 'Note').map((n) => n.textContent?.trim() ?? '').filter(Boolean) : [];
  return { title: 'Notes', props: lines.map((n, i) => ({ label: `Note ${i + 1}`, value: n })) };
}

function length(props: Prop[], label: string, metres: number | undefined) {
  if (metres !== undefined) props.push({ label, value: metres, kind: 'length' });
}

export interface Unit {
  label: string;
  metres: number;
}

/** The unit a job's distance units name, such as USSurveyFeet. */
export function unitOf(distanceUnits: string | undefined): Unit {
  const u = (distanceUnits ?? '').toLowerCase();
  if (u.includes('survey')) return { label: 'sft', metres: 1200 / 3937 };
  if (u.includes('feet') || u.includes('foot')) return { label: 'ift', metres: 0.3048 };
  return { label: 'm', metres: 1 };
}

export function formatProp(p: Prop, unit: Unit): string {
  if (typeof p.value === 'string') return p.value;
  if (p.kind === 'angle') return dms(p.value);
  if (p.kind === 'length') return formatLength(p.value, unit);
  return String(p.value);
}

export function formatLength(metres: number, unit: Unit): string {
  return `${(metres / unit.metres).toFixed(3)} ${unit.label}`;
}

/** Square metres in the job's units: m² or square feet. */
export function formatArea(m2: number, unit: Unit): string {
  const value = (m2 / unit.metres ** 2).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value} ${unit.label === 'm' ? 'm²' : 'sq ft'}`;
}

/** 284.80258182 → 284°48'09.29" */
export function dms(deg: number, places = 2): string {
  const sign = deg < 0 ? '-' : '';
  let total = Math.abs(deg) * 3600;
  total = Math.round(total * 10 ** places) / 10 ** places;
  const d = Math.floor(total / 3600);
  const m = Math.floor((total - d * 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${sign}${d}°${String(m).padStart(2, '0')}'${s.toFixed(places).padStart(places + 3, '0')}"`;
}

/** Latitude/longitude as TBC shows them: 37°19'24.65160"N. */
export function latLonDms(deg: number, positive: string, negative: string): string {
  return `${dms(Math.abs(deg), 5)}${deg < 0 ? negative : positive}`;
}
