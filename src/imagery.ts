// Moving the satellite imagery to line up with the survey. Imagery is often
// a metre or more out, and the survey is the better position, so the tiles
// are redrawn shifted by an offset rather than the points being moved.
import maplibregl, { type Map as MaplibreMap, type RasterTileSource } from 'maplibre-gl';

export const IMAGERY_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const PROTOCOL = 'ofv-imagery';
const R = 6378137;
const TILE = 256;

/** How far the imagery is moved, in metres on the ground near `lat`. */
export interface ImageryOffset {
  east: number;
  north: number;
  lat: number;
}

export const isZero = (o: ImageryOffset | undefined) => !o || (o.east === 0 && o.north === 0);

/**
 * The offset as a fraction of the Web Mercator world (x east, y down), which
 * multiplied by the world size in pixels at a zoom gives the tile shift.
 */
export function mercatorShift(o: ImageryOffset): [number, number] {
  const rad = Math.PI / 180;
  const dLon = o.east / (R * Math.cos(o.lat * rad)) / rad;
  const dLat = o.north / R / rad;
  const y = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)) / Math.PI) / 2;
  return [dLon / 360, y(o.lat + dLat) - y(o.lat)];
}

/** Metres east and north between two positions near `lat`. */
export function groundDelta(from: maplibregl.LngLat, to: maplibregl.LngLat, lat: number): [number, number] {
  const rad = Math.PI / 180;
  return [(to.lng - from.lng) * rad * R * Math.cos(lat * rad), (to.lat - from.lat) * rad * R];
}

/**
 * The source tiles a shifted tile is drawn from, with where each one goes in
 * it. A tile at z/x/y shows the imagery from `shift` pixels west and north.
 */
export function tilePieces(z: number, x: number, y: number, shiftX: number, shiftY: number) {
  const n = 2 ** z;
  const left = x * TILE - shiftX;
  const top = y * TILE - shiftY;
  const pieces: { x: number; y: number; dx: number; dy: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty * TILE < top + TILE; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx * TILE < left + TILE; tx++) {
      pieces.push({ x: ((tx % n) + n) % n, y: ty, dx: tx * TILE - left, dy: ty * TILE - top });
    }
  }
  return pieces;
}

// Decoded upstream tiles, so redrawing while dragging needs no network.
const CACHE_SIZE = 96;
const cache = new Map<string, Promise<ImageBitmap | undefined>>();

function sourceTile(z: number, x: number, y: number): Promise<ImageBitmap | undefined> {
  const url = IMAGERY_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  let hit = cache.get(url);
  if (hit) {
    cache.delete(url);
  } else {
    hit = fetch(url)
      .then((r) => (r.ok ? r.blob() : undefined))
      .then((b) => (b ? createImageBitmap(b) : undefined))
      .catch(() => {
        cache.delete(url);
        return undefined;
      });
  }
  cache.set(url, hit);
  while (cache.size > CACHE_SIZE) {
    const [oldest, bitmap] = cache.entries().next().value!;
    cache.delete(oldest);
    bitmap.then((b) => b?.close());
  }
  return hit;
}

let inFlight = 0;
let onIdle: (() => void) | undefined;

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  // ofv-imagery://z/x/y/shiftX/shiftY, the shift in fractions of the world.
  maplibregl.addProtocol(PROTOCOL, async (params) => {
    const [z, x, y, sx, sy] = params.url.slice(PROTOCOL.length + 3).split('/').map(Number);
    const world = TILE * 2 ** z;
    inFlight++;
    try {
      const pieces = tilePieces(z, x, y, sx * world, sy * world);
      const bitmaps = await Promise.all(pieces.map((p) => sourceTile(z, p.x, p.y)));
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      pieces.forEach((p, i) => bitmaps[i] && ctx.drawImage(bitmaps[i]!, p.dx, p.dy));
      return { data: await createImageBitmap(canvas) };
    } finally {
      if (--inFlight === 0) onIdle?.();
    }
  });
}

/** Tile URLs for the imagery source, shifted by the offset. */
export function imageryTiles(o: ImageryOffset | undefined): string[] {
  if (isZero(o)) return [IMAGERY_TILES];
  register();
  const [sx, sy] = mercatorShift(o!);
  return [`${PROTOCOL}://{z}/{x}/{y}/${sx}/${sy}`];
}

/**
 * Point the map's imagery source at the offset. While dragging, a redraw
 * waits for the last one to finish so slow devices don't queue them up.
 */
export function initImagery(map: MaplibreMap, sourceId: string) {
  let wanted: ImageryOffset | undefined;
  let shown = '';
  let waiting = false;

  function apply() {
    const source = map.getSource(sourceId) as RasterTileSource | undefined;
    if (!source) return;
    const tiles = imageryTiles(wanted);
    if (tiles[0] === shown) return;
    if (inFlight > 0) {
      if (!waiting) {
        waiting = true;
        onIdle = () => {
          waiting = false;
          onIdle = undefined;
          apply();
        };
        // In case a request never settles.
        setTimeout(() => waiting && onIdle?.(), 400);
      }
      return;
    }
    shown = tiles[0];
    source.setTiles(tiles);
  }

  return {
    set(o: ImageryOffset | undefined) {
      wanted = o;
      apply();
    },
    /** A new style has its own imagery source with the plain tiles. */
    styleLoaded() {
      shown = IMAGERY_TILES;
      apply();
    },
  };
}
