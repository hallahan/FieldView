// Work out the job's datum, epoch and projection from the JobXML.

import { helmertFromJob, ITRF2014_TO_NAD83_2011, planeAdjustmentFromJob, type Helmert, type PlaneAdjustment } from './datum';
import { child, num, text_ } from './xml';

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
    // "California Zone 3 0403", "California Epoch 2017.50 Zone 3", "CA III", "Zone 0403"...
    match: /\b(california|calif|ca)\b[^,;]*?\b(zone\s*)?(3|iii|0403|403)\b(?!\.)|\bzone\s*0?403\b/i,
  },
];

export interface CrsInfo {
  systemName: string;
  zoneName: string;
  datumName: string;
  /** Reference frame of the job's global coordinates, e.g. "NAD83(2011)". */
  referenceFrame: string;
  /** Reference epochs of the job's datum, e.g. "2017.50". */
  epochs: string[];
  distanceUnits: string;
  /** Grid projection to use for grid-only points, in metres. */
  projection?: { label: string; proj4: string; id?: string };
  /** Site calibration applied to the job's grid coordinates. */
  adjustment?: PlaneAdjustment;
  /** Lat/long are NAD83, so they need shifting to sit on WGS84 imagery. */
  nad83: boolean;
  /** ITRF2014 → NAD83(2011) transformation to use for that shift. */
  helmert: Helmert;
  /** Rows for the metadata panel. */
  entries: [string, string][];
}

export function detectCrs(root: Element): CrsInfo {
  const fieldBook = child(root, 'FieldBook');
  const envCs = child(root, 'Environment') && child(child(root, 'Environment')!, 'CoordinateSystem');
  const cs = last(fieldBook, 'CoordinateSystemRecord') ?? envCs;
  const units = last(fieldBook, 'UnitsRecord');
  const datum = last(fieldBook, 'DatumRecord') ?? (envCs && child(envCs, 'Datum'));
  const projRecord = last(fieldBook, 'ProjectionRecord');
  const projection = (projRecord && child(projRecord, 'Projection')) ?? (envCs && child(envCs, 'Projection'));
  const ellipsoid = last(fieldBook, 'EllipsoidRecord') ?? (envCs && child(envCs, 'Ellipsoid'));

  const systemName = cs ? text_(cs, 'SystemName') : '';
  const zoneName = cs ? text_(cs, 'ZoneName') : '';
  const datumName = cs ? text_(cs, 'DatumName') : '';
  const distanceUnits = units ? text_(units, 'DistanceUnits') : '';
  const referenceFrame = datum ? text_(datum, 'ReferenceGlobalFrameName') : '';

  // The epoch lives on the datum record; older files only have it in names.
  const epochs = new Set<string>();
  const datumEpoch = datum ? num(datum, 'ReferenceGlobalFrameEpoch') : undefined;
  if (datumEpoch) epochs.add(datumEpoch.toFixed(2));
  if (cs) {
    const own = num(cs, 'ReferenceEpoch');
    if (own) epochs.add(own.toFixed(2));
    for (const m of `${zoneName} ${datumName} ${systemName}`.matchAll(/epoch\s*[:=]?\s*(\d{4}(?:\.\d+)?)/gi)) {
      epochs.add(Number(m[1]).toFixed(2));
    }
  }

  const preset = PRESETS.find((p) => p.match.test(`${systemName} ${zoneName}`));
  const fromFile = projection ? projectionToProj4(projection, ellipsoid) : undefined;
  const chosen = fromFile
    ? { label: preset ? `${preset.label}, parameters from file` : `${text_(projection!, 'Type')}, parameters from file`, proj4: fromFile }
    : preset && { label: preset.label, proj4: preset.proj4, id: preset.id };

  const adjustment = planeAdjustmentFromJob(root);
  const nad83 = /nad\s*83|nad\s*1983|ca\s*srs/i.test(`${referenceFrame} ${datumName} ${systemName}`);
  const helmert = helmertFromJob(root) ?? ITRF2014_TO_NAD83_2011;

  const entries: [string, string][] = [];
  if (systemName) entries.push(['System', systemName]);
  if (zoneName) entries.push(['Zone', zoneName]);
  if (datumName) entries.push(['Datum', datumName]);
  if (referenceFrame) entries.push(['Reference frame', referenceFrame]);
  if (epochs.size) entries.push(['Epoch', [...epochs].sort().join(', ')]);
  else if (/2011/.test(`${datumName} ${systemName} ${referenceFrame}`)) {
    entries.push(['Epoch', 'Not stated in the file (2017.50 and 2025.00 are both in use)']);
  }
  const displacement = datum ? text_(datum, 'DisplacementModelName') : '';
  if (displacement) entries.push(['Displacement model', displacement]);
  const vertical = last(fieldBook, 'VerticalAdjustmentRecord');
  const geoid = vertical ? text_(vertical, 'GeoidName') : '';
  if (geoid) entries.push(['Geoid', geoid]);
  const horizontal = last(fieldBook, 'HorizontalAdjustmentRecord');
  const calibration = [horizontal && text_(horizontal, 'Type'), vertical && text_(vertical, 'Type')].filter(Boolean);
  if (calibration.length) entries.push(['Site calibration', calibration.join(', ')]);
  if (adjustment) {
    entries.push([
      'Horizontal adjustment',
      `shift N ${adjustment.translationNorth.toFixed(3)} m, E ${adjustment.translationEast.toFixed(3)} m, ` +
        `rotation ${(adjustment.rotation * 3600).toFixed(2)}″, scale ${((adjustment.scale - 1) * 1e6).toFixed(2)} ppm`,
    ]);
  }
  if (distanceUnits) entries.push(['Distance units', distanceUnits]);
  entries.push(['Grid projection used', chosen ? chosen.label : 'Not recognised: enter one to place grid-only points']);
  if (nad83) entries.push(['NAD83 → WGS84 for the map', helmert.name]);

  return {
    systemName,
    zoneName,
    datumName,
    referenceFrame,
    epochs: [...epochs].sort(),
    distanceUnits,
    projection: chosen,
    adjustment,
    nad83,
    helmert,
    entries,
  };
}

