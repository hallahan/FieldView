// Draw a feature library's line styles and point symbols for the map.
//
// Line styles are defined in paper millimetres, so they're drawn at a fixed
// screen size like a CAD plot: the part along the line becomes a MapLibre
// dash array, and ticks, crosses and text become a repeating line-pattern
// image laid over it. Point symbols become icons.

import type { FeatureLibrary, LineStyle, Stroke } from './fxl';

/** Screen pixels per paper millimetre (96 dpi). */
export const PX_PER_MM = 96 / 25.4;
/** Width of linework on screen, in CSS pixels. */
export const LINE_WIDTH = 2;
/** Size of point symbols, in CSS pixels. */
export const SYMBOL_SIZE = 22;

/**
 * Pixels per pattern unit, rounded so one repeat is a whole number of pixels
 * and the dashes and the decoration image never drift apart.
 */
export function patternUnit(style: LineStyle, scale: number): number {
  const period = Math.max(2, Math.round(style.period * scale * PX_PER_MM));
  return period / style.period;
}

/** The dash array for the line itself, in line widths, or solid / none. */
export function dashArray(style: LineStyle | undefined, scale: number): number[] | 'solid' | 'none' {
  if (!style || style.base === 'solid') return 'solid';
  if (style.base === 'none') return 'none';
  const unit = patternUnit(style, scale);
  // Dots are tiny dashes; keep them visible.
  return style.base.map((v, i) => Math.max(i % 2 === 0 ? 0.5 : 0, (v * unit) / LINE_WIDTH));
}

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  pixelRatio: number;
}

/** Size in CSS pixels of the style's decoration image, or undefined if it has none. */
export function decorationSize(library: FeatureLibrary, style: LineStyle, scale: number): { width: number; height: number } | undefined {
  if (!style.decorations.length) return undefined;
  const unit = patternUnit(style, scale);
  const reach = Math.max(...style.decorations.map((s) => extent(library, s)));
  // Tall enough for the furthest decoration either side, plus the stroke.
  return { width: Math.round(style.period * unit), height: Math.min(48, Math.max(6, Math.ceil(2 * reach * unit + 4))) };
}

/** One repeat of the style's decorations, centred on the line. */
export function decorationImage(
  library: FeatureLibrary,
  style: LineStyle,
  scale: number,
  color: string,
  pixelRatio: number,
): Raster | undefined {
  const size = decorationSize(library, style, scale);
  if (!size) return undefined;
  const { width, height } = size;
  const unit = patternUnit(style, scale);
  const ctx = context(width, height, pixelRatio);
  if (!ctx) return undefined;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Strokes near the ends of a repeat continue into the neighbouring ones.
  for (const dx of [-style.period, 0, style.period]) {
    ctx.save();
    ctx.translate(dx * unit, height / 2);
    ctx.scale(unit, -unit);
    for (const s of style.decorations) draw(ctx, library, s, unit);
    ctx.restore();
  }
  return raster(ctx, width, height, pixelRatio);
}

/** A point symbol, outlined so it reads on both the street map and imagery. */
export function symbolImage(library: FeatureLibrary, name: string, color: string, halo: string, pixelRatio: number): Raster | undefined {
  const symbol = library.symbols.get(name);
  if (!symbol?.strokes.length) return undefined;
  const reach = Math.max(...symbol.strokes.map((s) => extent(library, s, false)));
  if (!reach) return undefined;
  const size = SYMBOL_SIZE;
  const unit = (size / 2 - 2.5) / reach;
  const ctx = context(size, size, pixelRatio);
  if (!ctx) return undefined;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [stroke, width] of [
    [halo, 4],
    [color, 1.6],
  ] as const) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(unit, -unit);
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = width;
    for (const s of symbol.strokes) draw(ctx, library, s, unit);
    ctx.restore();
  }
  return raster(ctx, size, size, pixelRatio);
}

function context(width: number, height: number, pixelRatio: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(height * pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx?.scale(pixelRatio, pixelRatio);
  return ctx;
}

function raster(ctx: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number): Raster {
  const w = Math.ceil(width * pixelRatio);
  const h = Math.ceil(height * pixelRatio);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data, pixelRatio };
}

/**
 * Draw one stroke in pattern units (y up). `unit` is pixels per pattern unit,
 * used to keep stroke widths in pixels.
 */
function draw(ctx: CanvasRenderingContext2D, library: FeatureLibrary, s: Stroke, unit: number, depth = 0) {
  const width = ctx.lineWidth;
  ctx.lineWidth = width / unit;
  switch (s.kind) {
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
      // A zero-length line is a dot.
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      if (s.points.length === 2 && Math.hypot(b[0] - a[0], b[1] - a[1]) * unit < 1) {
        ctx.arc(a[0], a[1], (width * 0.6) / unit, 0, 2 * Math.PI);
        ctx.fill();
      } else ctx.stroke();
      break;
    }
    case 'arc': {
      const r = Math.PI / 180;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, s.start * r, (s.start + s.delta) * r, s.delta < 0);
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((s.angle * Math.PI) / 180);
      // Text is drawn upright and sized in pixels: undo the unit scale and y flip.
      ctx.scale(1 / unit, -1 / unit);
      ctx.font = `600 ${Math.max(6, s.height * unit)}px ui-monospace, monospace`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(s.text, 0, 0);
      ctx.restore();
      break;
    }
    case 'symbol': {
      const symbol = library.symbols.get(s.name);
      if (!symbol || depth > 2) break;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((s.angle * Math.PI) / 180);
      ctx.scale(s.scale, s.scale);
      ctx.lineWidth = width / s.scale;
      for (const c of symbol.strokes) draw(ctx, library, c, unit * s.scale, depth + 1);
      ctx.restore();
      break;
    }
  }
  ctx.lineWidth = width;
}

/**
 * How far a stroke reaches from the line (`across`) or from the origin in
 * any direction, in its units.
 */
function extent(library: FeatureLibrary, s: Stroke, across = true, depth = 0): number {
  const at = (x: number, y: number) => (across ? Math.abs(y) : Math.max(Math.abs(x), Math.abs(y)));
  switch (s.kind) {
    case 'line':
      return Math.max(0, ...s.points.map(([x, y]) => at(x, y)));
    case 'arc':
      return at(s.x, s.y) + s.radius;
    case 'text':
      return at(s.x, s.y) + s.height * (across ? 1 : Math.max(1, s.text.length * 0.7));
    case 'symbol': {
      const symbol = library.symbols.get(s.name);
      if (!symbol || depth > 2) return at(s.x, s.y);
      return at(s.x, s.y) + s.scale * Math.max(0, ...symbol.strokes.map((c) => extent(library, c, false, depth + 1)));
    }
  }
}
