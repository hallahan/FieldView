// Reduce total station observations in a JobXML FieldBook to grid coordinates.
//
// Trimble normally writes the reduced coordinates of every point to the
// <Reductions> section, and those are preferred. This is the fallback for
// files without it. It's a plane reduction: no grid scale factor, sea-level
// or curvature correction, so expect small differences from Trimble Access
// over long shots.

import { child, children, num, text_ } from './xml';

export interface Grid {
  north: number;
  east: number;
  elevation?: number;
}

export interface TsContext {
  fieldBook: Element | undefined;
  /** Latest known grid position of each point name, filled in file order. */
  gridByName: Map<string, Grid>;
}

const RAD = Math.PI / 180;

/** Grid position of a total station shot, or {} when it can't be reduced. */
export function reduceTotalStation(record: Element, ctx: TsContext): Partial<Grid> & { reduced?: true } {
  const circle = child(record, 'Circle');
  if (!circle || !ctx.fieldBook) return {};
  const ha = num(circle, 'HorizontalCircle');
  const va = num(circle, 'VerticalCircle');
  const sd = num(circle, 'EDMDistance');
  if (ha === undefined || sd === undefined) return {};

  const station = byId(ctx.fieldBook, 'StationRecord', text_(record, 'StationID'));
  if (!station) return {};
  const stationName = text_(station, 'StationName');
  const from = ctx.gridByName.get(stationName);
  if (!from) return {};

  const backBearing = byId(ctx.fieldBook, 'BackBearingRecord', text_(record, 'BackBearingID'));
  const correction = backBearing ? orientationCorrection(backBearing, from, ctx) : undefined;
  if (correction === undefined) return {};

  // Vertical circle is a zenith angle; default to level if it's missing.
  const zenith = (va ?? 90) * RAD;
  const hd = sd * Math.sin(zenith);
  const az = (ha + correction) * RAD;
  const out: Grid & { reduced: true } = {
    north: from.north + hd * Math.cos(az),
    east: from.east + hd * Math.sin(az),
    reduced: true,
  };

  if (from.elevation !== undefined && va !== undefined) {
    const hi = num(station, 'TheodoliteHeight') ?? 0;
    const target = byId(ctx.fieldBook, 'TargetRecord', text_(record, 'TargetID'));
    const ht = target ? (num(target, 'TargetHeight') ?? 0) : 0;
    out.elevation = from.elevation + hi + sd * Math.cos(zenith) - ht;
  }
  return out;
}

/** Degrees to add to a horizontal circle reading to get a grid azimuth. */
function orientationCorrection(bb: Element, station: Grid, ctx: TsContext): number | undefined {
  const stored = num(bb, 'OrientationCorrection');
  if (stored !== undefined) return stored;
  // Otherwise derive it from the backsight point's position.
  const bs = ctx.gridByName.get(text_(bb, 'BackSight'));
  const reading = num(bb, 'Face1HorizontalCircle') ?? num(bb, 'HorizontalCircle');
  if (!bs || reading === undefined) return undefined;
  const az = Math.atan2(bs.east - station.east, bs.north - station.north) / RAD;
  return az - reading;
}

function byId(fieldBook: Element, tag: string, id: string): Element | undefined {
  if (!id) return undefined;
  return children(fieldBook, tag).find((e) => e.getAttribute('ID') === id);
}