/** Build a proj4 definition from a JobXML <Projection>, or undefined for types we don't map. */
export function projectionToProj4(p: Element, ellipsoid: Element | undefined): string | undefined {
  const type = text_(p, 'Type');
  const lat0 = num(p, 'CentralLatitude') ?? num(p, 'OriginLatitude') ?? 0;
  const lon0 = num(p, 'CentralLongitude') ?? num(p, 'CentralMeridian');
  const x0 = num(p, 'FalseEasting') ?? 0;
  const y0 = num(p, 'FalseNorthing') ?? 0;
  const k0 = num(p, 'Scale') ?? num(p, 'ScaleFactor') ?? 1;
  if (lon0 === undefined) return undefined;

  let params: string;
  switch (type) {
    case 'Lambert2Parallel': {
      const lat1 = num(p, 'Parallel1') ?? num(p, 'NorthParallel');
      const lat2 = num(p, 'Parallel2') ?? num(p, 'SouthParallel');
      if (lat1 === undefined || lat2 === undefined) return undefined;
      params = `+proj=lcc +lat_0=${lat0} +lon_0=${lon0} +lat_1=${lat1} +lat_2=${lat2}`;
      break;
    }
    case 'Lambert1Parallel':
      params = `+proj=lcc +lat_0=${lat0} +lon_0=${lon0} +lat_1=${lat0} +k_0=${k0}`;
      break;
    case 'TransverseMercator':
      params = `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=${k0}`;
      break;
    default:
      return undefined;
  }

  const a = ellipsoid ? num(ellipsoid, 'EarthRadius') : undefined;
  const f = ellipsoid ? num(ellipsoid, 'Flattening') : undefined;
  const shape = a && f ? `+a=${a} +rf=${1 / f}` : '+ellps=GRS80';
  return `${params} +x_0=${x0} +y_0=${y0} ${shape} +units=m +no_defs`;
}

function last(parent: Element | undefined, tag: string): Element | undefined {
  if (!parent) return undefined;
  const els = Array.from(parent.children).filter((c) => c.tagName === tag);
  return els[els.length - 1];
}
