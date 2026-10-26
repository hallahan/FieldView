import { describe, expect, it } from 'vitest';
import maplibregl from 'maplibre-gl';
import { groundDelta, imageryTiles, IMAGERY_TILES, mercatorShift, tilePieces } from './imagery';

describe('imagery offset', () => {
  it('converts metres to a Mercator shift and back', () => {
    const lat = 38.5;
    const [sx, sy] = mercatorShift({ east: 2, north: -1.5, lat });
    // At z19 a Mercator pixel is about 0.234 m on the ground at 38.5°N.
    const world = 256 * 2 ** 19;
    const metresPerPixel = (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / world;
    expect(sx * world * metresPerPixel).toBeCloseTo(2, 3);
    // y grows southwards.
    expect(sy * world * metresPerPixel).toBeCloseTo(1.5, 3);
  });

  it('measures a drag in metres', () => {
    const lat = 38.5;
    const from = new maplibregl.LngLat(-121.5, lat);
    const [east, north] = groundDelta(from, new maplibregl.LngLat(-121.5 + 1e-5, lat + 1e-5), lat);
    expect(east).toBeCloseTo(0.8713, 3);
    expect(north).toBeCloseTo(1.1132, 3);
  });

  it('uses the plain imagery when not moved', () => {
    expect(imageryTiles(undefined)).toEqual([IMAGERY_TILES]);
    expect(imageryTiles({ east: 0, north: 0, lat: 38 })).toEqual([IMAGERY_TILES]);
  });

  it('draws a shifted tile from the tiles west and north of it', () => {
    // Imagery moved 10 px east and 5 px south.
    const pieces = tilePieces(19, 100, 200, 10, 5);
    expect(pieces).toEqual([
      { x: 99, y: 199, dx: -246, dy: -251 },
      { x: 100, y: 199, dx: 10, dy: -251 },
      { x: 99, y: 200, dx: -246, dy: 5 },
      { x: 100, y: 200, dx: 10, dy: 5 },
    ]);
  });

  it('needs one tile for a whole-tile shift and wraps round the antimeridian', () => {
    expect(tilePieces(2, 0, 1, 256, 0)).toEqual([{ x: 3, y: 1, dx: 0, dy: 0 }]);
    // Nothing above the top of the world.
    expect(tilePieces(2, 1, 0, 0, 3).every((p) => p.y === 0)).toBe(true);
  });
});
