// The feature groups of the properties panel: each feature code on a point,
// described from the active FXL library, with the attributes captured in the
// field in the library's order.

import type { FeatureLibrary } from './fxl';
import type { JxlPoint } from './jxl';
import { parseCode } from './linework';
import type { Prop, PropGroup } from './properties';
import { esc } from './util';

const KIND: Record<string, string> = { point: 'Point', line: 'Line', polygon: 'Polygon' };

export function featureGroups(p: JxlPoint, library: FeatureLibrary | undefined): PropGroup[] {
  const captured = new Map(p.features.map((f) => [f.name, f.attributes]));
  const tokens = parseCode(p.code, library);
  const groups: PropGroup[] = tokens.map((t) => {
    const def = t.def;
    const values = captured.get(t.code) ?? {};
    captured.delete(t.code);
    const props: Prop[] = [];
    if (def) {
      const swatch = def.style.color ? `<span class="swatch" style="background:${esc(def.style.color)}"></span>` : '';
      props.push({ label: 'Defined as', value: `${swatch}${esc(def.description || def.name)} <span class="muted">${(KIND[def.kind] ?? def.kind).toLowerCase()} feature</span>`, kind: 'html' });
      if (def.category) props.push({ label: 'Category', value: def.category });
      if (def.layer && def.layer !== def.category) props.push({ label: 'Layer', value: def.layer });
    }
    if (t.controls.length) {
      props.push({ label: 'Control codes', value: t.controls.map((c) => `${c.code}${c.value ? ` ${c.value}` : ''} (${c.description})`).join(', ') });
    }
    // Attributes in the library's order, then any the library doesn't define.
    const names = [...(def?.attributes.keys() ?? []), ...Object.keys(values).filter((n) => !def?.attributes.has(n))];
    for (const name of names) {
      const a = def?.attributes.get(name);
      const value = values[name] ?? '';
      const hint = a?.description;
      // Office-use fields that repeat the definition (Feature, Category) add nothing.
      const repeats = a?.entryMethod === 'OfficeUseOnly' && [def!.description, def!.name, def!.category].some((d) => d.toLowerCase() === value.toLowerCase());
      if (repeats) continue;
      if (value !== '') props.push({ label: name, value, hint });
      // A required attribute the crew skipped is worth flagging.
      else if (a?.entryMethod === 'Required') props.push({ label: name, value: '<span class="warn-text">Not recorded</span>', kind: 'html', hint });
    }
    const title = def ? `${t.code} · ${def.description || def.name}` : t.code;
    return { title, props };
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
