// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './crs';
import { gridFitsProjection, projectGrid } from './projection';
import { fitSimilarity, isRw5, parseAngle, parseRw5, Rw5ParseError } from './rw5';

// Synthetic files: observations computed from known coordinates (the *-truth.json files).
const sample = readFileSync(resolve(__dirname, '../public/sample.rw5'), 'utf8');
const sampleTruth: Record<string, { n: number; e: number; z: number }> = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/assumed-truth.json'), 'utf8'),
);
const localized = readFileSync(resolve(__dirname, 'fixtures/gps-localized.rw5'), 'utf8');
const localizedTruth: Record<string, { lat: number; lon: number }> = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/gps-localized-truth.json'), 'utf8'),
);
const USFT = 1200 / 3937;
const sjxl = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');

describe('isRw5', () => {
  it('tells RW5 from JobXML', () => {
    expect(isRw5(sample)).toBe(true);
    expect(isRw5(localized)).toBe(true);
    expect(isRw5(sjxl)).toBe(false);
    expect(isRw5('hello, world')).toBe(false);
  });
});

describe('parseAngle', () => {
  it('reads DDD.MMSS', () => {
    expect(parseAngle('90.3015', false)).toBeCloseTo(90 + 30 / 60 + 15 / 3600, 10);
    expect(parseAngle('0.0044', false)).toBeCloseTo(44 / 3600, 10);
    expect(parseAngle('-122.0354000009', false)).toBeCloseTo(-(122 + 3 / 60 + 54.000009 / 3600), 10);
    expect(parseAngle('100', true)).toBeCloseTo(90, 10);
    expect(parseAngle('abc', false)).toBeUndefined();
  });
});

