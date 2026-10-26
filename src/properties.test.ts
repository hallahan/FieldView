// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJxl } from './jxl';
import { dms, formatProp, humanize, latLonDms, type PropGroup } from './properties';

const sample = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');
const access2026 = readFileSync(resolve(__dirname, 'fixtures/access-2026.jxl'), 'utf8');
const metres = { label: 'm', metres: 1 };

function group(groups: PropGroup[], title: string): Record<string, string> {
  const g = groups.find((x) => x.title === title);
  return Object.fromEntries((g?.props ?? []).map((p) => [p.label, formatProp(p, metres)]));
}

describe('point properties', () => {
  it('summarises GNSS quality, antenna, tilt and notes', () => {
    const p = parseJxl(access2026).points.find((x) => x.name === '1000')!;
    expect(p.method).toBe('GNSS observation');
    expect(p.surveyMethod).toBe('Network RTK');
    expect(p.stored).toBe('2026-09-24T10:58:02');
    const q = group(p.observation, 'GNSS quality');
    expect(q['Horizontal precision']).toBe('0.010 m');
    expect(q.Satellites).toBe('24 (GPS 8, GLONASS 7, Galileo 9)');
    expect(q.PDOP).toBe('1.1');
    expect(q.Occupation).toBe('2 s');
    expect(q['Warnings at storage']).toBe('Poor precisions');
    expect(q['RTK base']).toBe('BASE');
    expect(q['Monitor status']).toBeUndefined();
    const a = group(p.observation, 'Antenna');
    expect(a['Antenna height']).toBe('2.000 m');
    expect(a['Antenna type']).toBe('R12i Internal');
    const t = group(p.observation, 'Tilt');
    expect(t['Tilt method']).toBe('IMU tilt compensation');
    expect(t['Pole tilt']).toBe('5.00°');
    expect(group(p.observation, 'Notes')['Note 1']).toBe('Old values BARB BL');
  });

  it('shows the total station observation', () => {
    const p = parseJxl(sample).points.find((x) => x.name === '200')!;
    const ts = group(p.observation, 'Total station');
    expect(ts.Station).toBe('CP1');
    expect(ts.Backsight).toBe('CP2');
    expect(ts['Horizontal angle']).toBe(dms(284.80258182));
    expect(ts['Slope distance']).toBe('81.922 m');
    expect(ts['Target height']).toBe('1.800 m');
    expect(ts['Prism constant']).toBe('-30.0 mm');
    expect(p.observation.find((g) => g.title === 'GNSS quality')).toBeUndefined();
  });

  it('formats angles and names', () => {
    expect(dms(284.80258182)).toBe(`284°48'09.29"`);
    expect(dms(0.9999999)).toBe(`1°00'00.00"`);
    expect(latLonDms(-121.9408146, 'E', 'W')).toBe(`121°56'26.93256"W`);
    expect(humanize('NetworkRTK')).toBe('Network RTK');
    expect(humanize('AINSAlignment')).toBe('AINS alignment');
    expect(formatProp({ label: 'h', value: 1, kind: 'length' }, { label: 'sft', metres: 1200 / 3937 })).toBe('3.281 sft');
  });
});
