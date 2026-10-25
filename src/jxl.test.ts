// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './crs';
import { ecefToGeodetic, JxlParseError, parseJxl } from './jxl';
import { projectGrid } from './projection';

const sample = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');
const access2026 = readFileSync(resolve(__dirname, 'fixtures/access-2026.jxl'), 'utf8');
const withoutReductions = sample.replace(/<Reductions>[\s\S]*<\/Reductions>/, '');

describe('parseJxl', () => {
  it('reads reduced points with field book attributes', () => {
    const doc = parseJxl(sample);
    expect(doc.points.length).toBe(29);
    const tree = doc.points.find((p) => p.code === 'TREE')!;
    expect(tree.origin).toBe('Reductions');
    expect(tree.features[0].attributes).toHaveProperty('Species');
    expect(doc.metadata.find((s) => s.title === 'Job')!.entries).toContainEqual(['jobName', 'Walnut Creek Topo (sample)']);
  });

  it('classifies GNSS and total station shots in the same job', () => {
    const doc = parseJxl(sample);
    expect(doc.points.filter((p) => p.type === 'GNSS').length).toBe(14);
    expect(doc.points.filter((p) => p.type === 'Total station').length).toBe(15);
    // Total station reductions only carry grid coordinates.
    expect(doc.gridOnlyCount).toBe(15);
  });

  it('reduces total station shots when the file has no Reductions section', () => {
    const reduced = parseJxl(sample);
    const raw = parseJxl(withoutReductions);
    expect(raw.points.length).toBe(30);
    expect(raw.points.filter((p) => p.deleted).length).toBe(1);
    for (const p of reduced.points.filter((p) => p.type === 'Total station')) {
      const r = raw.points.find((q) => q.name === p.name)!;
      expect(r.coords.reduced).toBe(true);
      expect(r.coords.north!).toBeCloseTo(p.coords.north!, 3);
      expect(r.coords.east!).toBeCloseTo(p.coords.east!, 3);
      // The setup was measured by GNSS, so there's no elevation without a geoid.
      expect(r.coords.elevation).toBeUndefined();
    }
  });

  it('reduces elevations when the setup has a grid elevation', () => {
    const doc = parseJxl(sample);
    const cp1 = doc.points.find((p) => p.name === 'CP1')!.coords;
    // Key the setup in with its grid position instead of a GNSS position.
    const keyed = withoutReductions.replace(
      /(<Name>CP1<\/Name>[\s\S]*?)<WGS84>[\s\S]*?<\/WGS84>/,
      `$1<Grid><North>${cp1.north}</North><East>${cp1.east}</East><Elevation>${cp1.elevation}</Elevation></Grid>`,
    );
    const shot = parseJxl(keyed).points.find((p) => p.name === '200')!;
    const expected = doc.points.find((p) => p.name === '200')!;
    expect(shot.coords.elevation!).toBeCloseTo(expected.coords.elevation!, 3);
  });

  it('derives the orientation from the backsight when no correction is stored', () => {
    const noCorrection = withoutReductions.replace(/<OrientationCorrection>[^<]*<\/OrientationCorrection>/, '');
    const a = parseJxl(withoutReductions).points.find((p) => p.name === '200')!;
    const b = parseJxl(noCorrection).points.find((p) => p.name === '200')!;
    expect(b.coords.north!).toBeCloseTo(a.coords.north!, 3);
    expect(b.coords.east!).toBeCloseTo(a.coords.east!, 3);
  });

  it('converts ECEF and counts grid-only points', () => {
    const xml = `<JOBFile><FieldBook>
      <PointRecord ID="1"><Name>A</Name><ECEF><X>-2694892.0</X><Y>-4297418.0</Y><Z>3854579.0</Z></ECEF></PointRecord>
      <PointRecord ID="2"><Name>B</Name><Grid><North>1000</North><East>2000</East></Grid></PointRecord>
    </FieldBook></JOBFile>`;
    const doc = parseJxl(xml);
    expect(doc.points[0].coords.source).toBe('ECEF');
    expect(doc.points[0].type).toBe('GNSS');
    expect(doc.points[0].coords.lat).toBeCloseTo(37.4, 1);
    expect(doc.gridOnlyCount).toBe(1);
  });

  it('rejects non-JobXML input', () => {
    expect(() => parseJxl('<foo/>')).toThrow(JxlParseError);
    expect(() => parseJxl('not xml')).toThrow(JxlParseError);
  });
});

