// Build linework from feature-coded points, the way Trimble Access and
// Business Center do: points with the same line code are joined in the order
// they were measured, and control codes after a feature code start and end
// lines, add curves, close figures and draw rectangles and circles.
//
// A point's code is a space-separated list such as "PCC1 BL R3" or
// "BARB EL BARB1 BL": each control code applies to the feature code before it.
// Codes ending in a number (PCC1, PCC2) are separate strings of the same
// feature, so they share a definition but never join to each other.

import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import {
  ACTIONS_WITH_VALUE,
  lookupControl,
  lookupFeature,
  type ControlAction,
  type FeatureDef,
  type FeatureLibrary,
  type OffsetLine,
} from './fxl';
import type { JxlPoint } from './jxl';

export interface LineProps {
  /** Index into Linework.figures (and lines.features), for selecting it. */
  fid: number;
  /** The code as coded in the field, string number included (PCC1). */
  code: string;
  /** The library code it matched (PCC), if any. */
  feature: string;
  description: string;
  kind: 'line' | 'polygon';
  /** Library colour; the map picks one when there's none. */
  color?: string;
  /** Polygon fill colour and opacity. */
  fill?: string;
  fillOpacity?: number;
  /** Library line style name, and its scale. */
  lineStyle: string;
  scale: number;
}

export interface CodeToken {
  code: string;
  def?: FeatureDef;
  controls: { code: string; action: ControlAction; value?: string; description: string }[];
}

/** How a figure's outline is built from its points. */
export type FigureShape = 'line' | 'join' | 'rectangle' | 'circleEdge' | 'circleCenter';

/** A point along a figure, in a local plane (metres east and north). */
export interface FigureNode {
  /** The point's index in the job. */
  index: number;
  name: string;
  x: number;
  y: number;
  curveStart?: 'arc' | 'tangentArc' | 'smooth';
  curveEnd?: boolean;
}

/** A drawn line or polygon, and how it was built from the job's points. */
export interface LineFigure {
  /** Its index in Linework.figures and in lines.features. */
  fid: number;
  code: string;
  def?: FeatureDef;
  shape: FigureShape;
  /** Drawn as a polygon (a library polygon feature) rather than a line. */
  polygon: boolean;
  /** Closed by a close code; rectangles and circles always are. */
  closed: boolean;
  nodes: FigureNode[];
  /** Rectangle width or circle radius keyed after the control code, in metres. */
  value?: number;
  /** A line the library draws alongside another figure, such as the back of a curb. */
  offset?: { of: number; line: OffsetLine };
}

export interface Linework {
  lines: FeatureCollection<LineString | Polygon, LineProps>;
  /** How each feature in `lines` was built, by fid. */
  figures: LineFigure[];
  /** Line codes with no library definition, so drawn with default styling. */
  undefinedCodes: string[];
  /** Indexes of the points that are vertices of the linework. */
  onLines: Set<number>;
}

/** Split a point's code into feature codes, each with the control codes that follow it. */
export function parseCode(code: string, library?: FeatureLibrary): CodeToken[] {
  const tokens = code.trim().split(/\s+/).filter(Boolean);
  const out: CodeToken[] = [];
  // Control codes written before any feature code apply to the next one.
  let pending: CodeToken['controls'] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const control = lookupControl(library, t);
    // A code defined as a feature wins over the same text as a control.
    if (control && !library?.features.has(t)) {
      const c: CodeToken['controls'][number] = { code: t, action: control.action, description: control.description };
      // Joins take a point name; sizes and offsets take a number.
      const next = tokens[i + 1];
      if (ACTIONS_WITH_VALUE.has(control.action) && next !== undefined && (control.action === 'join' || isNumber(next))) {
        c.value = next;
        i++;
      }
      (out.length ? out[out.length - 1].controls : pending).push(c);
      continue;
    }
    out.push({ code: t, def: lookupFeature(library, t), controls: pending });
    pending = [];
  }
  return out;
}

