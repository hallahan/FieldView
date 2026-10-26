// A job left in its own assumed coordinates is drawn on a plain background
// with a grid of round northings and eastings, so positions can be read off
// the map without streets or imagery. MapLibre still needs a lat/long for
// everything, so the job is laid out around 0°, 0° by a stand-in placement
// with no rotation; there Web Mercator keeps distances true and the scale
// bar stays right.

import type { GeoJSONSource, Map as MaplibreMap, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { placeGrid, toGrid, type Placement } from './placement';

const BACKGROUND = '#faf8f2';
const SOURCE = 'local-grid';

export function localStyle(glyphs: string): StyleSpecification {
  return {
    version: 8,
    glyphs,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } }],
  };
}

/** A round grid spacing (1, 2 or 5 times a power of ten) giving about `target` lines across `span`. */
export function gridStep(span: number, target = 5): number {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw * 0.999)!;
}

/** A grid value in job units, with as many decimals as the spacing needs. */
export function gridLabel(axis: 'N' | 'E', metres: number, unit: number, step: number): string {
  const places = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return `${axis} ${(metres / unit).toFixed(places)}`;
}

/**
 * Grid lines across the view, in job units of `unit` metres, with northings
 * labelled along the left edge and eastings along the bottom.
 */
export function gridFeatures(frame: Placement, bounds: [number, number, number, number], unit: number): FeatureCollection {
  const [w, s, e, n] = bounds;
  const corners = [
    [s, w],
    [s, e],
    [n, w],
    [n, e],
  ].map(([lat, lon]) => toGrid(frame, lat, lon));
  const minN = Math.min(...corners.map((c) => c[0]));
  const maxN = Math.max(...corners.map((c) => c[0]));
  const minE = Math.min(...corners.map((c) => c[1]));
  const maxE = Math.max(...corners.map((c) => c[1]));
  const span = Math.min(maxN - minN, maxE - minE) / unit;
  const features: Feature[] = [];
  if (!(span > 0)) return { type: 'FeatureCollection', features };
  const step = gridStep(span);
  const m = step * unit;
  const at = (north: number, east: number) => {
    const [lat, lon] = placeGrid(frame, north, east);
    return [lon, lat];
  };
  for (let v = Math.ceil(minE / m) * m; v <= maxE; v += m) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [at(minN, v), at(maxN, v)] } });
    features.push({
      type: 'Feature',
      properties: { label: gridLabel('E', v, unit, step), anchor: 'bottom', offset: [0, -0.3] },
      geometry: { type: 'Point', coordinates: at(minN, v) },
    });
  }
  for (let v = Math.ceil(minN / m) * m; v <= maxN; v += m) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [at(v, minE), at(v, maxE)] } });
    features.push({
      type: 'Feature',
      properties: { label: gridLabel('N', v, unit, step), anchor: 'left', offset: [0.4, 0] },
      geometry: { type: 'Point', coordinates: at(v, minE) },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function initLocalGrid(map: MaplibreMap) {
  let frame: Placement | undefined;
  let unit = 1;
  let queued = false;

  function update() {
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    if (!source || !frame) return;
    const b = map.getBounds();
    source.setData(gridFeatures(frame, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], unit));
  }

  map.on('move', () => {
    if (!frame || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  });

  return {
    /** Add the grid to the plain style, under the survey. */
    addLayers() {
      if (!frame || map.getSource(SOURCE)) return;
      map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'local-grid-lines',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#e3dccb', 'line-width': 1 },
      });
      map.addLayer({
        id: 'local-grid-labels',
        type: 'symbol',
        source: SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': ['get', 'anchor'],
          'text-offset': ['get', 'offset'],
        },
        paint: { 'text-color': '#857d6a', 'text-halo-color': BACKGROUND, 'text-halo-width': 2 },
      });
      update();
    },
    /** Draw the grid for this stand-in placement, or none. */
    set(f: Placement | undefined, metresPerUnit: number) {
      frame = f;
      unit = metresPerUnit;
      update();
    },
  };
}