describe('coordinate system', () => {
  it('detects NAD83(2011) California zone 3 and the epoch', () => {
    const { crs } = parseJxl(sample);
    expect(crs.projection?.id).toBe('EPSG:6419');
    expect(crs.epochs).toEqual(['2017.50']);
    expect(crs.distanceUnits).toBe('USSurveyFeet');
  });

  it('finds an epoch written into the datum name', () => {
    const xml = sample
      .replace(/<ReferenceEpoch>[^<]*<\/ReferenceEpoch>/, '')
      .replace('<DatumName>NAD 1983 (2011)</DatumName>', '<DatumName>NAD83(2011) Epoch 2025.00</DatumName>');
    expect(parseJxl(xml).crs.epochs).toEqual(['2025.00']);
  });

  it.each([
    ['California Zone 3 0403', true],
    ['CA Zone III', true],
    ['Zone 0403', true],
    ['California 3', true],
    ['California Zone 4 0404', false],
    ['California Zone 2 0402', false],
  ])('matches zone name %s: %s', (zone, ok) => {
    expect(PRESETS[0].match.test(`US State Plane 1983 ${zone}`)).toBe(ok);
  });

  it('places grid points where GNSS put them', () => {
    const doc = parseJxl(sample);
    const gnss = doc.points.find((p) => p.type === 'GNSS')!;
    const { lat, lon } = gnss.coords;
    Object.assign(gnss.coords, { lat: undefined, lon: undefined, source: undefined });
    projectGrid(doc.points, PRESETS[0].proj4);
    expect(gnss.coords.lat!).toBeCloseTo(lat!, 8);
    expect(gnss.coords.lon!).toBeCloseTo(lon!, 8);
  });
});

describe('Trimble Access 2025/2026 exports', () => {
  it('reads the epoch from the datum record, not from transformation records', () => {
    const { crs } = parseJxl(access2026);
    expect(crs.referenceFrame).toBe('NAD83(2011)');
    expect(crs.epochs).toEqual(['2025.00']);
  });

  it('builds the projection from the projection record', () => {
    const { crs } = parseJxl(access2026);
    expect(crs.projection?.proj4).toMatch(/\+proj=lcc .*\+lat_1=38.433333333333 .*\+x_0=2000000 \+y_0=500000/);
    expect(crs.projection?.label).toContain('California zone 3');
  });

  it('removes the site calibration when placing grid-only points', () => {
    const doc = parseJxl(access2026);
    expect(doc.crs.adjustment?.translationNorth).toBe(0.065);
    const gnss = doc.points.find((p) => p.name === '1000')!;
    const { lat, lon } = gnss.coords;
    Object.assign(gnss.coords, { lat: undefined, lon: undefined, source: undefined });
    projectGrid(doc.points, doc.crs.projection!.proj4, doc.crs.adjustment);
    // 1e-8 degrees is about 1 mm.
    expect(Math.abs(gnss.coords.lat! - lat!)).toBeLessThan(1e-8);
    expect(Math.abs(gnss.coords.lon! - lon!)).toBeLessThan(1e-8);
  });

  it('uses the ITRF2014 to NAD83(2011) transformation stored in the job', () => {
    const { crs } = parseJxl(access2026);
    expect(crs.nad83).toBe(true);
    const [toNad83, toItrf2014] = crs.datumChain;
    expect(toNad83.name).toContain('from job');
    expect(toNad83.r[0]).toBe(-26.7815);
    expect(toNad83.dr[1]).toBe(0.75749);
    // The fixture's ITRF2020 entry has no parameters, so the IERS values are used.
    expect(toItrf2014.name).toBe('ITRF2020 to ITRF2014 (IERS)');
  });

  it('classifies keyed-in control, GNSS and offset points', () => {
    const doc = parseJxl(access2026);
    expect(doc.points.map((p) => [p.name, p.type])).toEqual([
      ['CTRL1', 'Keyed in'],
      ['1000', 'GNSS'],
      ['1001', 'Computed'],
    ]);
  });

  it('drops empty metadata fields and XML namespace attributes', () => {
    const doc = parseJxl(access2026);
    expect(doc.metadata.find((s) => s.title === 'Job properties')).toBeUndefined();
    expect(doc.metadata.find((s) => s.title === 'Job')!.entries.map(([k]) => k)).not.toContain('xmlns:xsi');
  });
});

describe('ecefToGeodetic', () => {
  it('handles a point on the equator', () => {
    const { lat, lon, height } = ecefToGeodetic(6378137, 0, 0);
    expect(lat).toBeCloseTo(0, 9);
    expect(lon).toBeCloseTo(0, 9);
    expect(height).toBeCloseTo(0, 3);
  });
});
