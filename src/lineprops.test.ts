// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFxl } from './fxl';
import type { JxlPoint } from './jxl';
import { lineGroups, linesAtPoint, measureFigure } from './lineprops';
import { buildLinework } from './linework';
import type { PropGroup, Unit } from './properties';

const lib = parseFxl(readFileSync(resolve(__dirname, 'fixtures/library.fxl'), 'utf8'), 'library.fxl');

const LAT0 = 38.5;
const LON0 = -121.5;
const M_LAT = 1 / 111195;
const M_LON = M_LAT / Math.cos((LAT0 * Math.PI) / 180);
const METRES: Unit = { label: 'm', metres: 1 };
const FEET: Unit = { label: 'ift', metres: 0.3048 };

interface Row {
  name: string;
  code: string;
  e: number;
  n: number;
  z?: number;
  /** Attributes captured for each code on the point. */
  features?: Record<string, Record<string, string>>;
}

/**
 * Points a few metres apart, with grid coordinates offset by millions of
 * metres like State Plane, and map positions at the same spacing.
 */
function points(rows: Row[]): JxlPoint[] {
  return rows.map((r, index) => ({
    index,
    id: String(index),
    name: r.name,
    code: r.code,
    coords: {
      north: 600000 + r.n,
      east: 1900000 + r.e,
      elevation: r.z,
      mapLat: LAT0 + r.n * M_LAT,
      mapLon: LON0 + r.e * M_LON,
    },
    origin: 'Reductions',
    type: 'GNSS',
    deleted: false,
    attributes: {},
    features: Object.entries(r.features ?? {}).map(([name, attributes]) => ({ name, attributes })),
    method: '',
    surveyMethod: '',
    classification: '',
    stored: '',
    observation: [],
  }));
}

const rows = (g: PropGroup) => Object.fromEntries(g.props.map((p) => [p.label, p]));