describe('parseRw5', () => {
  it('reads the job, units and codes', () => {
    const doc = parseRw5(sample);
    expect(doc.format).toBe('rw5');
    expect(doc.job.jobName).toBe('Assumed Topo');
    expect(doc.crs.distanceUnits).toBe('US survey feet');
    expect(doc.points.find((p) => p.name === '100')!.code).toBe('PCC1 BL');
    expect(doc.points.find((p) => p.name === '106')!.observation.find((g) => g.title === 'Notes')!.props[0].value).toBe('Oak 24in');
  });

  it('reduces side shots, traverses and angle sets to the true coordinates', () => {
    const doc = parseRw5(sample);
    for (const [name, t] of Object.entries(sampleTruth)) {
      const p = doc.points.find((q) => q.name === name && q.classification !== 'Check shot')!;
      expect(p, name).toBeDefined();
      // The doc is in metres; the truth is in the file's US feet.
      expect(p.coords.north! / USFT, name).toBeCloseTo(t.n, 2);
      expect(p.coords.east! / USFT, name).toBeCloseTo(t.e, 2);
      expect(p.coords.elevation! / USFT, name).toBeCloseTo(t.z, 2);
      expect(p.coords.reduced).toBe(true);
    }
    const set = doc.points.find((p) => p.name === '3')!;
    expect(set.method).toBe('Angle set (4 observations)');
  });

  it('keeps check shots from moving known points', () => {
    const doc = parseRw5(sample);
    const checks = doc.points.filter((p) => p.classification === 'Check shot');
    expect(checks.map((p) => p.name).sort()).toEqual(['1', '2']);
    const cp1 = doc.points.find((p) => p.name === '1' && p.type === 'Keyed in')!;
    expect(cp1.coords.north! / USFT).toBe(5000);
    // The check shot to 1 from 3 closes on it.
    const chk = checks.find((p) => p.name === '1')!;
    expect(chk.coords.north! / USFT).toBeCloseTo(5000, 2);
  });

  it('leaves assumed coordinates off the map', () => {
    const doc = parseRw5(sample);
    expect(doc.points.every((p) => p.coords.lat === undefined)).toBe(true);
    expect(gridFitsProjection(doc.points, PRESETS[0].proj4)).toBe(false);
  });

  it('honours a units override', () => {
    const doc = parseRw5(sample, { units: 'm' });
    expect(doc.points.find((p) => p.name === '1')!.coords.north).toBe(5000);
    expect(doc.crs.entries).toContainEqual(['Distance units', 'Metres (file says US survey feet)']);
  });

  it('reads GPS records with their quality and local grid', () => {
    const doc = parseRw5(localized);
    const gps = doc.points.filter((p) => p.type === 'GNSS');
    expect(gps.length).toBe(3);
    const p = gps[0];
    expect(p.coords.lat).toBeCloseTo(localizedTruth['101'].lat, 8);
    expect(p.coords.lon).toBeCloseTo(localizedTruth['101'].lon, 8);
    expect(p.coords.north! / USFT).toBeCloseTo(10000, 4);
    const quality = p.observation.find((g) => g.title === 'GNSS')!.props;
    expect(quality).toContainEqual({ label: 'Horizontal RMS', value: 0.012, kind: 'length' });
    expect(quality).toContainEqual({ label: 'Base point', value: 'BASE1' });
  });

  it('places total station shots on a localized grid through the GPS points', () => {
    const doc = parseRw5(localized);
    expect(doc.gridOnlyCount).toBe(0);
    for (const name of ['200', '201', '202']) {
      const p = doc.points.find((q) => q.name === name)!;
      expect(p.coords.source).toBe('Localized');
      // Within a few millimetres.
      expect(Math.abs(p.coords.lat! - localizedTruth[name].lat) * 111_000).toBeLessThan(0.005);
      expect(Math.abs(p.coords.lon! - localizedTruth[name].lon) * 88_000).toBeLessThan(0.005);
    }
    const loc = doc.crs.entries.find(([k]) => k === 'Localization from GPS points')!;
    expect(loc[1]).toMatch(/^3 points, 0\.00\d m RMS, rotation -1°15′/);
  });

  it('places State Plane total station work with the chosen projection', () => {
    // A small traverse on real CA zone 3 coordinates, in US feet.
    const text = [
      'JB,NMSPC,DT10-26-2026,TM10:00:00',
      'MO,AD0,UN2,SF1.00000000,EC0,EO0.0,AU0',
      'OC,OP1,N 2156231.000,E 6110171.000,EL40.000,--CP',
      'LS,HI5.000000,HR5.000000',
      'BK,OP1,BP2,BS45.0000,BC0.0000',
      'SS,OP1,FP10,AR90.0000,ZE90.0000,SD100.0000,--EP',
    ].join('\n');
    const doc = parseRw5(text);
    const shot = doc.points.find((p) => p.name === '10')!;
    expect(shot.coords.north! / USFT).toBeCloseTo(2156231 - 100 * Math.SQRT1_2, 3);
    expect(shot.coords.east! / USFT).toBeCloseTo(6110171 + 100 * Math.SQRT1_2, 3);
    expect(gridFitsProjection(doc.points, PRESETS[0].proj4)).toBe(true);
    expect(projectGrid(doc.points, PRESETS[0].proj4)).toBe(2);
    expect(shot.coords.lat).toBeCloseTo(37.906, 2);
  });

  it('handles azimuths, bearings, vertical angles and curvature', () => {
    const text = [
      'MO,AD0,UN1,SF1.00000000,EC0,EO0.0,AU0',
      'OC,OP1,N 1000.000,E 1000.000,EL10.000',
      'LS,HI1.500000,HR2.000000',
      'SS,OP1,FP2,AZ90.0000,VA0.0000,SD50.0000',
      'SS,OP1,FP3,BRS45.0000W,ZE90.0000,HD10.0000',
      'SS,OP1,FP4,AZ0.0000,CE-3.0000,HD20.0000',
    ].join('\n');
    const doc = parseRw5(text);
    const at = (n: string) => doc.points.find((p) => p.name === n)!.coords;
    expect(at('2').east).toBeCloseTo(1050, 6);
    expect(at('2').elevation).toBeCloseTo(9.5, 6);
    expect(at('3').north).toBeCloseTo(1000 - 10 * Math.SQRT1_2, 6);
    expect(at('3').east).toBeCloseTo(1000 - 10 * Math.SQRT1_2, 6);
    expect(at('4').north).toBeCloseTo(1020, 6);
    expect(at('4').elevation).toBeCloseTo(7, 6);
    // Earth curvature and refraction add (1 - 0.14) d² / 2R.
    const curved = parseRw5(text.replace('EC0', 'EC1'));
    expect(curved.points.find((p) => p.name === '2')!.coords.elevation! - 9.5).toBeCloseTo((0.86 * 2500) / (2 * 6371000), 9);
  });

  it('rejects files with no points', () => {
    expect(() => parseRw5('JB,NMEmpty\nMO,AD0,UN1')).toThrow(Rw5ParseError);
  });
});

describe('fitSimilarity', () => {
  it('recovers a rotation and scale', () => {
    const rot = (10 * Math.PI) / 180;
    const pts: [number, number][] = [[0, 0], [100, 0], [0, 100], [50, 70]];
    const pairs = pts.map(([x, y]) => ({
      from: [x, y] as const,
      to: [5 + 2 * (x * Math.cos(rot) - y * Math.sin(rot)), 7 + 2 * (x * Math.sin(rot) + y * Math.cos(rot))] as const,
    }));
    const fit = fitSimilarity(pairs)!;
    expect(fit.scale).toBeCloseTo(2, 10);
    expect(fit.rotation).toBeCloseTo(10, 10);
    expect(fit.rms).toBeLessThan(1e-9);
  });
});
