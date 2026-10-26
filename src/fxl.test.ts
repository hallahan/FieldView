// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FxlParseError, jobLibraryName, lookupControl, lookupFeature, parseColor, parseFxl } from './fxl';
import { dashArray, patternUnit } from './linestyle';

const text = readFileSync(resolve(__dirname, 'fixtures/library.fxl'), 'utf8');
const lib = parseFxl(text, 'Test_Library.fxl');

describe('parseFxl', () => {
  it('reads line, polygon and point features with their styles', () => {
    expect(lib.name).toBe('Test_Library');
    const pcc = lib.features.get('PCC')!;
    expect(pcc).toMatchObject({ kind: 'line', name: 'Concrete_Edge', category: 'Roadbed', layer: 'Roadbed' });
    expect(pcc.style).toMatchObject({ color: '#ffffff', lineStyle: 'Dashed 3-1', lineStyleScale: 2.35, fieldLineStyle: 'Solid' });
    // The Caltrans "Feature" attribute is a better description than the name.
    expect(pcc.description).toBe('Concrete edge');
    expect(lib.features.get('FENCL')!.description).toBe('Fence Line');

    const bldg = lib.features.get('BLDG')!;
    expect(bldg.kind).toBe('polygon');
    expect(bldg.style).toMatchObject({ color: '#a52a2a', fill: '#a52a2a', fillOpacity: 0.5 });

    const tree = lib.features.get('TREE')!;
    expect(tree.kind).toBe('point');
    expect(tree.style.symbol).toBe('Circle');
  });

  it('takes "by layer" colours and line styles from the layer', () => {
    const egl = lib.features.get('EGL')!;
    expect(egl.style.color).toBe('#00ff00');
    expect(egl.style.lineStyle).toBe('Solid');
    expect(lib.features.get('TREE')!.style.color).toBe('#008000');
  });

  it('reads offset lines', () => {
    expect(lib.features.get('GUT')!.offsets).toEqual([{ name: 'Back of Curb', offset: -0.5, color: '#ffffff', lineStyle: 'Solid' }]);
  });

  it('reads attribute definitions', () => {
    const attrs = lib.features.get('PCC')!.attributes;
    expect(attrs.get('DTM_Type')).toEqual({
      name: 'DTM_Type',
      type: 'List',
      description: 'Identifies the type of surface',
      entryMethod: 'Required',
      items: ['Ground', 'None'],
    });
    expect(attrs.get('Desc_1')!.type).toBe('String');
    expect(lib.features.get('TREE')!.attributes.get('Diameter')).toMatchObject({ type: 'Double', decimals: 2 });
  });

  it('reads control codes by type, and keeps unknown ones aside', () => {
    expect(lookupControl(lib, 'BL')!.action).toBe('start');
    expect(lookupControl(lib, 'BC')!.action).toBe('curveStart');
    expect(lookupControl(lib, 'R3')!.action).toBe('rectangle');
    expect(lookupControl(lib, 'C2')!.action).toBe('circleCenter');
    expect(lookupControl(lib, 'TP')).toBeUndefined();
    expect(lib.unknownControls.get('TP')).toBe('Teleport');
  });

  it('falls back from a string number to the base code', () => {
    expect(lookupFeature(lib, 'PCC1')!.code).toBe('PCC');
    expect(lookupFeature(lib, 'pcc')!.code).toBe('PCC');
    expect(lookupFeature(lib, 'XYZ1')).toBeUndefined();
  });

  it('rejects files that are not feature libraries', () => {
    expect(() => parseFxl('<JOBFile/>')).toThrow(FxlParseError);
    expect(() => parseFxl('<Something/>')).toThrow(/FeatureCodingDefinitions/);
    expect(() => parseFxl('not xml')).toThrow(FxlParseError);
  });
});

describe('line styles', () => {
  it('turns runs along the line into dashes', () => {
    expect(lib.lineStyles.get('Dashed 3-1')!.base).toEqual([1.5, 0.5]);
    expect(lib.lineStyles.get('Solid')!.base).toBe('solid');
    expect(dashArray(lib.lineStyles.get('Solid'), 1)).toBe('solid');
    expect(dashArray(undefined, 1)).toBe('solid');
  });

  it('starts the pattern on a dash and shifts the decorations to match', () => {
    const notched = lib.lineStyles.get('Notched')!;
    // The run 5.5–10 continues into 0–4.5 of the next repeat.
    expect(notched.base).toEqual([9, 1]);
    const v = notched.decorations[0];
    expect(v.kind === 'line' && v.points[0][0]).toBeCloseTo(-1);
  });

  it('keeps ticks and text as decorations over a solid line', () => {
    const fence = lib.lineStyles.get('Fence')!;
    expect(fence.base).toBe('solid');
    expect(fence.decorations.map((d) => d.kind)).toEqual(['line', 'text']);
  });

  it('scales patterns to a whole number of pixels per repeat', () => {
    const dashed = lib.lineStyles.get('Dashed 3-1')!;
    expect((dashed.period * patternUnit(dashed, 2.35)) % 1).toBe(0);
    const dashes = dashArray(dashed, 2.35) as number[];
    expect(dashes[0] / dashes[1]).toBeCloseTo(3);
  });
});

describe('helpers', () => {
  it('parses Trimble colours', () => {
    expect(parseColor('FF00FF00')).toBe('#00ff00');
    expect(parseColor('FE000000')).toBeUndefined();
    expect(parseColor('Empty')).toBeUndefined();
    expect(parseColor('#A52A2A')).toBe('#a52a2a');
  });

  it("finds the library a job was coded with", () => {
    expect(jobLibraryName('<FeatureCodingRecord><LibraryName>CSAC</LibraryName><SourceFilename>CSAC_FCL_v2024.09.fxl</SourceFilename>')).toBe(
      'CSAC_FCL_v2024.09',
    );
    expect(jobLibraryName('<FeatureCodeLibrary>C:\\Trimble\\Global.fxl</FeatureCodeLibrary>')).toBe('Global');
    expect(jobLibraryName('<JOBFile/>')).toBeUndefined();
  });
});
