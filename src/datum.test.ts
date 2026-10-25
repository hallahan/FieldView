import { describe, expect, it } from 'vitest';
import {
  applyPlaneAdjustment,
  currentEpoch,
  ITRF2014_TO_NAD83_2011,
  ITRF2020_TO_ITRF2014,
  nad83ToWgs84,
  removePlaneAdjustment,
  type PlaneAdjustment,
} from './datum';

const dms = (d: number, m: number, s: number) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);
const metres = (dLat: number, dLon: number, lat: number) =>
  Math.hypot(dLat * 111_320, dLon * 111_320 * Math.cos((lat * Math.PI) / 180));

describe('nad83ToWgs84', () => {
  // NGS published coordinates for CORS CCCC (California), both at epoch 2010.0.
  // https://www.ngs.noaa.gov/corsdata/coord/coord_14/cccc_14.coord.txt
  it('matches NGS for CORS CCCC', () => {
    const nad = { lat: dms(35, 33, 55.11846), lon: -dms(117, 40, 16.17436), h: 814.659 };
    const itrf = { lat: dms(35, 33, 55.13188), lon: -dms(117, 40, 16.22541), h: 813.973 };
    const out = nad83ToWgs84(nad.lat, nad.lon, nad.h, 2010.0, [ITRF2014_TO_NAD83_2011]);
    expect(metres(out.lat - itrf.lat, out.lon - itrf.lon, itrf.lat)).toBeLessThan(0.01);
    expect(out.height).toBeCloseTo(itrf.h, 2);
  });

  it('adds the ITRF2014 to ITRF2020 step, about a centimetre', () => {
    const to2014 = nad83ToWgs84(37.3179, -121.9407, 10, 2026.8, [ITRF2014_TO_NAD83_2011]);
    const to2020 = nad83ToWgs84(37.3179, -121.9407, 10, 2026.8);
    const d = metres(to2020.lat - to2014.lat, to2020.lon - to2014.lon, 37.3179);
    expect(d).toBeGreaterThan(0.0005);
    expect(d).toBeLessThan(0.02);
    expect(to2020.height - to2014.height).not.toBe(0);
    expect(ITRF2020_TO_ITRF2014.epoch).toBe(2015);
  });

  it('moves California points about 1.5 m', () => {
    const out = nad83ToWgs84(37.3179, -121.9407, 10, 2026.8);
    const d = metres(out.lat - 37.3179, out.lon + 121.9407, 37.3179);
    expect(d).toBeGreaterThan(1.2);
    expect(d).toBeLessThan(2.0);
  });
});

describe('plane adjustment', () => {
  const adj: PlaneAdjustment = {
    originNorth: 600000,
    originEast: 1870000,
    translationNorth: 0.07,
    translationEast: -0.043,
    rotation: -0.0000091,
    scale: 1.0000001,
  };

  it('round-trips', () => {
    const [n, e] = applyPlaneAdjustment(adj, 591754.8, 1872310.3);
    const [n2, e2] = removePlaneAdjustment(adj, n, e);
    expect(n2).toBeCloseTo(591754.8, 6);
    expect(e2).toBeCloseTo(1872310.3, 6);
  });

  it('rotates about the origin in degrees', () => {
    // 10 km north of the origin, a -0.0000091° rotation moves the point ~1.6 mm west.
    const [, e] = applyPlaneAdjustment({ ...adj, translationNorth: 0, translationEast: 0, scale: 1 }, 610000, 1870000);
    expect(e - 1870000).toBeCloseTo(-10000 * Math.sin((0.0000091 * Math.PI) / 180), 9);
  });
});

it('currentEpoch is a decimal year', () => {
  expect(currentEpoch(new Date(Date.UTC(2025, 0, 1)))).toBe(2025);
  expect(currentEpoch(new Date(Date.UTC(2025, 6, 2, 12)))).toBeCloseTo(2025.5, 2);
});
