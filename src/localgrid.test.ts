import { describe, expect, it } from 'vitest';
import { gridFeatures, gridLabel, gridStep } from './localgrid';
import { fromPin, placeGrid, toGrid, type Placement } from './placement';

const FT = 1200 / 3937;
const frame: Placement = { north: 3048, east: 3048, lat: 0, lon: 0, rotation: 0, updated: '' };

describe('local grid', () => {
  it('picks round spacings', () => {
    expect(gridStep(100)).toBe(20);
    expect(gridStep(260)).toBe(100);
    expect(gridStep(40)).toBe(10);
    expect(gridStep(3)).toBe(1);
    expect(gridStep(0.4)).toBe(0.1);
  });

  it('labels in the job unit with only the decimals the spacing needs', () => {
    expect(gridLabel('N', 10050 * FT, FT, 50)).toBe('N 10050');
    expect(gridLabel('E', 3048.15, 1, 0.1)).toBe('E 3048.2');
    expect(gridLabel('E', 3048.15, 1, 0.05)).toBe('E 3048.15');
  });

  it('turns map positions back into grid coordinates', () => {
    const p = { ...frame, rotation: 31 };
    const [lat, lon] = placeGrid(p, 3100, 2950);
    const [n, e] = toGrid(p, lat, lon);
    expect(n).toBeCloseTo(3100, 6);
    expect(e).toBeCloseTo(2950, 6);
  });

  it('draws lines on round northings and eastings across the view', () => {
    // A view 250 ft square around the pin.
    const [s, w] = placeGrid(frame, 3048 - 125 * FT, 3048 - 125 * FT);
    const [n, e] = placeGrid(frame, 3048 + 125 * FT, 3048 + 125 * FT);
    const fc = gridFeatures(frame, [w, s, e, n], FT);
    const labels = fc.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties!.label);
    // 10000 ft is the pin; lines every 50 ft.
    expect(labels).toContain('N 10000');
    expect(labels).toContain('E 10050');
    expect(labels).toContain('N 9900');
    expect(labels.filter((l) => l.startsWith('E')).length).toBe(5);
    // Grid lines run true north–south and east–west, at the stated value.
    const line = fc.features.find((f) => f.geometry.type === 'LineString')!;
    const [[lon0, lat0], [lon1, lat1]] = (line.geometry as GeoJSON.LineString).coordinates;
    expect(lon1).toBeCloseTo(lon0, 12);
    expect(lat1).toBeGreaterThan(lat0);
    const [east] = fromPin(frame, lat0, lon0);
    expect(((east + 3048) / FT) % 50).toBeCloseTo(0, 6);
  });
});
