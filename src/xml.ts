// Small DOM helpers shared by the JobXML readers.

export type Attrs = Record<string, string>;

/**
 * Flatten an element's subtree into dotted keys. XML attributes become
 * `path@attr`, repeated siblings get a `[n]` suffix.
 */
export function flatten(el: Element): Attrs {
  const out: Attrs = {};
  for (const [k, v] of attrEntries(el)) out[`@${k}`] = v;
  walk(el, '', out);
  return out;
}

function walk(el: Element, prefix: string, out: Attrs) {
  const kids = Array.from(el.children);
  const totals = new Map<string, number>();
  for (const k of kids) totals.set(k.tagName, (totals.get(k.tagName) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const k of kids) {
    const n = seen.get(k.tagName) ?? 0;
    seen.set(k.tagName, n + 1);
    const key = prefix + k.tagName + (totals.get(k.tagName)! > 1 ? `[${n + 1}]` : '');
    for (const [a, v] of attrEntries(k)) out[`${key}@${a}`] = v;
    if (k.children.length) walk(k, key + '.', out);
    else {
      const t = k.textContent?.trim() ?? '';
      if (t || !k.attributes.length) out[key] = t;
    }
  }
}

export function attrEntries(el: Element): [string, string][] {
  return Array.from(el.attributes).map((a) => [a.name, a.value]);
}

export function child(el: Element, tag: string): Element | undefined {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return undefined;
}

export function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

export function text_(el: Element, tag: string): string {
  return child(el, tag)?.textContent?.trim() ?? '';
}

export function num(el: Element, tag: string): number | undefined {
  const t = text_(el, tag);
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
