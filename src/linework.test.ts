// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineString, Polygon, Position } from 'geojson';
import { parseFxl } from './fxl';
import type { JxlPoint } from './jxl';
import { buildLinework, offsetPolyline, parseCode, rectangle } from './linework';

const lib = parseFxl(readFileSync(resolve(__dirname, 'fixtures/library.fxl'), 'utf8'), 'library.fxl');

// Metres east/north of a spot in Sacramento, as map positions.
const LAT0 = 38.5;
const LON0 = -121.5;
const M_LAT = 1 / 111195;
const M_LON = M_LAT / Math.cos((LAT0 * Math.PI) / 180);

// Only the fields linework reads, so the helper keeps compiling as JxlPoint
// gains fields.
type LineworkInput = Pick<JxlPoint, 'index' | 'name' | 'code' | 'coords' | 'deleted'>;

function points(rows: [string, string, number, number][]): JxlPoint[] {
  return rows.map(
    ([name, code, e, n], index): LineworkInput => ({
      index,
      name,
      code,
      coords: { lat: LAT0 + n * M_LAT, lon: LON0 + e * M_LON, mapLat: LAT0 + n * M_LAT, mapLon: LON0 + e * M_LON },
      deleted: false,
    }),
  ) as JxlPoint[];
}

/** Back to local metres, rounded to the millimetre. */
const local = (c: Position) => [Math.round(((c[0] - LON0) / M_LON) * 1000) / 1000, Math.round(((c[1] - LAT0) / M_LAT) * 1000) / 1000];
const coordsOf = (g: LineString | Polygon) => (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates).map(local);

describe('parseCode', () => {
  it('attaches control codes to the feature code before them', () => {
    expect(parseCode('BARB EL BARB1 BL', lib).map((t) => [t.code, t.controls.map((c) => c.action)])).toEqual([
      ['BARB', ['end']],
      ['BARB1', ['start']],
    ]);
    expect(parseCode('DIKB1 PCC1 BL R3', lib).map((t) => [t.code, t.def?.code, t.controls.length])).toEqual([
      ['DIKB1', undefined, 0],
      ['PCC1', 'PCC', 2],
    ]);
  });

  it('reads the value after a join or a radius', () => {
    expect(parseCode('PCC JP 1001', lib)[0].controls[0]).toMatchObject({ action: 'join', value: '1001' });
    expect(parseCode('TREE C2 1.5', lib)[0].controls[0]).toMatchObject({ action: 'circleCenter', value: '1.5' });
    // A code after a rectangle isn't its width.
    expect(parseCode('PCC BL R3 EGL', lib).map((t) => t.code)).toEqual(['PCC', 'EGL']);
  });
});

