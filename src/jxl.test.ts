// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ecefToGeodetic, JxlParseError, parseJxl } from './jxl';

const sample = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');

describe('parseJxl', () => {
  it('reads reduced points with positions and field book attributes', () => {
    const doc = parseJxl(sample);
    expect(doc.points.length).toBe(39);
    expect(doc.points.every((p) => p.coords.source === 'WGS84')).toBe(true);
    const tree = doc.points.find((p) => p.code === 'TREE')!;
    expect(tree.origin).toBe('Reductions');
    expect(tree.features[0].attributes).toHaveProperty('Species');
    expect(tree.attributes['FieldBook.Method']).toBe('RTK');
    expect(doc.metadata.find((s) => s.title === 'Job')!.entries).toContainEqual(['jobName', 'Sample Downtown Topo']);
  });

  it('falls back to field book records when there are no reductions', () => {
    const doc = parseJxl(sample.replace(/<Reductions>[\s\S]*<\/Reductions>/, ''));
    expect(doc.points.length).toBe(40);
    expect(doc.points.filter((p) => p.deleted).length).toBe(1);
  });

  it('converts ECEF and counts grid-only points', () => {
    const xml = `<JOBFile><FieldBook>
      <PointRecord ID="1"><Name>A</Name><ECEF><X>-2694892.0</X><Y>-4297418.0</Y><Z>3854579.0</Z></ECEF></PointRecord>
      <PointRecord ID="2"><Name>B</Name><Grid><North>1000</North><East>2000</East></Grid></PointRecord>
    </FieldBook></JOBFile>`;
    const doc = parseJxl(xml);
    expect(doc.points[0].coords.source).toBe('ECEF');
    expect(doc.points[0].coords.lat).toBeCloseTo(37.4, 1);
    expect(doc.gridOnlyCount).toBe(1);
  });

  it('rejects non-JobXML input', () => {
    expect(() => parseJxl('<foo/>')).toThrow(JxlParseError);
    expect(() => parseJxl('not xml')).toThrow(JxlParseError);
  });
});

describe('ecefToGeodetic', () => {
  it('round-trips a known point', () => {
    const { lat, lon, height } = ecefToGeodetic(6378137, 0, 0);
    expect(lat).toBeCloseTo(0, 9);
    expect(lon).toBeCloseTo(0, 9);
    expect(height).toBeCloseTo(0, 3);
  });
});
