// Linework and point symbols on the map, styled from the feature library.

import type maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LayerSpecification } from 'maplibre-gl';
import type { FeatureCollection, LineString, Polygon } from 'geojson';
import { lookupFeature, type FeatureLibrary } from './fxl';
import type { LineProps } from './linework';
import { dashArray, decorationImage, decorationSize, LINE_WIDTH, symbolImage } from './linestyle';

type Basemap = 'streets' | 'satellite' | string;

/** Every layer this module adds, for showing and hiding. */
export const LINE_LAYERS = ['lines-fill', 'lines-selected', 'lines-solid', 'lines-dash', 'lines-deco', 'lines-label'];

/** Highlight of the selected line, the yellow of the selected point's ring. */
const SELECTED_COLOR = '#ffd43b';

const pixelRatio = () => Math.min(3, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));

export function initLineMap(map: maplibregl.Map) {
  let library: FeatureLibrary | undefined;
  let basemap: Basemap = 'streets';
  let data: FeatureCollection<LineString | Polygon, LineProps & Record<string, unknown>> = { type: 'FeatureCollection', features: [] };
  let dashes = new Map<string, number[]>();
  let selected = -1;

  // Line style and symbol images are drawn the first time the map asks for them.
  map.on('styleimagemissing', (e) => {
    const id = e.id;
    if (!library || !id.startsWith('ofv-') || map.hasImage(id)) return;
    const [kind, a, b, c] = id.split('|').map(decodeURIComponent);
    let image;
    if (kind === 'ofv-deco') {
      const style = library.lineStyles.get(a);
      if (style) image = decorationImage(library, style, Number(b), c, pixelRatio());
    } else if (kind === 'ofv-sym') {
      image = symbolImage(library, a, b, c, pixelRatio());
    }
    if (image) map.addImage(id, { width: image.width, height: image.height, data: image.data }, { pixelRatio: image.pixelRatio });
  });

  /** Add the layers, below any point layers. Call again after a basemap change. */
  function addLayers(visible: boolean, before?: string) {
    if (map.getSource('lines')) return;
    const visibility = visible ? 'visible' : 'none';
    // Full precision, like the points, so vertices sit exactly on their shots.
    map.addSource('lines', { type: 'geojson', data, maxzoom: 24 });
    const layers: LayerSpecification[] = [
      {
        id: 'lines-fill',
        type: 'fill',
        source: 'lines',
        layout: { visibility },
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['has', 'fill']],
        paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['*', 0.5, ['get', 'fillOpacity']] },
      },
      {
        // Under the line itself, so its colour and style still show.
        id: 'lines-selected',
        type: 'line',
        source: 'lines',
        layout: { visibility, 'line-join': 'round', 'line-cap': 'round' },
        filter: ['==', ['get', 'fid'], selected],
        paint: { 'line-color': SELECTED_COLOR, 'line-width': 10, 'line-opacity': 0.8 },
      },
      {
        id: 'lines-solid',
        type: 'line',
        source: 'lines',
        layout: { visibility, 'line-join': 'round', 'line-cap': 'round' },
        filter: ['==', ['get', 'dash'], 'solid'],
        paint: { 'line-color': ['get', 'color'], 'line-width': LINE_WIDTH },
      },
      {
        id: 'lines-dash',
        type: 'line',
        source: 'lines',
        layout: { visibility, 'line-join': 'round', 'line-cap': 'butt' },
        filter: ['==', ['get', 'dash'], 'dash'],
        paint: { 'line-color': ['get', 'color'], 'line-width': LINE_WIDTH, 'line-dasharray': dashExpression() },
      },
      {
        id: 'lines-deco',
        type: 'line',
        source: 'lines',
        layout: { visibility, 'line-join': 'round' },
        filter: ['has', 'deco'],
        paint: { 'line-pattern': ['get', 'deco'], 'line-width': ['get', 'decoH'] },
      },
      {
        id: 'lines-label',
        type: 'symbol',
        source: 'lines',
        minzoom: 19,
        layout: {
          visibility,
          'symbol-placement': 'line',
          'text-field': ['get', 'code'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, -0.9],
          'symbol-spacing': 220,
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': halo(), 'text-halo-width': 1.5 },
      },
    ];
    for (const layer of layers) map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  }

  /** A per-style dash array, chosen by each line's dashKey. */
  function dashExpression() {
    const cases = [...dashes].flatMap(([key, arr]) => [key, ['literal', arr]]);
    return (cases.length ? ['match', ['get', 'dashKey'], ...cases, ['literal', [2, 1]]] : ['literal', [2, 1]]) as never;
  }

  /**
   * Show linework. `colorOf` picks a colour for codes the library doesn't
   * colour.
   */
  function update(lines: FeatureCollection<LineString | Polygon, LineProps>, lib: FeatureLibrary | undefined, colorOf: (code: string) => string) {
    library = lib;
    dashes = new Map();
    data = {
      type: 'FeatureCollection',
      features: lines.features.map((f) => {
        const p: LineProps & Record<string, unknown> = { ...f.properties };
        const color = visibleColor(p.color ?? colorOf(p.code), basemap);
        p.color = color;
        if (p.fill) p.fill = visibleColor(p.fill, basemap);
        const style = p.lineStyle ? lib?.lineStyles.get(p.lineStyle) : undefined;
        const dash = dashArray(style, p.scale);
        if (Array.isArray(dash)) {
          const key = `${p.lineStyle}@${p.scale}`;
          dashes.set(key, dash);
          p.dash = 'dash';
          p.dashKey = key;
        } else p.dash = dash;
        const size = style && lib ? decorationSize(lib, style, p.scale) : undefined;
        if (style && size) {
          p.deco = ['ofv-deco', style.name, String(p.scale), color].map(encodeURIComponent).join('|');
          p.decoH = size.height;
        }
        return { ...f, properties: p };
      }),
    };
    (map.getSource('lines') as GeoJSONSource | undefined)?.setData(data);
    if (map.getLayer('lines-dash')) map.setPaintProperty('lines-dash', 'line-dasharray', dashExpression());
  }

  function setVisible(on: boolean) {
    for (const id of LINE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Highlight a line by its fid, or none. */
  function setSelected(fid: number | undefined) {
    selected = fid ?? -1;
    if (map.getLayer('lines-selected')) map.setFilter('lines-selected', ['==', ['get', 'fid'], selected]);
  }

  /** The icon id for a point's symbol, or '' when its code has none. */
  function symbolFor(lib: FeatureLibrary | undefined, code: string, colorOf: (code: string) => string): string {
    // Symbol images are drawn from this library when the map asks for them.
    if (lib) library = lib;
    const def = lookupFeature(lib, code);
    const name = def?.style.symbol;
    if (!name || !lib?.symbols.get(name)?.strokes.length) return '';
    const color = visibleColor(def.style.color ?? colorOf(code), basemap);
    return ['ofv-sym', name, color, halo()].map(encodeURIComponent).join('|');
  }

  function halo() {
    return basemap === 'satellite' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.9)';
  }

  return {
    addLayers,
    update,
    setVisible,
    setSelected,
    symbolFor,
    setBasemap: (b: Basemap) => (basemap = b),
    visibleColor: (css: string) => visibleColor(css, basemap),
  };
}

/**
 * Library colours come from CAD, where linework is drawn on black: white,
 * lime and aqua are common. On the light street map, white becomes near
 * black (as on a white CAD background) and other light colours are darkened.
 */
export function visibleColor(css: string, basemap: Basemap): string {
  if (basemap === 'satellite') return css;
  const m = css.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return css;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  if (Math.min(r, g, b) > 200) return '#2b2b2b';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (luminance < 0.5) return css;
  return `#${[r, g, b].map((v) => Math.round(v * 0.62).toString(16).padStart(2, '0')).join('')}`;
}
