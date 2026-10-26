// The feature groups of the properties panel: each feature code on a point,
// described from the active FXL library, with the attributes captured in the
// field in the library's order.

import type { FeatureDef, FeatureLibrary } from './fxl';
import type { JxlPoint } from './jxl';
import { parseCode } from './linework';
import type { Prop, PropGroup } from './properties';
import { esc } from './util';

const KIND: Record<string, string> = { point: 'Point', line: 'Line', polygon: 'Polygon' };

/** Shown for a required attribute the crew skipped. */
export const NOT_RECORDED = '<span class="warn-text">Not recorded</span>';

export function featureGroups(p: JxlPoint, library: FeatureLibrary | undefined): PropGroup[] {
  const captured = new Map(p.features.map((f) => [f.name, f.attributes]));
  const tokens = parseCode(p.code, library);
  const groups: PropGroup[] = tokens.map((t) => {
    const def = t.def;
    const values = captured.get(t.code) ?? {};
    captured.delete(t.code);
    const props: Prop[] = def ? definitionProps(def) : [];
    if (t.controls.length) {
      props.push({ label: 'Control codes', value: t.controls.map((c) => `${c.code}${c.value ? ` ${c.value}` : ''} (${c.description})`).join(', ') });
    }
    for (const name of attributeNames(def, Object.keys(values))) {
      const value = values[name] ?? '';
      if (repeatsDefinition(def, name, value)) continue;
      const a = def?.attributes.get(name);
      const hint = a?.description;
      if (value !== '') props.push({ label: name, value, hint });
      // A required attribute the crew skipped is worth flagging.
      else if (a?.entryMethod === 'Required') props.push({ label: name, value: NOT_RECORDED, kind: 'html', hint });
    }
    return { title: featureTitle(t.code, def), props };
  });
  // Feature records in the job whose code isn't on the point any more.
  for (const [name, attrs] of captured) {
    const props = Object.entries(attrs)
      .filter(([, v]) => v !== '')
      .map(([label, value]) => ({ label, value }));
    groups.push({ title: name, props });
  }
  return groups;
}

export function featureTitle(code: string, def: FeatureDef | undefined): string {
  return def ? `${code} · ${def.description || def.name}` : code;
}

/** What the library says a feature is: its description, category and layer. */
export function definitionProps(def: FeatureDef): Prop[] {
  const swatch = def.style.color ? `<span class="swatch" style="background:${esc(def.style.color)}"></span>` : '';
  const props: Prop[] = [
    { label: 'Defined as', value: `${swatch}${esc(def.description || def.name)} <span class="muted">${(KIND[def.kind] ?? def.kind).toLowerCase()} feature</span>`, kind: 'html' },
  ];
  if (def.category) props.push({ label: 'Category', value: def.category });
  if (def.layer && def.layer !== def.category) props.push({ label: 'Layer', value: def.layer });
  return props;
}

/** Attribute names in the library's order, then any the library doesn't define. */
export function attributeNames(def: FeatureDef | undefined, captured: Iterable<string>): string[] {
  const names = [...(def?.attributes.keys() ?? [])];
  for (const name of captured) if (!names.includes(name)) names.push(name);
  return names;
}

/** Office-use fields that repeat the definition (Feature, Category) add nothing. */
export function repeatsDefinition(def: FeatureDef | undefined, name: string, value: string): boolean {
  if (!def || def.attributes.get(name)?.entryMethod !== 'OfficeUseOnly') return false;
  return [def.description, def.name, def.category].some((d) => d.toLowerCase() === value.toLowerCase());
}
