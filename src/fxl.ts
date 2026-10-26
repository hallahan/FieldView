// Reader for Trimble feature definition libraries (.fxl), as written by
// Trimble Business Center's Feature Definition Manager (schema version 9):
//
//   <FeatureCodingDefinitions xmlns="http://trimble.com/schema/fxl">
//     <LineStyleDefinitions>  dash patterns and decorations, in paper mm
//     <SymbolDefinitions>     point symbols drawn from lines and arcs
//     <LayerDefinitions>      colour and line style that features can inherit
//     <ControlCodeDefinitions Type="Start|End|StartCurve|..." Code="BL"/>
//     <FeatureDefinitions>    Point/Line/PolygonFeatureDefinition, with Attributes
//
// Colours are AARRGGBB hex. An alpha of FE means "by layer".

export type FeatureKind = 'point' | 'line' | 'polygon';

export type ControlAction =
  | 'start'
  | 'end'
  | 'close'
  | 'join'
  | 'noJoin'
  | 'tangentArcStart'
  | 'tangentArcEnd'
  | 'arcStart'
  | 'arcEnd'
  | 'curveStart'
  | 'curveEnd'
  | 'rectangle'
  | 'circleEdge'
  | 'circleCenter'
  | 'offset';

/** Drawing primitives of line styles and symbols, in the library's paper units (mm). */
export type Stroke =
  | { kind: 'line'; points: [number, number][] }
  | { kind: 'arc'; x: number; y: number; radius: number; start: number; delta: number }
  | { kind: 'text'; x: number; y: number; height: number; text: string; angle: number }
  | { kind: 'symbol'; x: number; y: number; name: string; scale: number; angle: number };

export interface LineStyle {
  name: string;
  /** Length of one repeat of the pattern. */
  period: number;
  /**
   * The part drawn along the line itself: solid, nothing, or alternating
   * dash and gap lengths that start with a dash.
   */
  base: 'solid' | 'none' | number[];
  /** Everything off the line (ticks, crosses, text), shifted to line up with `base`. */
  decorations: Stroke[];
}

export interface SymbolDef {
  name: string;
  strokes: Stroke[];
}

export interface AttributeDef {
  name: string;
  /** List, String, Double, Integer, Date, Time, Photo, File, ... */
  type: string;
  description: string;
  /** Required, Optional or OfficeUseOnly. */
  entryMethod: string;
  items?: string[];
  decimals?: number;
}

export interface FeatureStyle {
  /** CSS colour, after resolving "by layer". */
  color?: string;
  /** Name of a line style in the library. */
  lineStyle?: string;
  /** Multiplier on the line style's pattern. */
  lineStyleScale: number;
  /** Line style shown in the field (Trimble Access): Solid or Dashed. */
  fieldLineStyle?: string;
  /** Polygons: fill colour and opacity 0–1. */
  fill?: string;
  fillOpacity?: number;
  /** Points: symbol name in the library. */
  symbol?: string;
}

/** Extra lines drawn parallel to a line feature, such as a curb's back. */
export interface OffsetLine {
  name: string;
  /** Metres, positive to the right of the direction of travel. */
  offset: number;
  color?: string;
  lineStyle?: string;
}

export interface FeatureDef {
  code: string;
  kind: FeatureKind;
  /** The library's name for the feature, such as Concrete_Edge. */
  name: string;
  /** Readable description, such as "Concrete edge". */
  description: string;
  category: string;
  layer: string;
  style: FeatureStyle;
  offsets: OffsetLine[];
  attributes: Map<string, AttributeDef>;
}

export interface ControlDef {
  code: string;
  action: ControlAction;
  /** The library's own type name, such as StartCurve. */
  type: string;
  description: string;
}

export interface FeatureLibrary {
  /** File name without extension, which is how jobs refer to it. */
  name: string;
  description: string;
  features: Map<string, FeatureDef>;
  controls: Map<string, ControlDef>;
  /** Control codes whose type this app doesn't draw yet, by code. */
  unknownControls: Map<string, string>;
  lineStyles: Map<string, LineStyle>;
  symbols: Map<string, SymbolDef>;
}

export class FxlParseError extends Error {}

/** Trimble's control code types. */
const CONTROL_TYPES: Record<string, ControlAction> = {
  start: 'start',
  end: 'end',
  close: 'close',
  jointopoint: 'join',
  nojoin: 'noJoin',
  startarc: 'tangentArcStart',
  endarc: 'tangentArcEnd',
  newarc: 'arcStart',
  endonarc: 'arcEnd',
  startcurve: 'curveStart',
  endcurve: 'curveEnd',
  startrectangle: 'rectangle',
  startcircleedge: 'circleEdge',
  startcirclecenter: 'circleCenter',
  horizontaloffset: 'offset',
  verticaloffset: 'offset',
};

