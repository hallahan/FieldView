// The properties panel for a line or polygon drawn from feature codes, like a
// linestring's Properties in Trimble Business Center: its shape and size, as
// grid and ground distances, the library's definition, the attributes captured
// at its points, and the points themselves. Attributes are recorded at every
// point, so where a value changes along a line the panel says where each applies.

import type { FeatureDef, FeatureLibrary } from './fxl';
import type { JxlPoint } from './jxl';
import type { CrsInfo } from './crs';
import { attributeNames, definitionProps, featureTitle, NOT_RECORDED, repeatsDefinition } from './featureprops';
import { figureOutline, offsetPolyline, type FigureNode, type LineFigure, type Linework } from './linework';
import { formatArea, formatLength, type Prop, type PropGroup, type Unit } from './properties';
import { esc } from './util';

/**
 * Curves are densified this much more than on the map when measuring, which
 * makes lengths along arcs exact to a few parts in 10⁸.
 */
const MEASURE_DETAIL = 50;

/** More runs of values than this along a line are summarised as counts. */
const MAX_RUNS = 4;

export interface Measures {
  /** Horizontal length along the figure, curves included; its perimeter when closed. Metres. */
  length: number;
  /** Ground distance ÷ length, and whether it came from the points or the job's scale factor. */
  ground?: { factor: number; from: 'points' | 'job' };
  /** Length along the slope through the points' elevations, when every point of an open figure has one. */
  slopeLength?: number;
  /** Area of a closed figure or polygon, in square metres. */
  area?: number;
  radius?: number;
  /** A rectangle's first side, then the one at right angles to it. */
  sides?: [number, number];
  /** Lowest and highest elevation of the points. */
  elevations?: [number, number];
  /** Measured on the job's grid coordinates, rather than on the ellipsoid. */
  grid: boolean;
}

/**
 * Measures a figure on the job's grid, with its ground distance from the
 * points' latitudes, longitudes and heights, or else from the job's scale
 * factor (grid ÷ ground) if it has one.
 */
export function measureFigure(fig: LineFigure, figures: LineFigure[], points: JxlPoint[], scale?: number): Measures {
  const base = fig.offset ? figures[fig.offset.of] : fig;
  const coords = base.nodes.map((n) => points[n.index]?.coords);
  // On the grid, as TBC measures, when every point has grid coordinates.
  // Relative to the first point, as grid coordinates run to millions of
  // metres: too large to fit circles through accurately.
  const grid = coords.every((c) => c?.north !== undefined && c.east !== undefined);
  // Otherwise on the ellipsoid, between the map positions: flattened about the
  // first point to draw the shape, but each piece measured on the ellipsoid.
  const o = coords[0];
  const flat = grid ? undefined : flatAbout(o.mapLat!, o.mapLon!);
  const nodes = base.nodes.map((n, i) =>
    flat ? { ...n, ...flat.toXY(coords[i].mapLat!, coords[i].mapLon!) } : { ...n, x: coords[i].east! - o.east!, y: coords[i].north! - o.north! },
  );
  let outline = figureOutline({ ...base, nodes }, MEASURE_DETAIL);
  if (fig.offset) outline = offsetPolyline(outline, fig.offset.line.offset);
  const ring = isRing(fig, base);
  if (ring && outline.length > 2 && !samePoint(outline[0], outline[outline.length - 1])) outline.push(outline[0]);

  const m: Measures = { length: flat ? flat.length(outline) : pathLength(outline), grid };
  if (ring && outline.length > 3) m.area = Math.abs(shoelace(outline));
  // Circles are drawn finely enough when measuring for this to be good to a part in 10⁷.
  if (base.shape === 'circleEdge' || base.shape === 'circleCenter') m.radius = m.length / (2 * Math.PI);
  if (base.shape === 'rectangle' && outline.length === 5) m.sides = [distance(outline[0], outline[1]), distance(outline[1], outline[2])];
  const fromPoints = groundFactor(coords, grid);
  if (fromPoints !== undefined) m.ground = { factor: fromPoints, from: 'points' };
  else if (grid && scale) m.ground = { factor: 1 / scale, from: 'job' };
  const z = coords.map((c) => c?.elevation);
  const known = z.filter((v): v is number => v !== undefined);
  if (known.length) m.elevations = [Math.min(...known), Math.max(...known)];
  // Shapes pass through only some of their points, so a slope length means
  // little; nor does one around a closed figure.
  if (!fig.offset && !ring && (base.shape === 'line' || base.shape === 'join') && known.length === z.length) {
    m.slopeLength = slopeLength(outline, nodes, known, m.ground?.factor ?? 1);
  }
  return m;
}