function isNumber(s: string) {
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s);
}

/** A figure still being collected. */
type Draft = Omit<LineFigure, 'fid' | 'polygon'>;

/**
 * Join the job's points into lines. `unit` is metres per job distance unit,
 * for the sizes keyed after rectangle and circle codes.
 */
export function buildLinework(points: JxlPoint[], library?: FeatureLibrary, unit = 1): Linework {
  const located = points.filter((p) => !p.deleted && p.coords.mapLat !== undefined && p.coords.mapLon !== undefined);
  const plane = localPlane(located);
  const parsed = located.map((p) => ({ p, tokens: parseCode(p.code, library) }));

  // Without a library, a code is a line if it ever carries a control code.
  const inferredLines = new Set<string>();
  for (const { tokens } of parsed) for (const t of tokens) if (t.controls.length) inferredLines.add(t.code);
  const isLine = (t: CodeToken) => (t.def ? t.def.kind !== 'point' : inferredLines.has(t.code));

  const open = new Map<string, Draft>();
  const shapes = new Map<string, Draft>();
  const byName = new Map<string, FigureNode>();
  const figures: LineFigure[] = [];
  const features: Feature<LineString | Polygon, LineProps>[] = [];
  const undefinedCodes = new Set<string>();
  const onLines = new Set<number>();

  const emit = (draft: Draft) => {
    const coords = figureOutline(draft);
    if (coords.length < 2) return;
    const f: LineFigure = { ...draft, fid: figures.length, polygon: draft.def?.kind === 'polygon' && coords.length >= 3 };
    figures.push(f);
    const ring = coords.map(([x, y]) => plane.toLonLat(x, y));
    const style = f.def?.style;
    const props: LineProps = {
      fid: f.fid,
      code: f.code,
      feature: f.def?.code ?? '',
      description: f.def?.description ?? '',
      kind: f.polygon ? 'polygon' : 'line',
      lineStyle: style?.lineStyle ?? '',
      scale: style?.lineStyleScale ?? 1,
    };
    if (style?.color) props.color = style.color;
    if (f.polygon && style?.fill) {
      props.fill = style.fill;
      props.fillOpacity = style.fillOpacity ?? 0.5;
    }
    if (f.polygon) {
      const closed = sameXY(coords[0], coords[coords.length - 1]) ? ring : [...ring, ring[0]];
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closed] }, properties: props });
    } else {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: props });
    }
    // Parallel lines the library adds, such as the back of a curb.
    for (const o of f.def?.offsets ?? []) {
      if (!o.offset) continue;
      const parallel: LineFigure = { ...f, fid: figures.length, polygon: false, offset: { of: f.fid, line: o } };
      figures.push(parallel);
      const line = offsetPolyline(coords, o.offset).map(([x, y]) => plane.toLonLat(x, y));
      const oprops: LineProps = { ...props, fid: parallel.fid, kind: 'line', description: o.name || props.description, lineStyle: o.lineStyle ?? '' };
      delete oprops.fill;
      delete oprops.fillOpacity;
      if (o.color) oprops.color = o.color;
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: oprops });
    }
  };

  const flush = (code: string) => {
    const f = open.get(code);
    if (!f) return;
    open.delete(code);
    emit(f);
  };

  // A shape with too few points, or in a line, is drawn through the points it has.
  const finishShape = (s: Draft, final = false) => {
    if (shapeRing(s)) emit(s);
    else if (final) emit({ ...s, shape: 'line', closed: false });
  };

  for (const { p, tokens } of parsed) {
    const [x, y] = plane.toXY(p.coords.mapLon!, p.coords.mapLat!);
    for (const t of tokens) {
      if (!isLine(t)) continue;
      if (!t.def) undefinedCodes.add(t.code);
      onLines.add(p.index);
      const node: FigureNode = { index: p.index, name: p.name, x, y };
      const actions = new Set(t.controls.map((c) => c.action));
      const value = (a: ControlAction) => t.controls.find((c) => c.action === a)?.value;

      const shape = shapes.get(t.code);
      if (shape) {
        shape.nodes.push(node);
        const need = shape.shape === 'circleCenter' ? 2 : shape.shape === 'rectangle' && shape.value !== undefined ? 2 : 3;
        if (shape.nodes.length >= need) {
          finishShape(shape);
          shapes.delete(t.code);
        }
        continue;
      }

      const shapeKind = (['rectangle', 'circleEdge', 'circleCenter'] as const).find((k) => actions.has(k));
      if (shapeKind) {
        flush(t.code);
        const v = Number(value(shapeKind));
        const s: Draft = { code: t.code, def: t.def, shape: shapeKind, nodes: [node], closed: true };
        if (Number.isFinite(v) && v > 0) s.value = v * unit;
        if (shapeKind === 'circleCenter' && s.value !== undefined) finishShape(s);
        else shapes.set(t.code, s);
        continue;
      }

      if (actions.has('start')) flush(t.code);
      if (!actions.has('noJoin')) {
        let f = open.get(t.code);
        if (!f) open.set(t.code, (f = { code: t.code, def: t.def, shape: 'line', nodes: [], closed: false }));
        if (actions.has('arcStart')) node.curveStart = 'arc';
        if (actions.has('tangentArcStart')) node.curveStart = 'tangentArc';
        if (actions.has('curveStart')) node.curveStart = 'smooth';
        if (actions.has('arcEnd') || actions.has('tangentArcEnd') || actions.has('curveEnd')) node.curveEnd = true;
        f.nodes.push(node);
      }
      const target = value('join');
      const to = target !== undefined ? byName.get(target) : undefined;
      if (to) emit({ code: t.code, def: t.def, shape: 'join', nodes: [node, to], closed: false });
      if (actions.has('close')) {
        const f = open.get(t.code);
        if (f) f.closed = true;
        flush(t.code);
      }
      if (actions.has('end')) flush(t.code);
    }
    byName.set(p.name, { index: p.index, name: p.name, x, y });
  }
  for (const code of [...open.keys()]) flush(code);
  for (const s of shapes.values()) finishShape(s, true);

  return { lines: { type: 'FeatureCollection', features }, figures, undefinedCodes: [...undefinedCodes].sort(), onLines };
}