describe('measureFigure', () => {
  it('measures a line in 2D and 3D on the grid', () => {
    const pts = points([
      { name: '1', code: 'EGL BL', e: 0, n: 0, z: 10 },
      { name: '2', code: 'EGL', e: 3, n: 4, z: 10 },
      { name: '3', code: 'EGL EL', e: 3, n: 16, z: 15 },
    ]);
    const lw = buildLinework(pts, lib);
    const m = measureFigure(lw.figures[0], lw.figures, pts);
    expect(m.grid).toBe(true);
    expect(m.length).toBeCloseTo(17, 9);
    expect(m.slopeLength).toBeCloseTo(5 + 13, 9);
    expect(m.elevations).toEqual([10, 15]);
    expect(m.area).toBeUndefined();
  });

  it('gives closed figures a perimeter and area', () => {
    const pts = points([
      { name: '1', code: 'EGL BL', e: 0, n: 0 },
      { name: '2', code: 'EGL', e: 4, n: 0 },
      { name: '3', code: 'EGL CL', e: 4, n: 3 },
    ]);
    const lw = buildLinework(pts, lib);
    const m = measureFigure(lw.figures[0], lw.figures, pts);
    expect(m.length).toBeCloseTo(12, 9);
    expect(m.area).toBeCloseTo(6, 9);
    // No elevations, so no 3D length.
    expect(m.slopeLength).toBeUndefined();
  });

  it('measures rectangles and circles exactly', () => {
    const pts = points([
      { name: '1', code: 'PCC BL R3', e: 0, n: 0 },
      { name: '2', code: 'PCC', e: 4, n: 0 },
      { name: '3', code: 'PCC', e: 2, n: 3 },
      { name: '4', code: 'EGL C3', e: 2, n: 0 },
      { name: '5', code: 'EGL', e: 0, n: 2 },
      { name: '6', code: 'EGL', e: -2, n: 0 },
    ]);
    const lw = buildLinework(pts, lib);
    const [rect, circle] = lw.figures.map((f) => measureFigure(f, lw.figures, pts));
    expect(rect.sides).toEqual([4, 3]);
    expect(rect.area).toBeCloseTo(12, 9);
    expect(rect.length).toBeCloseTo(14, 9);
    expect(circle.radius).toBeCloseTo(2, 6);
    expect(circle.area).toBeCloseTo(4 * Math.PI, 4);
  });

  it('reads sizes after control codes in the job units', () => {
    const pts = points([{ name: '1', code: 'EGL C2 1.5', e: 0, n: 0 }]);
    const lw = buildLinework(pts, lib, FEET.metres);
    const m = measureFigure(lw.figures[0], lw.figures, pts);
    expect(m.radius).toBeCloseTo(1.5 * 0.3048, 6);
    expect(rows(lineGroups(lw.figures[0], lw, pts, lib, FEET)[0])['Drawn as'].value).toBe('Circle from its centre, radius 1.500 ift');
  });

  it('measures arcs along the curve, not its chords', () => {
    // A quarter circle of radius 10 through three shots, coded as an arc.
    const s = 10 * Math.SQRT1_2;
    const pts = points([
      { name: '1', code: 'EGL BL', e: 10, n: 0 },
      { name: '2', code: 'EGL', e: s, n: s },
      { name: '3', code: 'EGL EL', e: 0, n: 10 },
    ]);
    pts[0].code = 'EGL BL BC';
    const lw = buildLinework(pts, lib);
    // BC/EC in the fixture is a smooth curve; a three-point arc is exact.
    const fig = { ...lw.figures[0], nodes: lw.figures[0].nodes.map((n, i) => ({ ...n, curveStart: i === 0 ? ('arc' as const) : undefined })) };
    expect(measureFigure(fig, lw.figures, pts).length).toBeCloseTo((Math.PI * 10) / 2, 5);
  });

  it('measures lines the library offsets alongside others', () => {
    const pts = points([
      { name: '1', code: 'GUT BL', e: 0, n: 0 },
      { name: '2', code: 'GUT', e: 10, n: 0 },
    ]);
    const lw = buildLinework(pts, lib);
    const back = lw.figures[1];
    expect(back.offset).toMatchObject({ of: 0, line: { name: 'Back of Curb' } });
    expect(measureFigure(back, lw.figures, pts).length).toBeCloseTo(10, 9);
    expect(rows(lineGroups(back, lw, pts, lib, METRES)[0])['Drawn as'].value).toBe('0.500 m left of GUT');
  });

  it('falls back to the map positions without grid coordinates', () => {
    const pts = points([
      { name: '1', code: 'EGL BL', e: 0, n: 0 },
      { name: '2', code: 'EGL', e: 30, n: 40 },
    ]);
    delete pts[1].coords.north;
    const lw = buildLinework(pts, lib);
    const m = measureFigure(lw.figures[0], lw.figures, pts);
    expect(m.grid).toBe(false);
    expect(m.length).toBeCloseTo(50, 2);
  });
});