describe('buildLinework', () => {
  it('joins points by code in order, with string numbers kept apart', () => {
    const lw = buildLinework(
      points([
        ['1', 'PCC1 BL', 0, 0],
        ['2', 'PCC2 BL', 0, 5],
        ['3', 'PCC1', 10, 0],
        ['4', 'PCC2', 10, 5],
        ['5', 'PCC1 EL', 20, 0],
        ['6', 'PCC1', 30, 0],
        ['7', 'PCC1', 40, 0],
      ]),
      lib,
    );
    const byCode = lw.lines.features.map((f) => [f.properties.code, coordsOf(f.geometry)]);
    expect(byCode).toEqual([
      ['PCC1', [[0, 0], [10, 0], [20, 0]]],
      ['PCC2', [[0, 5], [10, 5]]],
      // After an end, the next point with the code starts a new line.
      ['PCC1', [[30, 0], [40, 0]]],
    ]);
    expect(lw.lines.features[0].properties).toMatchObject({ feature: 'PCC', color: '#ffffff', lineStyle: 'Dashed 3-1', scale: 2.35 });
    expect([...lw.onLines].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('starts a new line when a start code repeats', () => {
    const lw = buildLinework(
      points([
        ['1', 'EGL BL', 0, 0],
        ['2', 'EGL', 10, 0],
        ['3', 'EGL BL', 0, 10],
        ['4', 'EGL', 10, 10],
      ]),
      lib,
    );
    expect(lw.lines.features).toHaveLength(2);
  });

  it('draws a rectangle from two corners and a point on the opposite side', () => {
    const lw = buildLinework(
      points([
        ['1', 'PCC BL R3', 0, 0],
        ['2', 'PCC', 4, 0],
        ['3', 'PCC', 2, 3],
        ['4', 'PCC', 50, 50],
      ]),
      lib,
    );
    expect(coordsOf(lw.lines.features[0].geometry)).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
      [0, 0],
    ]);
    // The rectangle doesn't join on to the next point.
    expect(lw.lines.features).toHaveLength(1);
  });

  it('draws circles through three points and from a centre and radius', () => {
    const lw = buildLinework(
      points([
        ['1', 'PCC BL C3', 2, 0],
        ['2', 'PCC', 0, 2],
        ['3', 'PCC', -2, 0],
        ['4', 'EGL C2 1.5', 10, 10],
      ]),
      lib,
    );
    const [three, centre] = lw.lines.features.map((f) => coordsOf(f.geometry));
    for (const [x, y] of three) expect(Math.hypot(x, y)).toBeCloseTo(2, 2);
    for (const [x, y] of centre) expect(Math.hypot(x - 10, y - 10)).toBeCloseTo(1.5, 2);
  });

  it('draws a smooth curve through every point between BC and EC', () => {
    const lw = buildLinework(
      points([
        ['1', 'PCC BL', -10, 0],
        ['2', 'PCC BC', 0, 0],
        ['3', 'PCC', 7.071, 2.929],
        ['4', 'PCC', 10, 10],
        ['5', 'PCC EC', 7.071, 17.071],
        ['6', 'PCC EL', -10, 20],
      ]),
      lib,
    );
    const c = coordsOf(lw.lines.features[0].geometry);
    expect(c.length).toBeGreaterThan(30);
    for (const p of [[0, 0], [7.071, 2.929], [10, 10], [7.071, 17.071]]) expect(c).toContainEqual(p);
    expect(c[0]).toEqual([-10, 0]);
    expect(c[c.length - 1]).toEqual([-10, 20]);
  });

  it('joins to a named point and closes figures', () => {
    const lw = buildLinework(
      points([
        ['A', 'EGL BL', 0, 0],
        ['B', 'EGL', 10, 0],
        ['C', 'EGL CL', 10, 10],
        ['D', 'PCC JP B', 20, 20],
      ]),
      lib,
    );
    const [closed, join] = lw.lines.features.map((f) => coordsOf(f.geometry));
    expect(closed).toEqual([[0, 0], [10, 0], [10, 10], [0, 0]]);
    expect(join).toEqual([[20, 20], [10, 0]]);
  });

  it('fills polygon features and adds offset lines', () => {
    const lw = buildLinework(
      points([
        ['1', 'BLDG', 0, 0],
        ['2', 'BLDG', 10, 0],
        ['3', 'BLDG', 10, 10],
        ['4', 'GUT BL', 0, 20],
        ['5', 'GUT', 10, 20],
      ]),
      lib,
    );
    const [bldg, gut, back] = lw.lines.features;
    expect(bldg.geometry.type).toBe('Polygon');
    expect(bldg.properties).toMatchObject({ kind: 'polygon', fill: '#a52a2a', fillOpacity: 0.5 });
    expect(gut.properties.description).toBe('Gutter');
    // Negative offsets are to the left: north of an eastbound line.
    expect(back.properties.description).toBe('Back of Curb');
    expect(coordsOf(back.geometry)).toEqual([[0, 20.5], [10, 20.5]]);
  });

  it('without a library, treats codes that ever carry a control code as lines', () => {
    const lw = buildLinework(
      points([
        ['1', 'EP BL', 0, 0],
        ['2', 'TREE', 5, 5],
        ['3', 'EP', 10, 0],
        ['4', 'TREE', 6, 6],
      ]),
    );
    expect(lw.lines.features.map((f) => f.properties.code)).toEqual(['EP']);
    expect(lw.undefinedCodes).toEqual(['EP']);
  });

  it('records how each figure was built, by the id on its map feature', () => {
    const lw = buildLinework(
      points([
        ['A', 'GUT BL', 0, 0],
        ['B', 'GUT', 10, 0],
        ['C', 'PCC JP A', 5, 5],
        ['D', 'PCC C2 2', 20, 20],
      ]),
      lib,
      0.3048,
    );
    expect(lw.lines.features.map((f) => f.properties.fid)).toEqual([0, 1, 2, 3]);
    expect(lw.figures.map((f) => [f.fid, f.code, f.shape, f.nodes.map((n) => n.index), f.offset?.of])).toEqual([
      [0, 'PCC', 'join', [2, 0], undefined],
      [1, 'PCC', 'circleCenter', [3], undefined],
      [2, 'GUT', 'line', [0, 1], undefined],
      // The back of curb the library adds alongside.
      [3, 'GUT', 'line', [0, 1], 2],
    ]);
    // The radius after C2 is in the job's units, here feet.
    expect(lw.figures[1].value).toBeCloseTo(0.6096, 9);
    for (const [x, y] of coordsOf(lw.lines.features[1].geometry)) expect(Math.hypot(x - 20, y - 20)).toBeCloseTo(0.6096, 3);
  });

  it('skips deleted points', () => {
    const pts = points([
      ['1', 'EGL BL', 0, 0],
      ['2', 'EGL', 5, 5],
      ['3', 'EGL', 10, 0],
    ]);
    pts[1].deleted = true;
    expect(coordsOf(buildLinework(pts, lib).lines.features[0].geometry)).toEqual([[0, 0], [10, 0]]);
  });
});

describe('geometry', () => {
  it('builds a rectangle from a width', () => {
    expect(rectangle([[0, 0], [4, 0]], 3)).toEqual([[0, 0], [4, 0], [4, -3], [0, -3], [0, 0]]);
  });

  it('offsets a polyline with mitred corners', () => {
    const out = offsetPolyline([[0, 0], [10, 0], [10, 10]], 1);
    expect(out.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])).toEqual([[0, -1], [11, -1], [11, 10]]);
  });
});
