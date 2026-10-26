// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureGroups } from './featureprops';
import { parseFxl } from './fxl';
import type { JxlPoint } from './jxl';

const lib = parseFxl(readFileSync(resolve(__dirname, 'fixtures/library.fxl'), 'utf8'), 'library.fxl');

function point(code: string, features: JxlPoint['features']): JxlPoint {
  return {
    index: 0, id: '1', name: '1', code, coords: {}, origin: 'Reductions', type: 'GNSS', deleted: false, attributes: {}, features,
    method: '', surveyMethod: '', classification: '', stored: '', observation: [],
  };
}

const rows = (g: { props: { label: string; value: string | number; hint?: string }[] }) => Object.fromEntries(g.props.map((p) => [p.label, p]));

describe('featureGroups', () => {
  it('describes each code from the library, attributes in library order', () => {
    const p = point('PCC1 BL TREE', [
      { name: 'PCC1', attributes: { Desc_1: '', Feature: 'Concrete edge', DTM_Type: 'Ground', Extra: 'x' } },
      { name: 'TREE', attributes: { Diameter: '' } },
    ]);
    const [pcc, tree] = featureGroups(p, lib);
    expect(pcc.title).toMatch(/^PCC1 · /);
    const r = rows(pcc);
    expect(String(r['Defined as'].value)).toContain('line feature');
    expect(r.Category.value).toBe('Roadbed');
    expect(r['Control codes'].value).toMatch(/^BL /);
    expect(r.DTM_Type.hint).toBe('Identifies the type of surface');
    expect(pcc.props.map((x) => x.label).slice(-2)).toEqual(['DTM_Type', 'Extra']);
    expect(r.Desc_1).toBeUndefined();
    // A required attribute left empty is flagged.
    expect(String(rows(tree).Diameter.value)).toContain('Not recorded');
  });

  it('falls back to the job attributes without a library', () => {
    const [g] = featureGroups(point('XYZ', [{ name: 'XYZ', attributes: { A: '1', B: '' } }]), undefined);
    expect(g.title).toBe('XYZ');
    expect(g.props).toEqual([{ label: 'A', value: '1', hint: undefined }]);
  });
});