describe('lineGroups', () => {
  const pts = points([
    { name: '1', code: 'PCC BL', e: 0, n: 0, features: { PCC: { DTM_Type: 'Ground', Desc_1: '', Feature: 'Concrete edge', Material: 'Dirt' } } },
    { name: '2', code: 'PCC', e: 10, n: 0, features: { PCC: { DTM_Type: 'Ground', Desc_1: 'crack', Feature: 'Concrete edge', Material: 'Dirt' } } },
    { name: '3', code: 'PCC', e: 20, n: 0, features: { PCC: { DTM_Type: 'Ground', Desc_1: '', Feature: 'Concrete edge', Material: 'Rock' } } },
    { name: '4', code: 'PCC EL', e: 30, n: 0, features: { PCC: { DTM_Type: 'Ground', Desc_1: '', Feature: 'Concrete edge', Material: 'Rock' } } },
  ]);
  const lw = buildLinework(pts, lib);
  const [shape, feature, vertices] = lineGroups(lw.figures[0], lw, pts, lib, METRES);

  it('describes the shape and its size', () => {
    expect(shape.title).toBe('Line');
    expect(rows(shape)['Drawn as'].value).toBe('Line through 4 points');
    expect(rows(shape)['2D length']).toMatchObject({ value: 30, kind: 'length' });
  });

  it('shows the definition and the attributes along the line', () => {
    expect(feature.title).toBe('PCC · Concrete edge');
    const r = rows(feature);
    expect(r.Category.value).toBe('Roadbed');
    expect(r['Line style'].value).toBe('Dashed 3-1 × 2.35');
    // The same at every point: just the value.
    expect(r.DTM_Type.value).toBe('Ground');
    // Recorded at one point, and changing along the line: where each applies.
    expect(String(r.Desc_1.value)).toContain('crack<span class="sub-value">at 2</span>');
    expect(String(r.Material.value)).toBe(
      '<span class="along">Dirt<span class="sub-value">1 to 2</span></span><span class="along">Rock<span class="sub-value">3 to 4</span></span>',
    );
    // An office field that repeats the definition is left out.
    expect(r.Feature).toBeUndefined();
  });

  it('lists the points, each opening the point', () => {
    expect(vertices.title).toBe('Points (4)');
    expect(vertices.props.map((p) => [p.label, p.value, p.link])).toEqual([
      ['1', 'PCC BL', { point: 0 }],
      ['2', 'PCC', { point: 1 }],
      ['3', 'PCC', { point: 2 }],
      ['4', 'PCC EL', { point: 3 }],
    ]);
  });

  it('flags a required attribute nobody recorded', () => {
    const bare = points([
      { name: '1', code: 'PCC BL', e: 0, n: 0 },
      { name: '2', code: 'PCC', e: 10, n: 0, features: { PCC: { DTM_Type: 'Ground' } } },
    ]);
    const lwb = buildLinework(bare, lib);
    const r = rows(lineGroups(lwb.figures[0], lwb, bare, lib, METRES)[1]);
    expect(String(r.DTM_Type.value)).toContain('Not recorded at 1 point');
    expect(r.Desc_1).toBeUndefined();
  });

  it('summarises values that change often as counts', () => {
    const zigzag = points(
      ['A', 'B', 'A', 'B', 'A', 'B'].map((v, i) => ({ name: `P${i}`, code: 'EGL', e: i * 5, n: 0, features: { EGL: { Aspect: v } } })),
    );
    zigzag[0].code = 'EGL BL';
    const lwz = buildLinework(zigzag, lib);
    const r = rows(lineGroups(lwz.figures[0], lwz, zigzag, lib, METRES)[1]);
    expect(String(r.Aspect.value)).toBe(
      '<span class="along">A<span class="sub-value">at 3 of 6 points</span></span><span class="along">B<span class="sub-value">at 3 of 6 points</span></span>',
    );
  });

  it("takes a join's attributes from the point coded with it", () => {
    const joined = points([
      { name: 'A', code: 'EGL', e: 0, n: 0, features: { EGL: { Aspect: 'Toe' } } },
      { name: 'B', code: 'EGL JP A', e: 10, n: 0, features: { EGL: { Aspect: 'Top' } } },
    ]);
    const lwj = buildLinework(joined, lib);
    const join = lwj.figures.find((f) => f.shape === 'join')!;
    const [shapeGroup, featureGroup] = lineGroups(join, lwj, joined, lib, METRES);
    expect(rows(shapeGroup)['Drawn as'].value).toBe('From B to A');
    expect(rows(featureGroup).Aspect.value).toBe('Top');
  });
});

describe('linesAtPoint', () => {
  it('lists the lines through a point, each opening the line', () => {
    const pts = points([
      { name: '1', code: 'PCC BL EGL BL', e: 0, n: 0 },
      { name: '2', code: 'PCC EGL', e: 10, n: 0 },
      { name: '3', code: 'EGL CL', e: 10, n: 10 },
    ]);
    const lw = buildLinework(pts, lib);
    const g = linesAtPoint(1, lw, pts, METRES);
    // In the order they were drawn: the closed figure ends first.
    expect(g.props.map((p) => [p.label, p.value, p.link])).toEqual([
      ['EGL', 'Closed line, 3 points, 34.142 m', { line: 0 }],
      ['PCC', '2 points, 10.000 m', { line: 1 }],
    ]);
    expect(linesAtPoint(2, lw, pts, METRES).props).toHaveLength(1);
  });
});