/**
 * Control codes used when no library is loaded: the Caltrans conventions
 * (BL/EL lines, BC/EC smooth curves, R3 rectangles, C3 and C2 circles, JP
 * join to point, CL close).
 */
export const DEFAULT_CONTROLS: ControlDef[] = (
  [
    ['BL', 'Start', 'begin line'],
    ['EL', 'End', 'end line'],
    ['BC', 'StartCurve', 'begin smooth curve'],
    ['EC', 'EndCurve', 'end smooth curve'],
    ['CL', 'Close', 'close line'],
    ['JP', 'JoinToPoint', 'join to point'],
    ['R3', 'StartRectangle', 'rectangle from 3 shots'],
    ['C3', 'StartCircleEdge', '3 point circle'],
    ['C2', 'StartCircleCenter', 'circle with radius'],
  ] as const
).map(([code, type, description]) => ({ code, type, action: controlAction(type)!, description }));

/** Actions that take the next token of the code as a value (a point name, radius or offset). */
export const ACTIONS_WITH_VALUE = new Set<ControlAction>(['join', 'offset', 'circleCenter', 'rectangle']);

export function controlAction(type: string): ControlAction | undefined {
  return CONTROL_TYPES[type.toLowerCase().replace(/[^a-z]/g, '')];
}

export function parseFxl(source: string, fileName = ''): FeatureLibrary {
  const xml = new DOMParser().parseFromString(source.replace(/^﻿/, ''), 'application/xml');
  const err = xml.getElementsByTagName('parsererror')[0];
  if (err) throw new FxlParseError(`Not valid XML: ${err.textContent?.trim().split('\n')[0] ?? ''}`);
  const root = xml.documentElement;
  if (root.localName === 'JOBFile') throw new FxlParseError('This is a JobXML job, not a feature library.');
  if (root.localName !== 'FeatureCodingDefinitions') {
    throw new FxlParseError(`Expected <FeatureCodingDefinitions>, found <${root.localName}>. Is this a Trimble feature library (.fxl)?`);
  }

  const library: FeatureLibrary = {
    name: fileName.replace(/\.fxl$/i, '') || 'Feature library',
    description: root.getAttribute('Description') ?? '',
    features: new Map(),
    controls: new Map(),
    unknownControls: new Map(),
    lineStyles: new Map(),
    symbols: new Map(),
  };

  for (const el of section(root, 'LineStyleDefinitions', 'LineStyleDefinition')) {
    const style = parseLineStyle(el);
    library.lineStyles.set(style.name, style);
  }
  for (const el of section(root, 'SymbolDefinitions', 'SymbolDefinition')) {
    const name = el.getAttribute('Name') ?? '';
    library.symbols.set(name, { name, strokes: kids(el, 'Component').flatMap(strokes) });
  }

  const layers = new Map<string, { color?: string; lineStyle?: string }>();
  for (const el of section(root, 'LayerDefinitions', 'LayerDefinition')) {
    layers.set(childText(el, 'Name'), { color: parseColor(childText(el, 'Color')), lineStyle: styleName(childText(el, 'LineStyleName')) });
  }

  for (const el of section(root, 'ControlCodeDefinitions', 'ControlCodeDefinition')) {
    const code = el.getAttribute('Code') ?? '';
    const type = el.getAttribute('Type') ?? '';
    const action = controlAction(type);
    if (!code) continue;
    if (action) library.controls.set(code, { code, type, action, description: el.getAttribute('Description') ?? '' });
    else library.unknownControls.set(code, type);
  }

  const kinds: Record<string, FeatureKind> = {
    PointFeatureDefinition: 'point',
    LineFeatureDefinition: 'line',
    PolygonFeatureDefinition: 'polygon',
  };
  const defs = kids(root, 'FeatureDefinitions')[0];
  for (const el of defs ? Array.from(defs.children) : []) {
    const kind = kinds[el.localName];
    const code = el.getAttribute('Code');
    if (!kind || !code) continue;
    const layerName = el.getAttribute('Layer') ?? '';
    const layer = layers.get(layerName) ?? {};
    const byLayer = (color?: string | null) => parseColor(color ?? '') ?? layer.color;
    const style: FeatureStyle = { lineStyleScale: number(el.getAttribute('LineStyleScale')) ?? 1 };
    if (kind === 'polygon') {
      style.color = byLayer(el.getAttribute('BorderColor'));
      style.lineStyle = styleName(el.getAttribute('BorderLineStyleName')) ?? layer.lineStyle;
      style.lineStyleScale = number(el.getAttribute('BorderLineStyleScale')) ?? 1;
      style.fieldLineStyle = el.getAttribute('FieldBorderLineStyle') ?? undefined;
      style.fill = byLayer(el.getAttribute('FillColor'));
      style.fillOpacity = 1 - (number(el.getAttribute('FillTransparency')) ?? 50) / 100;
    } else {
      style.color = byLayer(el.getAttribute('Color'));
      style.lineStyle = styleName(el.getAttribute('LineStyleName')) ?? layer.lineStyle;
      style.fieldLineStyle = el.getAttribute('FieldLineStyle') ?? undefined;
    }
    if (kind === 'point') {
      const symbol = el.querySelector('Symbols > Symbol');
      if (symbol) {
        style.symbol = childText(symbol, 'SymbolName') || undefined;
        style.color = parseColor(childText(symbol, 'Color')) ?? style.color;
      }
    }
    const attributes = parseAttributes(el);
    const name = el.getAttribute('Name') ?? '';
    library.features.set(code, {
      code,
      kind,
      name,
      description: describe(name, attributes),
      category: el.getAttribute('Category') ?? '',
      layer: layerName,
      style,
      offsets: kids(el, 'Lines').flatMap((lines) =>
        kids(lines, 'Line').map((l) => ({
          name: childText(l, 'Name'),
          offset: number(fixedValue(l, 'HorizontalOffset')) ?? 0,
          color: parseColor(childText(l, 'Color')) ?? style.color,
          lineStyle: styleName(childText(l, 'LineStyleName')) ?? style.lineStyle,
        })),
      ),
      attributes,
    });
  }

  if (!library.features.size && !library.controls.size) throw new FxlParseError('No feature codes found in this library.');
  return library;
}

