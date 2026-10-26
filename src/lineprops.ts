// The properties panel for a line or polygon drawn from feature codes, like a
// linestring's Properties in Trimble Business Center: its shape and size on
// the job's grid, the library's definition, the attributes captured at its
// points, and the points themselves. Attributes are recorded at every point,
// so where a value changes along a line the panel says where each applies.

import type { FeatureDef, FeatureLibrary } from './fxl';
import type { JxlPoint } from './jxl';
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
  /** Length in 3D through the points' elevations, when every point has one. */
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

export function measureFigure(fig: LineFigure, figures: LineFigure[], points: JxlPoint[]): Measures {
  const base = fig.offset ? figures[fig.offset.of] : fig;
  // On the grid, as TBC measures, when every point has grid coordinates.
  // Relative to the first point, as grid coordinates run to millions of
  // metres: too large to fit circles through accurately.
  const grid = base.nodes.every((n) => points[n.index]?.coords.north !== undefined && points[n.index]?.coords.east !== undefined);
  const origin = points[base.nodes[0]?.index]?.coords;
  const nodes = grid
    ? base.nodes.map((n) => ({ ...n, x: points[n.index].coords.east! - origin.east!, y: points[n.index].coords.north! - origin.north! }))
    : base.nodes;
  let outline = figureOutline({ ...base, nodes }, MEASURE_DETAIL);
  if (fig.offset) outline = offsetPolyline(outline, fig.offset.line.offset);
  const ring = isRing(fig, base);
  if (ring && outline.length > 2 && !samePoint(outline[0], outline[outline.length - 1])) outline.push(outline[0]);

  const m: Measures = { length: pathLength(outline), grid };
  if (ring && outline.length > 3) m.area = Math.abs(shoelace(outline));
  // Circles are drawn finely enough when measuring for this to be good to a part in 10⁷.
  if (base.shape === 'circleEdge' || base.shape === 'circleCenter') m.radius = m.length / (2 * Math.PI);
  if (base.shape === 'rectangle' && outline.length === 5) m.sides = [distance(outline[0], outline[1]), distance(outline[1], outline[2])];
  const z = base.nodes.map((n) => points[n.index]?.coords.elevation);
  const known = z.filter((v): v is number => v !== undefined);
  if (known.length) m.elevations = [Math.min(...known), Math.max(...known)];
  // Shapes pass through only some of their points, so a 3D length means little.
  if (!fig.offset && (base.shape === 'line' || base.shape === 'join') && known.length === z.length) {
    m.slopeLength = slopeLength(outline, nodes, known, ring);
  }
  return m;
}

/** Closed figures, polygons, rectangles and circles; not lines alongside them. */
function isRing(fig: LineFigure, base: LineFigure) {
  return !fig.offset && (base.closed || base.polygon);
}

/**
 * Length in 3D, with the grade even between points. Curves pass exactly
 * through their points, so each point is found along the outline.
 */
function slopeLength(outline: [number, number][], nodes: FigureNode[], z: number[], ring: boolean): number | undefined {
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
  for (let i = 1; i < at.length; i++) total += Math.hypot(at[i] - at[i - 1], z[i] - z[i - 1]);
  if (ring) total += Math.hypot(pathLength(outline) - at[at.length - 1], z[0] - z[z.length - 1]);
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
export function lineGroups(fig: LineFigure, linework: Linework, points: JxlPoint[], library: FeatureLibrary | undefined, unit: Unit): PropGroup[] {
  const base = fig.offset ? linework.figures[fig.offset.of] : fig;
  const m = measureFigure(fig, linework.figures, points);
  return [shapeGroup(fig, base, m, unit), featureGroup(fig, base, points, library), pointsGroup(base, points)];
}

function shapeGroup(fig: LineFigure, base: LineFigure, m: Measures, unit: Unit): PropGroup {
  const on = m.grid ? 'On the grid' : 'On the ellipsoid, as some of its points have no grid coordinates';
  const props: Prop[] = [{ label: 'Drawn as', value: describeShape(fig, base, unit) }];
  const lengthLabel = m.radius !== undefined ? 'Circumference' : isRing(fig, base) ? 'Perimeter' : '2D length';
  props.push({ label: lengthLabel, value: m.length, kind: 'length', hint: `${on}, following any curves.` });
  if (m.slopeLength !== undefined) props.push({ label: '3D length', value: m.slopeLength, kind: 'length', hint: "Through the points' elevations." });
  if (m.area !== undefined) props.push({ label: 'Area', value: formatArea(m.area, unit), hint: `${on}.` });
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
  return { title: shapeName(fig), props };
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
      return { label: f.code, value: `${what}${f.nodes.length} points, ${formatLength(m.length, unit)}`, link: { line: f.fid } };
    }),
  };
}
