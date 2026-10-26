// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJxl } from './jxl';
import {
  applyPlacement,
  bearingFromPin,
  canPlace,
  formatDms,
  fromPin,
  initialPlacement,
  newer,
  parseAngle,
  placeGrid,
  removePlacement,
  repin,
  samePlacement,
  type Placement,
} from './placement';

const sample = () => parseJxl(readFileSync(resolve(__dirname, '../public/sample-local.jxl'), 'utf8'));
const pl = (o: Partial<Placement> = {}): Placement => ({ north: 3048, east: 3048, lat: 37.9, lon: -122.06, rotation: 0, updated: '2026-10-26T00:00:00Z', ...o });

describe('placeGrid', () => {
  it('puts the pin where it was put', () => {
    expect(placeGrid(pl(), 3048, 3048)).toEqual([37.9, -122.06]);
  });

  it('keeps distances as measured', () => {
    const p = pl({ rotation: 33 });
    const [lat, lon] = placeGrid(p, 3048 + 60, 3048 - 80);
    const [e, n] = fromPin(p, lat, lon);
    expect(Math.hypot(e, n)).toBeCloseTo(100, 6);
  });

  it('turns job bearings by the rotation', () => {
    const p = pl({ rotation: 12.5 });
    const [lat, lon] = placeGrid(p, 3048 + 100, 3048);
    expect(bearingFromPin(p, lat, lon)).toBeCloseTo(12.5, 9);
    const [lat2, lon2] = placeGrid(p, 3048, 3048 + 100);
    expect(bearingFromPin(p, lat2, lon2)).toBeCloseTo(102.5, 9);
  });

  it('a degree of latitude is about 111 km', () => {
    const [lat] = placeGrid(pl({ lat: 0, lon: 0 }), 3048 + 110574.4, 3048);
    expect(lat).toBeCloseTo(1, 4);
  });
});

describe('repin', () => {
  it('moves the pin without moving the job', () => {
    const p = pl({ rotation: -47 });
    const q = repin(p, 3100, 2990);
    for (const [n, e] of [
      [3000, 3000],
      [3200, 3100],
    ]) {
      const a = placeGrid(p, n, e);
      const b = placeGrid(q, n, e);
      expect(b[0]).toBeCloseTo(a[0], 8);
      expect(b[1]).toBeCloseTo(a[1], 8);
    }
  });
});

describe('a job in assumed coordinates', () => {
  it('has grid positions only, so it can be placed', () => {
    const doc = sample();
    expect(doc.crs.projection).toBeUndefined();
    const cp1 = doc.points.find((p) => p.name === 'CP1')!;
    expect(cp1.coords.north! / (1200 / 3937)).toBeCloseTo(10000, 3);
    expect(doc.points.filter((p) => p.coords.reduced).length).toBeGreaterThan(20);
    expect(canPlace(doc.points)).toBe(true);
  });

  it('is pinned near its middle and placed by hand', () => {
    const doc = sample();
    const p = initialPlacement(doc.points, 37.9, -122.06, '2026-10-26T00:00:00Z')!;
    expect(doc.points.some((q) => q.coords.north === p.north && q.coords.east === p.east && q.type !== 'Keyed in')).toBe(true);
    expect(applyPlacement(doc.points, p)).toBe(doc.points.length);
    expect(doc.points.every((q) => q.coords.source === 'Placed' && q.coords.lat !== undefined)).toBe(true);
    // Placing again moves the same points.
    expect(applyPlacement(doc.points, { ...p, rotation: 10 })).toBe(doc.points.length);
    removePlacement(doc.points);
    expect(doc.points.every((q) => q.coords.lat === undefined && q.coords.source === undefined)).toBe(true);
  });

  it("isn't offered for a job measured by GNSS", () => {
    const doc = parseJxl(readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8'));
    expect(canPlace(doc.points)).toBe(false);
  });
});

describe('saved placements', () => {
  it('picks the newer one', () => {
    const a = pl({ updated: '2026-10-26T10:00:00Z' });
    const b = pl({ updated: '2026-10-26T11:00:00Z', rotation: 4 });
    expect(newer(a, b)).toBe(b);
    expect(newer(undefined, a)).toBe(a);
    expect(newer(undefined, undefined)).toBeUndefined();
  });

  it('compares positions, not when they were saved', () => {
    expect(samePlacement(pl(), pl({ updated: 'later' }))).toBe(true);
    expect(samePlacement(pl(), pl({ rotation: 1 }))).toBe(false);
    expect(samePlacement(undefined, undefined)).toBe(true);
    expect(samePlacement(pl(), undefined)).toBe(false);
  });
});

describe('angles', () => {
  it('reads decimal degrees and DMS', () => {
    expect(parseAngle('12.5')).toBe(12.5);
    expect(parseAngle('-3.25')).toBe(-3.25);
    expect(parseAngle(`12°30'15"`)).toBeCloseTo(12.504166667, 9);
    expect(parseAngle('12 30 15')).toBeCloseTo(12.504166667, 9);
    expect(parseAngle('-0d30m')).toBe(-0.5);
    expect(parseAngle(`359°59'59.9"`)).toBeCloseTo(359.99997222, 8);
  });

  it('refuses what it cannot read', () => {
    expect(parseAngle('')).toBeUndefined();
    expect(parseAngle('abc')).toBeUndefined();
    expect(parseAngle('12 75')).toBeUndefined();
    expect(parseAngle('1 2 3 4')).toBeUndefined();
    expect(parseAngle('N12E')).toBeUndefined();
  });

  it('writes DMS that reads back', () => {
    expect(formatDms(12.504166667)).toBe(`12°30'15.0"`);
    expect(formatDms(-0.5)).toBe(`-0°30'00.0"`);
    expect(formatDms(0)).toBe(`0°00'00.0"`);
    expect(formatDms(29.99999999)).toBe(`30°00'00.0"`);
    for (const a of [0.1234, -45.6789, 179.99]) expect(parseAngle(formatDms(a))).toBeCloseTo(a, 4);
  });
});