const A = 6378137;
const E2 = (2 - 1 / 298.257222101) / 298.257222101;
const RAD = Math.PI / 180;

/** The ellipsoid's radii of curvature at a latitude: in the meridian, and at right angles to it. */
function radii(lat: number): { m: number; n: number } {
  const w = 1 - E2 * Math.sin(lat * RAD) ** 2;
  return { m: (A * (1 - E2)) / w ** 1.5, n: A / Math.sqrt(w) };
}

/** Distance on the GRS80 ellipsoid, good to a part in 10⁸ up to a few kilometres. */
function ellipsoidDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const lat = (lat1 + lat2) / 2;
  const { m, n } = radii(lat);
  return Math.hypot(m * (lat2 - lat1) * RAD, n * Math.cos(lat * RAD) * (lon2 - lon1) * RAD);
}

/** A plane about a map position for drawing a figure's shape, whose pieces are measured on the ellipsoid. */
function flatAbout(lat0: number, lon0: number) {
  const { m, n } = radii(lat0);
  const my = m * RAD;
  const mx = n * Math.cos(lat0 * RAD) * RAD;
  return {
    toXY: (lat: number, lon: number) => ({ x: (lon - lon0) * mx, y: (lat - lat0) * my }),
    length(line: [number, number][]) {
      let total = 0;
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        total += ellipsoidDistance(lat0 + a[1] / my, lon0 + a[0] / mx, lat0 + b[1] / my, lon0 + b[0] / mx);
      }
      return total;
    },
  };
}

/**
 * Ground distance ÷ grid (or ellipsoid) distance between the figure's points.
 * Trimble Access takes a ground distance to be the distance on the ellipsoid
 * at the average height of its two ends above it, so this needs the
 * latitudes, longitudes and ellipsoid heights the points were surveyed with.
 */
function groundFactor(coords: JxlPoint['coords'][], grid: boolean): number | undefined {
  let ground = 0;
  let measured = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    if (!surveyed(a) || !surveyed(b)) continue;
    const s = ellipsoidDistance(a.lat!, a.lon!, b.lat!, b.lon!);
    const { m, n } = radii((a.lat! + b.lat!) / 2);
    ground += s * (1 + (a.height! + b.height!) / 2 / Math.sqrt(m * n));
    measured += grid ? Math.hypot(b.east! - a.east!, b.north! - a.north!) : s;
  }
  // Below this, rounding in the coordinates could show; the factor hardly matters anyway.
  return measured > 0.1 ? ground / measured : undefined;
}

/** A latitude, longitude and ellipsoid height from the field, not worked out from the grid or placed by hand. */
function surveyed(c: JxlPoint['coords'] | undefined): boolean {
  return !!c && c.lat !== undefined && c.lon !== undefined && c.height !== undefined && (c.source === 'WGS84' || c.source === 'ECEF');
}

/** Closed figures, polygons, rectangles and circles; not lines alongside them. */
function isRing(fig: LineFigure, base: LineFigure) {
  return !fig.offset && (base.closed || base.polygon);
}

/**
 * Length along the slope, with the grade even between points and the
 * horizontal distance times the scale. Curves pass exactly through their
 * points, so each point is found along the outline.
 */
function slopeLength(outline: [number, number][], nodes: FigureNode[], z: number[], scale: number): number | undefined {
  const at: number[] = [];
  let s = 0;
  for (let k = 0, j = 0; k < outline.length && j < nodes.length; k++) {
    if (k) s += distance(outline[k - 1], outline[k]);
    if (outline[k][0] === nodes[j].x && outline[k][1] === nodes[j].y) {
      at.push(s);
      j++;
    }
  }
  if (at.length !== nodes.length) return undefined;
  let total = 0;
  for (let i = 1; i < at.length; i++) total += Math.hypot(scale * (at[i] - at[i - 1]), z[i] - z[i - 1]);
  return total;
}

function pathLength(pts: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1], pts[i]);
  return total;
}

/** Signed area. */
function shoelace(ring: [number, number][]): number {
  let twice = 0;
  for (let i = 1; i < ring.length; i++) twice += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return twice / 2;
}

function distance(a: [number, number], b: [number, number]) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function samePoint(a: [number, number], b: [number, number]) {
  return a[0] === b[0] && a[1] === b[1];
}