/**
 * A figure's outline from its points' x/y, with curves densified and shapes
 * completed. `detail` multiplies the number of vertices on curves: the map
 * needs few, measuring along a curve more.
 */
export function figureOutline(f: Pick<LineFigure, 'shape' | 'nodes' | 'closed' | 'value'>, detail = 1): [number, number][] {
  const pts = f.nodes.map((n): [number, number] => [n.x, n.y]);
  if (f.shape === 'join') return pts;
  if (f.shape !== 'line') return shapeRing(f, detail) ?? pts;
  const coords = figureCoords(f.nodes, detail);
  if (f.closed && f.nodes.length >= 3 && !sameXY(coords[0], coords[coords.length - 1])) coords.push(coords[0]);
  return coords;
}

/** The closed outline of a rectangle or circle, or undefined until it has enough points. */
function shapeRing(f: Pick<LineFigure, 'shape' | 'nodes' | 'value'>, detail = 1): [number, number][] | undefined {
  const pts = f.nodes.map((n): [number, number] => [n.x, n.y]);
  if (f.shape === 'rectangle') return rectangle(pts, f.value);
  if (f.shape === 'circleEdge') return pts.length >= 3 ? circleThrough(pts[0], pts[1], pts[2], detail) : undefined;
  if (f.shape === 'circleCenter') {
    const r = f.value ?? (pts.length >= 2 ? Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) : 0);
    return r > 0 ? circle(pts[0], r, detail) : undefined;
  }
  return undefined;
}

