import proj4 from 'proj4';
import { PRESETS } from './crs';
import { removePlaneAdjustment, type PlaneAdjustment } from './datum';
import type { JxlPoint } from './jxl';

/**
 * Turn user input into a proj4 definition. Accepts "EPSG:1234" (looked up on
 * epsg.io unless it's a built-in preset), a bare EPSG number, or a proj4 / WKT
 * string.
 */
export async function resolveProjection(input: string): Promise<string> {
  const preset = PRESETS.find((p) => p.id.toLowerCase() === input.toLowerCase() || p.label === input);
  if (preset) return preset.proj4;
  const m = input.match(/^(?:epsg:)?\s*(\d{4,6})$/i);
  if (!m) return input;
  const res = await fetch(`https://epsg.io/${m[1]}.proj4`);
  if (!res.ok) throw new Error(`EPSG:${m[1]} not found`);
  const def = (await res.text()).trim();
  if (!def.startsWith('+')) throw new Error(`EPSG:${m[1]} has no proj4 definition`);
  return def;
}

/** Metres per unit of the projection's linear unit. */
function toMeter(def: string): number {
  const toMeterParam = def.match(/\+to_meter=([\d.eE+-]+)/);
  if (toMeterParam) return Number(toMeterParam[1]);
  const units = def.match(/\+units=(\S+)/)?.[1];
  if (units === 'us-ft') return 1200 / 3937;
  if (units === 'ft') return 0.3048;
  return 1;
}

/**
 * Compute lat/lon for points that only have grid coordinates. JobXML grid
 * values are always metres, so convert to the projection's unit first. When
 * the job has a site calibration, its grid is the calibrated one, so the
 * calibration is removed before un-projecting.
 * Returns the number of points placed.
 */
export function projectGrid(points: JxlPoint[], def: string, adjustment?: PlaneAdjustment): number {
  const transform = proj4(def, 'EPSG:4326');
  const scale = def.startsWith('+') ? toMeter(def) : 1;
  let n = 0;
  for (const p of points) {
    const c = p.coords;
    if (c.north === undefined || c.east === undefined) continue;
    if (c.source && c.source !== 'Grid') continue;
    const [north, east] = adjustment ? removePlaneAdjustment(adjustment, c.north, c.east) : [c.north, c.east];
    const [lon, lat] = transform.forward([east / scale, north / scale]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    c.lat = lat;
    c.lon = lon;
    c.height = undefined;
    c.source = 'Grid';
    n++;
  }
  if (!n) throw new Error('no grid points landed inside valid lat/lon bounds');
  return n;
}