/** The groups of a line's properties panel. */
export function lineGroups(
  fig: LineFigure,
  linework: Linework,
  points: JxlPoint[],
  library: FeatureLibrary | undefined,
  unit: Unit,
  scale?: CrsInfo['scaleFactor'],
): PropGroup[] {
  const base = fig.offset ? linework.figures[fig.offset.of] : fig;
  const m = measureFigure(fig, linework.figures, points, scale?.value);
  return [shapeGroup(fig, base, m, unit, scale?.name ?? ''), featureGroup(fig, base, points, library), pointsGroup(base, points)];
}

function shapeGroup(fig: LineFigure, base: LineFigure, m: Measures, unit: Unit, scaleName: string): PropGroup {
  const props: Prop[] = [{ label: 'Drawn as', value: describeShape(fig, base, unit) }];
  // Grid and ground first: what a bearing and distance on a plat would give.
  const along = m.radius !== undefined ? 'circumference' : isRing(fig, base) ? 'perimeter' : 'distance';
  const on = m.grid ? 'Grid' : 'Ellipsoid';
  props.push({ label: `${on} ${along}`, value: m.length, kind: 'length' });
  if (m.ground) props.push({ label: `Ground ${along}`, value: m.length * m.ground.factor, kind: 'length' });
  if (m.area !== undefined) {
    props.push({ label: `${on} area`, value: formatArea(m.area, unit) });
    if (m.ground) props.push({ label: 'Ground area', value: formatArea(m.area * m.ground.factor ** 2, unit) });
  }
  if (m.slopeLength !== undefined) props.push({ label: 'Slope distance', value: m.slopeLength, kind: 'length' });
  if (m.radius !== undefined) {
    props.push({ label: 'Radius', value: m.radius, kind: 'length' });
    props.push({ label: 'Diameter', value: 2 * m.radius, kind: 'length' });
  }
  if (m.sides) props.push({ label: 'Sides', value: `${formatLength(m.sides[0], unit)} × ${formatLength(m.sides[1], unit)}` });
  if (m.elevations) {
    const [low, high] = m.elevations;
    // The unit once, so the range fits on a line.
    props.push({ label: 'Elevation', value: low === high ? formatLength(low, unit) : `${(low / unit.metres).toFixed(3)} to ${formatLength(high, unit)}` });
  }
  return { title: shapeName(fig), props, note: distanceNote(m, scaleName) };
}

/** What the distances mean, shown under them rather than behind a tap. */
function distanceNote(m: Measures, scaleName: string): string {
  const on = m.grid ? 'grid' : 'ellipsoid';
  const notes: string[] = [];
  if (!m.grid) notes.push('Some of its points have no grid coordinates, so it is measured on the ellipsoid, between latitudes and longitudes.');
  if (m.ground) {
    const k = (1 / m.ground.factor).toFixed(8);
    const why = m.ground.from === 'points' ? "from the points' heights above the ellipsoid, the way Trimble Access works it out" : `the job's ${scaleName}`;
    notes.push(`${m.grid ? 'Grid' : 'Ellipsoid'} and ground distances are horizontal. Ground is ${on}\u00a0÷\u00a0${k}, ${why}.`);
    if (m.area !== undefined) notes.push(`Ground area is ${on} area\u00a0÷\u00a0${k}².`);
  } else if (m.grid) {
    notes.push('Grid distance is horizontal. There is no ground distance, as the job has no scale factor and its points no heights above the ellipsoid.');
  }
  if (m.slopeLength !== undefined) notes.push(`Slope distance adds the rise and fall between the points to the ${m.ground ? 'ground' : on} distance.`);
  return notes.join(' ');
}

/** What a figure is, in a word or two. */
export function shapeName(fig: LineFigure): string {
  if (fig.offset) return 'Offset line';
  if (fig.shape === 'join') return 'Join';
  if (fig.shape === 'rectangle') return 'Rectangle';
  if (fig.shape === 'circleEdge' || fig.shape === 'circleCenter') return 'Circle';
  if (fig.polygon) return 'Polygon';
  return fig.closed ? 'Closed line' : 'Line';
}

function describeShape(fig: LineFigure, base: LineFigure, unit: Unit): string {
  if (fig.offset) {
    const d = fig.offset.line.offset;
    return `${formatLength(Math.abs(d), unit)} ${d < 0 ? 'left' : 'right'} of ${base.code}`;
  }
  const n = base.nodes.length;
  switch (base.shape) {
    case 'join':
      return `From ${base.nodes[0].name} to ${base.nodes[1].name}`;
    case 'rectangle':
      return base.value !== undefined ? `Rectangle from 2 points, ${formatLength(base.value, unit)} wide` : 'Rectangle from 3 points';
    case 'circleEdge':
      return 'Circle through 3 points';
    case 'circleCenter':
      return base.value !== undefined ? `Circle from its centre, radius ${formatLength(base.value, unit)}` : 'Circle from its centre and a point on it';
    default: {
      const curves = base.nodes.filter((node) => node.curveStart).length;
      const through = `${base.polygon ? 'Polygon' : base.closed ? 'Closed line' : 'Line'} through ${n} points`;
      return curves ? `${through}, with ${curves === 1 ? 'a curve' : `${curves} curves`}` : through;
    }
  }
}

