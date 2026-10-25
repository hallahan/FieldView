// Work out the job's datum, epoch and projection from the JobXML.

import { child, text_ } from './xml';

export interface CrsPreset {
  id: string;
  label: string;
  /** proj4 definition in metres, the unit JobXML stores grid values in. */
  proj4: string;
  match: RegExp;
}

export const PRESETS: CrsPreset[] = [
  {
    id: 'EPSG:6419',
    label: 'NAD83(2011) / California zone 3 (EPSG:6419, ftUS: 6420)',
    proj4:
      '+proj=lcc +lat_0=36.5 +lon_0=-120.5 +lat_1=38.4333333333333 +lat_2=37.0666666666667 +x_0=2000000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    // "California Zone 3 0403", "CA III", "Zone 0403", "California 3"...
    match: /\b(california|calif|ca)\b[^,;]*?\b(zone\s*)?(3|iii|0403|403)\b|\bzone\s*0?403\b/i,
  },
];

export interface CrsInfo {
  systemName: string;
  zoneName: string;
  datumName: string;
  /** Reference epochs found anywhere in the file, e.g. "2017.50". */
  epochs: string[];
  distanceUnits: string;
  preset?: CrsPreset;
  /** Rows for the metadata panel. */
  entries: [string, string][];
}

export function detectCrs(root: Element): CrsInfo {
  const fieldBook = child(root, 'FieldBook');
  const cs = last(fieldBook, 'CoordinateSystemRecord');
  const units = last(fieldBook, 'UnitsRecord');

  const systemName = cs ? text_(cs, 'SystemName') : '';
  const zoneName = cs ? text_(cs, 'ZoneName') : '';
  const datumName = cs ? text_(cs, 'DatumName') : '';
  const distanceUnits = units ? text_(units, 'DistanceUnits') : '';

  const csText = `${systemName} ${zoneName}`;
  const preset = PRESETS.find((p) => p.match.test(csText));

  const epochs = findEpochs(root);

  const entries: [string, string][] = [];
  if (systemName) entries.push(['System', systemName]);
  if (zoneName) entries.push(['Zone', zoneName]);
  if (datumName) entries.push(['Datum', datumName]);
  for (const e of epochs) entries.push(['Epoch', e]);
  if (!epochs.length && /2011/.test(`${datumName} ${systemName}`)) {
    entries.push(['Epoch', 'Not stated in the file (2017.50 and 2025.00 are both in use)']);
  }
  if (distanceUnits) entries.push(['Distance units', distanceUnits]);
  entries.push(['Grid projection used', preset ? preset.label : 'Not recognised: enter one to place grid-only points']);
  entries.push([
    'Map display',
    'Positions are drawn on a Web Mercator basemap as stored. Datum and epoch differences against the basemap (about 1 to 2 m for NAD83(2011)) are not corrected.',
  ]);

  return { systemName, zoneName, datumName, epochs, distanceUnits, preset, entries };
}

/** Look for reference epochs in epoch-named elements and in free text such as datum names. */
function findEpochs(root: Element): string[] {
  const found = new Set<string>();
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (el.children.length) continue;
    const t = el.textContent?.trim() ?? '';
    if (/epoch/i.test(el.tagName)) {
      const m = t.match(/^(\d{4}(?:\.\d+)?)$/);
      if (m) found.add(formatEpoch(m[1]));
    }
    for (const m of t.matchAll(/epoch\s*[:=]?\s*(\d{4}(?:\.\d+)?)/gi)) found.add(formatEpoch(m[1]));
  }
  return [...found].sort();
}

function formatEpoch(s: string): string {
  return Number(s).toFixed(2);
}

function last(parent: Element | undefined, tag: string): Element | undefined {
  if (!parent) return undefined;
  const els = Array.from(parent.children).filter((c) => c.tagName === tag);
  return els[els.length - 1];
}