/** Look up a code, falling back to the code without a trailing string number (PCC1 → PCC). */
export function lookupFeature(library: FeatureLibrary | undefined, code: string): FeatureDef | undefined {
  if (!library) return undefined;
  const exact = library.features.get(code) ?? caseless(library.features, code);
  if (exact) return exact;
  const base = code.replace(/\d+$/, '');
  return base && base !== code ? (library.features.get(base) ?? caseless(library.features, base)) : undefined;
}

export function lookupControl(library: FeatureLibrary | undefined, token: string): ControlDef | undefined {
  if (library?.controls.size) return library.controls.get(token) ?? caseless(library.controls, token);
  return DEFAULT_CONTROLS.find((c) => c.code === token);
}

/** The library a JobXML job was coded with, from its FeatureCodingRecord or AssociatedFiles. */
export function jobLibraryName(jxl: string): string | undefined {
  const m =
    jxl.match(/<SourceFilename>([^<]+)<\/SourceFilename>/) ??
    jxl.match(/<FeatureCodeLibrary>([^<]+)<\/FeatureCodeLibrary>/) ??
    jxl.match(/<LibraryName>([^<]+)<\/LibraryName>/);
  // Field software on Windows stores a full path.
  const name = m?.[1].trim().split(/[\\/]/).pop();
  return name ? name.replace(/\.fxl$/i, '') : undefined;
}

function caseless<T>(map: Map<string, T>, key: string): T | undefined {
  const k = key.toUpperCase();
  for (const [code, v] of map) if (code.toUpperCase() === k) return v;
  return undefined;
}

function kids(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}

function section(root: Element, container: string, item: string): Element[] {
  return kids(root, container).flatMap((c) => kids(c, item));
}

function childText(el: Element, name: string): string {
  return kids(el, name)[0]?.textContent?.trim() ?? '';
}

function fixedValue(el: Element, name: string): string {
  const c = kids(el, name)[0];
  return c ? childText(c, 'FixedValue') : '';
}