/** Vertices of a figure, with its curves densified. */
function figureCoords(nodes: FigureNode[], detail: number): [number, number][] {
  if (!nodes.length) return [];
  const xy = (n: FigureNode): [number, number] => [n.x, n.y];
  const out: [number, number][] = [xy(nodes[0])];
  let i = 0;
  while (i < nodes.length - 1) {
    const kind = nodes[i].curveStart;
    if (!kind) {
      out.push(xy(nodes[++i]));
      continue;
    }
    // The curve runs to its end code, or to the end of the line. The end of
    // one curve can start the next.
    let j = i + 1;
    while (j < nodes.length - 1 && !nodes[j].curveEnd) j++;
    const before = i > 0 ? xy(nodes[i - 1]) : undefined;
    out.push(...curve(nodes.slice(i, j + 1).map(xy), kind, before, detail).slice(1));
    i = j;
  }
  return out;
}

function curve(pts: [number, number][], kind: FigureNode['curveStart'], before: [number, number] | undefined, detail: number): [number, number][] {
  if (pts.length === 2 && kind === 'tangentArc' && before) return tangentArc(before, pts[0], pts[1], detail);
  if (pts.length === 3 && kind !== 'smooth') return arcThrough(pts[0], pts[1], pts[2], detail) ?? pts;
  if (pts.length >= 3) return catmullRom(pts, detail);
  return pts;
}

/** Circular arc from a through b to c, or undefined if they're in a line. */
export function arcThrough(a: [number, number], b: [number, number], c: [number, number], detail = 1): [number, number][] | undefined {
  const centre = circumcentre(a, b, c);
  if (!centre) return undefined;
  const r = Math.hypot(a[0] - centre[0], a[1] - centre[1]);
  const ang = (p: [number, number]) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
  const a0 = ang(a);
  // Sweep in the direction that passes through b.
  const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
  let sweep = ang(c) - a0;
  if (ccw && sweep < 0) sweep += 2 * Math.PI;
  if (!ccw && sweep > 0) sweep -= 2 * Math.PI;
  return arcPoints(centre, r, a0, sweep, a, c, detail);
}

function tangentArc(before: [number, number], a: [number, number], b: [number, number], detail: number): [number, number][] {
  const tx = a[0] - before[0];
  const ty = a[1] - before[1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cross = tx * dy - ty * dx;
  const tl = Math.hypot(tx, ty);
  if (!tl || Math.abs(cross) < 1e-9 * tl * Math.hypot(dx, dy)) return [a, b];
  // Centre lies on the normal to the tangent at a, equidistant from a and b.
  const nx = -ty / tl;
  const ny = tx / tl;
  const t = (dx * dx + dy * dy) / (2 * (dx * nx + dy * ny));
  const centre: [number, number] = [a[0] + nx * t, a[1] + ny * t];
  const r = Math.abs(t);
  const a0 = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
  let sweep = Math.atan2(b[1] - centre[1], b[0] - centre[0]) - a0;
  if (cross > 0 && sweep < 0) sweep += 2 * Math.PI;
  if (cross < 0 && sweep > 0) sweep -= 2 * Math.PI;
  return arcPoints(centre, r, a0, sweep, a, b, detail);
}

function arcPoints(
  centre: [number, number],
  r: number,
  a0: number,
  sweep: number,
  first: [number, number],
  last: [number, number],
  detail: number,
): [number, number][] {
  // About one vertex every 3°, so curves stay smooth at any zoom.
  const steps = Math.ceil(Math.max(8, Math.abs(sweep) / (Math.PI / 60)) * detail);
  const out: [number, number][] = [first];
  for (let k = 1; k < steps; k++) {
    const t = a0 + (sweep * k) / steps;
    out.push([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
  }
  out.push(last);
  return out;
}

function circumcentre(a: [number, number], b: [number, number], c: [number, number]): [number, number] | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scale = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1])) ** 2;
  if (!scale || Math.abs(d) < 1e-9 * scale) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}