function featureGroup(fig: LineFigure, base: LineFigure, points: JxlPoint[], library: FeatureLibrary | undefined): PropGroup {
  const def = fig.def;
  const props: Prop[] = def ? definitionProps(def) : [];
  const style = fig.offset ? fig.offset.line.lineStyle : def?.style.lineStyle;
  const scale = def?.style.lineStyleScale ?? 1;
  if (style && library?.lineStyles.has(style)) props.push({ label: 'Line style', value: scale !== 1 ? `${style} × ${scale}` : style });
  props.push(...attributeProps(fig.code, def, base, points));
  return { title: featureTitle(fig.code, def), props };
}

/**
 * The attributes captured at the figure's points for its code. Where they
 * differ along it, each value is shown with the points it was recorded at.
 */
function attributeProps(code: string, def: FeatureDef | undefined, base: LineFigure, points: JxlPoint[]): Prop[] {
  // A join's attributes are on the point coded with it, not the one it joins to.
  const nodes = base.shape === 'join' ? base.nodes.slice(0, 1) : base.nodes;
  const records = nodes.map((n) => points[n.index]?.features.find((f) => f.name === code)?.attributes ?? {});
  const props: Prop[] = [];
  for (const name of attributeNames(def, records.flatMap((r) => Object.keys(r)))) {
    const values = records.map((r) => r[name] ?? '');
    const recorded = values.filter((v) => v !== '');
    if (recorded.length && recorded.every((v) => repeatsDefinition(def, name, v))) continue;
    const a = def?.attributes.get(name);
    const hint = a?.description;
    const required = a?.entryMethod === 'Required';
    if (!recorded.length) {
      if (required) props.push({ label: name, value: NOT_RECORDED, kind: 'html', hint });
    } else if (recorded.length === values.length && recorded.every((v) => v === recorded[0])) {
      props.push({ label: name, value: recorded[0], hint });
    } else {
      props.push({ label: name, value: valuesAlong(values, nodes, required), kind: 'html', hint });
    }
  }
  return props;
}

/** Each value with where it was recorded: runs of points along the line, or counts when it changes often. */
function valuesAlong(values: string[], nodes: FigureNode[], required: boolean): string {
  const runs: { value: string; from: number; to: number }[] = [];
  values.forEach((value, i) => {
    const last = runs[runs.length - 1];
    if (last?.value === value) last.to = i;
    else runs.push({ value, from: i, to: i });
  });
  const recorded = runs.filter((r) => r.value !== '');
  const rows =
    recorded.length <= MAX_RUNS
      ? recorded.map((r) => [r.value, r.from === r.to ? `at ${nodes[r.from].name}` : `${nodes[r.from].name} to ${nodes[r.to].name}`])
      : [...new Set(recorded.map((r) => r.value))].map((v) => [v, `at ${values.filter((x) => x === v).length} of ${values.length} points`]);
  let html = rows.map(([value, where]) => `<span class="along">${esc(value)}<span class="sub-value">${esc(where)}</span></span>`).join('');
  const missing = values.filter((v) => v === '').length;
  if (required && missing) html += `<span class="along warn-text">Not recorded at ${missing} ${missing === 1 ? 'point' : 'points'}</span>`;
  return html;
}

function pointsGroup(base: LineFigure, points: JxlPoint[]): PropGroup {
  return {
    title: `Points (${base.nodes.length})`,
    props: base.nodes.map((n) => ({ label: n.name, value: points[n.index]?.code ?? '', link: { point: n.index } })),
  };
}

/** The lines and polygons through a point, for its properties panel. */
export function linesAtPoint(index: number, linework: Linework | undefined, points: JxlPoint[], unit: Unit): PropGroup {
  const figures = linework?.figures.filter((f) => !f.offset && f.nodes.some((n) => n.index === index)) ?? [];
  return {
    title: 'Linework',
    props: figures.map((f) => {
      const m = measureFigure(f, linework!.figures, points);
      const what = shapeName(f) === 'Line' ? '' : `${shapeName(f)}, `;
      return { label: f.code, value: `${what}${f.nodes.length} points, ${formatLength(m.length, unit)} ${m.grid ? 'grid' : 'ellipsoid'}`, link: { line: f.fid } };
    }),
  };
}