function number(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function styleName(s: string | null | undefined): string | undefined {
  return s && !/^by\s*(layer|block)$/i.test(s.trim()) ? s.trim() : undefined;
}

/**
 * AARRGGBB hex (also #RRGGBB). Alpha FE marks "by layer" and Empty means "use
 * the feature's colour"; both return undefined.
 */
export function parseColor(s: string): string | undefined {
  const t = s.trim().replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(t)) return /^f[de]/i.test(t) ? undefined : `#${t.slice(2).toLowerCase()}`;
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`;
  return undefined;
}

function parseAttributes(el: Element): Map<string, AttributeDef> {
  const out = new Map<string, AttributeDef>();
  for (const a of kids(el, 'Attributes').flatMap((c) => Array.from(c.children))) {
    const name = a.getAttribute('Name');
    if (!name) continue;
    const def: AttributeDef = {
      name,
      type: a.localName.replace(/Attribute$/, ''),
      description: a.getAttribute('Description') ?? '',
      entryMethod: a.getAttribute('EntryMethod') ?? '',
    };
    const items = a.getElementsByTagName('Item');
    if (items.length) def.items = Array.from(items).map((i) => i.textContent?.trim() ?? '');
    const decimals = number(a.getAttribute('NumberOfDecimals'));
    if (decimals !== undefined) def.decimals = decimals;
    out.set(name, def);
  }
  return out;
}

/** "Concrete_Edge", or the Caltrans "Feature" attribute's single value when there is one. */
function describe(name: string, attributes: Map<string, AttributeDef>): string {
  const feature = attributes.get('Feature');
  if (feature?.items?.length === 1 && feature.items[0]) return capitalise(feature.items[0]);
  return capitalise(name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim());
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function location(el: Element): [number, number] {
  return [Number(el.getAttribute('X')) || 0, Number(el.getAttribute('Y')) || 0];
}

function orientation(el: Element): number {
  return Number(kids(el, 'Orientation')[0]?.getAttribute('Angle')) || 0;
}

/** Lines, arcs, text and symbols directly inside an element. */
function strokes(el: Element): Stroke[] {
  const out: Stroke[] = [];
  for (const c of Array.from(el.children)) {
    const loc = kids(c, 'Location').map(location);
    switch (c.localName) {
      case 'Line':
        if (loc.length >= 2) out.push({ kind: 'line', points: loc });
        break;
      case 'Arc': {
        const radius = number(childText(c, 'Radius'));
        if (loc.length && radius) {
          const [x, y] = loc[0];
          out.push({ kind: 'arc', x, y, radius, start: number(childText(c, 'StartAngle')) ?? 0, delta: number(childText(c, 'DeltaAngle')) ?? 360 });
        }
        break;
      }
      case 'Text': {
        const t = childText(c, 'Text');
        if (loc.length && t) out.push({ kind: 'text', x: loc[0][0], y: loc[0][1], height: number(childText(c, 'Height')) ?? 1, text: t, angle: orientation(c) });
        break;
      }
      case 'Symbol':
        if (loc.length) {
          out.push({
            kind: 'symbol',
            x: loc[0][0],
            y: loc[0][1],
            name: c.getAttribute('Name') ?? '',
            scale: number(c.getAttribute('Scale')) ?? 1,
            angle: orientation(c),
          });
        }
        break;
    }
  }
  return out;
}

function parseLineStyle(el: Element): LineStyle {
  const name = el.getAttribute('Name') ?? '';
  const patterns = kids(el, 'Pattern');
  const period = Math.max(0, ...patterns.map((p) => number(p.getAttribute('TotalLength')) ?? 0));
  const all = patterns.flatMap(strokes);
  if (!period || period >= 1000) return { name, period: period || 1, base: 'solid', decorations: [] };

  // Straight runs on the line itself make the dash pattern; the rest decorates.
  const onLine = (s: Stroke) => s.kind === 'line' && s.points.every(([, y]) => Math.abs(y) < 1e-6);
  const runs: [number, number][] = all
    .filter(onLine)
    .flatMap((s) => {
      const xs = (s as Extract<Stroke, { kind: 'line' }>).points.map(([x]) => x);
      return [[Math.max(0, Math.min(...xs)), Math.min(period, Math.max(...xs))] as [number, number]];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const decorations = all.filter((s) => !onLine(s));
  let base: LineStyle['base'];
  let phase = 0;
  if (!merged.length) base = 'none';
  else if (merged[0][0] <= 1e-6 && merged[merged.length - 1][1] >= period - 1e-6 && merged.length === 1) base = 'solid';
  else {
    // Start the pattern on a dash. A run that touches the end continues into
    // the next repeat, so the pattern starts at that run instead.
    const lastRun = merged[merged.length - 1];
    phase = merged[0][0] <= 1e-6 && lastRun[1] >= period - 1e-6 ? lastRun[0] : merged[0][0];
    const shifted = merged
      .map(([a, b]) => [mod(a - phase, period), mod(a - phase, period) + (b - a)] as [number, number])
      .sort((x, y) => x[0] - y[0]);
    // Rejoin the run split by the shift.
    const dashes: [number, number][] = [];
    for (const r of shifted) {
      const last = dashes[dashes.length - 1];
      if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
      else dashes.push(r);
    }
    base = [];
    for (let i = 0; i < dashes.length; i++) {
      const next = i + 1 < dashes.length ? dashes[i + 1][0] : period;
      base.push(dashes[i][1] - dashes[i][0], Math.max(0, next - dashes[i][1]));
    }
  }
  return { name, period, base, decorations: phase ? decorations.map((s) => shift(s, -phase)) : decorations };
}

function shift(s: Stroke, dx: number): Stroke {
  if (s.kind === 'line') return { ...s, points: s.points.map(([x, y]) => [x + dx, y] as [number, number]) };
  return { ...s, x: s.x + dx };
}

function mod(a: number, n: number) {
  return ((a % n) + n) % n;
}