export function circleThrough(a: [number, number], b: [number, number], c: [number, number], detail = 1): [number, number][] | undefined {
  const centre = circumcentre(a, b, c);
  return centre && circle(centre, Math.hypot(a[0] - centre[0], a[1] - centre[1]), detail);
}

function circle(centre: [number, number], r: number, detail = 1): [number, number][] {
  const out: [number, number][] = [];
  const steps = 72 * detail;
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * 2 * Math.PI;
    out.push([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
  }
  return out;
}

/**
 * Rectangle from two adjacent corners and either a point on the opposite
 * side or a width (positive to the right of the first side).
 */
export function rectangle(pts: [number, number][], width?: number): [number, number][] | undefined {
  if (pts.length < 2) return undefined;
  const [a, b] = pts;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return undefined;
  // Unit normal to the left of a → b.
  const nx = -dy / len;
  const ny = dx / len;
  let w: number;
  if (pts.length >= 3) w = (pts[2][0] - a[0]) * nx + (pts[2][1] - a[1]) * ny;
  else if (width !== undefined) w = -width;
  else return undefined;
  return [a, b, [b[0] + nx * w, b[1] + ny * w], [a[0] + nx * w, a[1] + ny * w], a];
}

/** Centripetal Catmull–Rom spline through every point. */
function catmullRom(pts: [number, number][], detail: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  // Mirror the end points so the curve leaves and arrives along the chords.
  p[0] = [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
  const n = pts.length;
  p[p.length - 1] = [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const knot = (u: [number, number], v: [number, number]) => Math.max(Math.sqrt(Math.hypot(v[0] - u[0], v[1] - u[1])), 1e-6);
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const steps = 12 * detail;
    for (let k = 1; k <= steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const lerp = (u: [number, number], v: [number, number], ta: number, tb: number): [number, number] => {
        const s = (t - ta) / (tb - ta);
        return [u[0] + (v[0] - u[0]) * s, u[1] + (v[1] - u[1]) * s];
      };
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(k === steps ? p2 : lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/** A polyline moved sideways, positive to the right, with mitred corners. */
export function offsetPolyline(pts: [number, number][], d: number): [number, number][] {
  const normals: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([dy / len, -dx / len]);
  }
  return pts.map((p, i) => {
    const a = normals[Math.max(0, i - 1)] ?? [0, 0];
    const b = normals[Math.min(normals.length - 1, i)] ?? a;
    const nx = a[0] + b[0];
    const ny = a[1] + b[1];
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) return [p[0] + a[0] * d, p[1] + a[1] * d];
    // Keep the offset distance on both segments, up to a 4× mitre.
    const cos = (nx / len) * a[0] + (ny / len) * a[1];
    const k = d / Math.max(cos, 0.25);
    return [p[0] + (nx / len) * k, p[1] + (ny / len) * k];
  });
}

function sameXY(a: [number, number], b: [number, number]) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * A flat east/north plane in metres around the job. Over a few kilometres the
 * error is far below a millimetre in shape, and lines meet the drawn points
 * exactly because both use the map positions.
 */
function localPlane(points: JxlPoint[]) {
  const lat0 = points.length ? points.reduce((s, p) => s + p.coords.mapLat!, 0) / points.length : 0;
  const lon0 = points.length ? points.reduce((s, p) => s + p.coords.mapLon!, 0) / points.length : 0;
  const r = Math.PI / 180;
  const my = 6371008.8 * r;
  const mx = my * Math.cos(lat0 * r);
  return {
    toXY: (lon: number, lat: number): [number, number] => [(lon - lon0) * mx, (lat - lat0) * my],
    toLonLat: (x: number, y: number): [number, number] => [lon0 + x / mx, lat0 + y / my],
  };
}
