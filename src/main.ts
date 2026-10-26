import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import type { FeatureCollection, Point } from 'geojson';
import { PRESETS } from './crs';
import { currentEpoch, nad83ToWgs84 } from './datum';
import { DEFAULT_CONTROLS, jobLibraryName, lookupFeature, parseFxl, type FeatureLibrary } from './fxl';
import { deleteLibrary, getLibrary, listLibraries, saveLibrary } from './librarystore';
import { initLineMap, LINE_LAYERS } from './linemap';
import { parseJxl, type JxlDocument, type JxlPoint, type ObservationType } from './jxl';
import { initJobs, type JobOrigin } from './jobs';
import { buildLinework, parseCode, type LineFigure, type Linework } from './linework';
import { lineGroups, linesAtPoint } from './lineprops';
import { gridFitsProjection, projectGrid, resolveProjection } from './projection';
import { isRw5, parseRw5, UNIT_LABELS, type Rw5Units } from './rw5';
import { featureGroups } from './featureprops';
import { groundDelta, IMAGERY_TILES, initImagery, isZero, type ImageryOffset } from './imagery';
import {
  applyPlacement,
  bearingFromPin,
  canPlace,
  formatDms,
  initialPlacement,
  isPlacement,
  newer,
  normalizeAngle,
  parseAngle,
  removePlacement,
  repin,
  type Placement,
} from './placement';
import { formatProp, latLonDms, type Prop, type PropGroup, type Unit } from './properties';
import { esc, formatBytes } from './util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const BASEMAPS: Record<string, string | StyleSpecification> = {
  streets: 'https://tiles.openfreemap.org/styles/liberty',
  satellite: {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      imagery: {
        type: 'raster',
        tiles: [IMAGERY_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }],
  },
};

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#c2255c', '#5c940d', '#6741d9', '#868e96'];

const TYPE_COLORS: Record<ObservationType, string> = {
  GNSS: '#1c7ed6',
  'Total station': '#e8590c',
  Computed: '#ae3ec9',
  'Keyed in': '#2f9e44',
  Other: '#868e96',
};
const TYPE_SHORT: Record<ObservationType, string> = {
  GNSS: 'GNSS',
  'Total station': 'TS',
  Computed: 'Calc',
  'Keyed in': 'Keyed',
  Other: 'Other',
};

let doc: JxlDocument | undefined;
let selected: number | undefined;
/** The selected line or polygon, by fid. Only one of it and `selected` is set. */
let selectedLine: number | undefined;
/** Whether the properties panel is showing in place of the point list. */
let showingDetail = false;
/**
 * The line or point the panel was opened from, which its back button returns
 * to; otherwise it goes back to the list.
 */
let back: { point: number } | { line: number } | undefined;
/** The line a point's panel was opened from. */
const backLine = () => (back && 'line' in back ? back.line : undefined);
/** Point indices in list order, after the filter, for stepping through them. */
let listed: number[] = [];
let colorBy: 'code' | 'type' = 'code';
let alignToImagery = readPref('alignToImagery') !== 'false';
let showLines = readPref('showLines') !== 'false';
let basemap = 'streets';
let library: FeatureLibrary | undefined;
/** Resolves once the stored libraries have been listed and the last one opened. */
let libraryReady: Promise<void> = Promise.resolve();
let linework: Linework | undefined;
const mapEpoch = currentEpoch();

// Shots can be 0.1 ft apart, so allow zooming well past the basemaps' own
// tiles (they overzoom). MapLibre has no tile coordinates past z25; there
// 0.1 ft in California is about 16 px.
const MAX_ZOOM = 25;

let map: maplibregl.Map;
try {
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS.streets,
    center: [0, 20],
    zoom: 1.5,
    maxZoom: MAX_ZOOM,
    attributionControl: { compact: true },
  });
} catch (e) {
  $('#map').innerHTML = `<p class="map-error">The map can't start in this browser (WebGL is unavailable). Points and metadata still work in the panel.<br><small>${esc(String(e))}</small></p>`;
  throw e;
}
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const jobs = initJobs({
  map,
  open: (text, name, size, origin) => {
    jobs.showView('viewer');
    load(text, name, size, undefined, origin);
  },
  isSheet: () => isSheet(),
  setSheet: (expanded) => setSheet(expanded),
  showLines: () => showLines,
});
const lineMap = initLineMap(map);
const imagery = initImagery(map, 'imagery');

// Layers are re-added whenever the basemap style is swapped.
let styleReady = false;
map.on('style.load', () => {
  styleReady = true;
  imagery.styleLoaded();
  addPointLayers();
  refreshLines();
  jobs.addLayers();
});

// If the basemap style itself can't be fetched, fall back to a plain
// background so the survey points still show.
map.on('error', (e) => {
  if (styleReady) return;
  console.warn('Basemap failed to load, using a blank basemap', e.error);
  styleReady = true;
  map.setStyle({
    version: 8,
    glyphs: GLYPHS,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ecef' } }],
  });
});

function addPointLayers() {
  if (map.getSource('points')) return;
  // Hidden while the Jobs view shows its pins instead.
  const layout = { visibility: jobs.isActive() ? 'none' : 'visible' } as const;
  lineMap.addLayers(showLines && !jobs.isActive());
  // Tile the points at full precision: the default (z18) quantises them to
  // about 2 cm, which smears shots that are a few hundredths apart.
  map.addSource('points', { type: 'geojson', data: toGeoJSON(), maxzoom: 24 });
  map.addLayer({
    id: 'points-circle',
    type: 'circle',
    source: 'points',
    layout,
    paint: {
      // Vertices of linework are smaller, and points drawn with a library
      // symbol shrink to a dot at its centre. All shrink a little at the
      // deepest zooms so close shots stay apart.
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4,
        2,
        16,
        ['case', ['!=', ['get', 'symbol'], ''], 2.5, ['get', 'onLine'], 3, 4.75],
        21,
        ['case', ['!=', ['get', 'symbol'], ''], 2.5, ['get', 'onLine'], 3, 4.75],
        24,
        ['case', ['!=', ['get', 'symbol'], ''], 2, ['get', 'onLine'], 2.5, 3.5],
      ],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 21, 1.25, 24, 0.75],
      'circle-opacity': ['case', ['get', 'deleted'], 0.35, 1],
    },
  });
  map.addLayer({
    id: 'points-symbol',
    type: 'symbol',
    source: 'points',
    minzoom: 15,
    filter: ['!=', ['get', 'symbol'], ''],
    layout: {
      ...layout,
      'icon-image': ['get', 'symbol'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 19, 1, 22, 1.4],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'points-selected',
    type: 'circle',
    source: 'points',
    layout,
    filter: ['==', ['get', 'index'], selected ?? -1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 16, 8, 21, 8, 24, 6],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ffd43b',
      'circle-stroke-width': 2.5,
    },
  });
  map.addLayer({
    id: 'points-label',
    type: 'symbol',
    source: 'points',
    minzoom: 15,
    layout: {
      ...layout,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#212529', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
}

function rebuildLinework() {
  const was = (fid: number | undefined) => (fid !== undefined ? linework?.figures[fid] : undefined);
  const line = was(selectedLine);
  const from = was(backLine());
  linework = doc ? buildLinework(doc.points, library, jobUnit().metres) : undefined;
  // Keep the selected line, and the line a point was opened from, if they're still drawn.
  if (line) {
    selectedLine = sameFigure(line);
    if (selectedLine === undefined) showingDetail = false;
  }
  if (from) {
    const fid = sameFigure(from);
    back = fid === undefined ? undefined : { line: fid };
  }
  refreshLines();
  setSelectedFilter();
}

/** The figure in the current linework built from the same points as `f`. */
function sameFigure(f: LineFigure): number | undefined {
  return linework?.figures.find(
    (g) => g.code === f.code && g.shape === f.shape && g.offset?.line.name === f.offset?.line.name && g.nodes[0]?.index === f.nodes[0]?.index,
  )?.fid;
}

function refreshLines() {
  lineMap.update(linework?.lines ?? { type: 'FeatureCollection', features: [] }, library, codeColorFn());
}

// Pick the nearest point or line within a finger-sized box rather than
// requiring an exact hit on a small circle or a thin line.
const TAP_TOLERANCE = 14;
// A tap this close to a point means the point, allowing more for a finger.
// Further out, a line that's nearer wins, so lines can be picked between
// closely spaced vertices.
const POINT_HIT = window.matchMedia('(pointer: coarse)').matches ? 10 : 7;
map.on('click', (e) => {
  if (aligning) return;
  if (placing) return pivotAt(e.point);
  if (jobs.handleClick(e, TAP_TOLERANCE)) return;
  const point = nearestPoint(e.point);
  const line = point && point.d <= POINT_HIT ? undefined : nearestLine(e.point);
  if (line && (!point || line.d < point.d)) selectLine(line.fid, false);
  else if (point) select(point.index, false);
});
// Layers the cursor shows as tappable; the highlight is under the line itself.
const TAPPABLE_LINES = LINE_LAYERS.filter((id) => id !== 'lines-selected');
for (const id of ['points-circle', ...TAPPABLE_LINES]) {
  map.on('mouseenter', id, () => !aligning && !placing && (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', id, () => !aligning && !placing && (map.getCanvas().style.cursor = ''));
}

function tapBox(at: maplibregl.Point): [[number, number], [number, number]] {
  return [
    [at.x - TAP_TOLERANCE, at.y - TAP_TOLERANCE],
    [at.x + TAP_TOLERANCE, at.y + TAP_TOLERANCE],
  ];
}

function nearestPoint(at: maplibregl.Point): { index: number; d: number } | undefined {
  if (!map.getLayer('points-circle')) return undefined;
  return map
    .queryRenderedFeatures(tapBox(at), { layers: ['points-circle'] })
    .map((f) => ({ index: Number(f.properties.index), d: map.project((f.geometry as Point).coordinates as [number, number]).dist(at) }))
    .sort((a, b) => a.d - b.d)[0];
}

/** The line or polygon nearest a tap, by its distance on screen from the drawn line. */
function nearestLine(at: maplibregl.Point): { fid: number; d: number } | undefined {
  const layers = TAPPABLE_LINES.filter((id) => map.getLayer(id));
  if (!linework || !layers.length) return undefined;
  let best: { fid: number; d: number } | undefined;
  for (const fid of new Set(map.queryRenderedFeatures(tapBox(at), { layers }).map((f) => Number(f.properties.fid)))) {
    const g = linework.lines.features[fid]?.geometry;
    if (!g) continue;
    const px = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates).map((c) => map.project(c as [number, number]));
    let d = Infinity;
    for (let i = 1; i < px.length; i++) d = Math.min(d, segmentDistance(at, px[i - 1], px[i]));
    // A tap inside a polygon picks it, unless its own edge or another line is nearer.
    if (g.type === 'Polygon' && inside(at, px)) d = Math.min(d, TAP_TOLERANCE);
    if (!best || d < best.d) best = { fid, d };
  }
  return best;
}

function segmentDistance(p: maplibregl.Point, a: maplibregl.Point, b: maplibregl.Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inside(p: maplibregl.Point, ring: maplibregl.Point[]): boolean {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
  }
  return odd;
}

function toGeoJSON(): FeatureCollection {
  const color = colorFn();
  const codeColor = codeColorFn();
  const symbol = (p: JxlPoint) => lineMap.symbolFor(library, p.code.split(/\s+/)[0], codeColor);
  return {
    type: 'FeatureCollection',
    features: (doc?.points ?? [])
      .filter((p) => p.coords.mapLat !== undefined)
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.coords.mapLon!, p.coords.mapLat!] },
        properties: {
          index: p.index,
          name: p.name,
          code: p.code,
          deleted: p.deleted,
          color: color(p),
          symbol: symbol(p),
          onLine: showLines && !!linework?.onLines.has(p.index),
        },
      })),
  };
}

function colorFn(): (p: JxlPoint) => string {
  if (colorBy === 'type') return (p) => TYPE_COLORS[p.type];
  const color = codeColorFn();
  return (p) => color(p.code.split(/\s+/)[0]);
}

/**
 * Colour for a feature code: the library's colour if it has one, otherwise
 * one of the palette colours, the most common codes getting distinct ones.
 */
function codeColorFn(): (code: string) => string {
  // Count every feature code on each point, so "PCC" and "PCC EC" match.
  const counts = new Map<string, number>();
  for (const p of doc?.points ?? []) {
    for (const t of parseCode(p.code, library)) counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
  }
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  // The most common codes get distinct colours; the rest share grey.
  const byCode = new Map(ranked.map((code, i) => [code, PALETTE[Math.min(i, PALETTE.length - 1)]]));
  return (code) => {
    const fromLibrary = lookupFeature(library, code)?.style.color;
    return fromLibrary ? lineMap.visibleColor(fromLibrary) : (byCode.get(code) ?? PALETTE[PALETTE.length - 1]);
  };
}

document.querySelectorAll<HTMLButtonElement>('#color-by button').forEach((b) =>
  b.addEventListener('click', () => {
    colorBy = b.dataset.colorBy as typeof colorBy;
    document.querySelectorAll('#color-by button').forEach((x) => x.classList.toggle('active', x === b));
    renderTable();
    refreshMap(false);
    refreshLines();
  }),
);

function refreshMap(fit: boolean) {
  (map.getSource('points') as GeoJSONSource | undefined)?.setData(toGeoJSON());
  if (!fit || !doc) return;
  const located = doc.points.filter((p) => p.coords.mapLat !== undefined);
  // Frame what was measured on this job: keyed-in control can be kilometres away.
  const measured = located.filter((p) => p.type !== 'Keyed in' && !p.deleted);
  const framed = measured.length ? measured : located;
  if (!framed.length) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const p of framed) bounds.extend([p.coords.mapLon!, p.coords.mapLat!]);
  const pad = isSheet() ? 30 : 60;
  // Keep the job clear of the placing bar over the top of the map.
  const bar = $('#place-bar');
  const top = bar.hidden ? pad : bar.getBoundingClientRect().bottom - map.getContainer().getBoundingClientRect().top + 50;
  map.fitBounds(bounds, { padding: { top, bottom: pad, left: pad, right: pad }, maxZoom: 18, duration: 600 });
}

// ---------------------------------------------------------------- loading

async function loadFile(file: File) {
  const text = await file.text();
  if (isLibraryFile(file.name, text)) addLibrary(text, file.name);
  else load(text, file.name, file.size);
}

function isLibraryFile(name: string, text: string) {
  if (/\.fxl$/i.test(name)) return true;
  if (/\.(jxl|rw5)$/i.test(name)) return false;
  // Unknown extension: anything that isn't a JobXML job or RW5 is tried as a library.
  return !/<JOBFile[\s>]/.test(text.slice(0, 4096)) && !isRw5(text);
}

let loaded: { text: string; name: string; size: number; origin?: JobOrigin } | undefined;
/** Distance unit chosen for the open RW5, when it differs from what its MO record says. */
let rw5Units: Rw5Units | undefined;

/** The coordinate system last used for an RW5 on this device, or CA zone 3. */
function rw5Projection(): { input: string; proj4: string } {
  try {
    const saved = JSON.parse(readPref('rw5.projection') || 'null');
    if (saved && typeof saved.input === 'string' && typeof saved.proj4 === 'string') return saved;
  } catch {
    // Fall through to the default.
  }
  return { input: PRESETS[0].id, proj4: PRESETS[0].proj4 };
}

/**
 * Parse and show a file. `gridDef` is a user-chosen projection for grid-only
 * points; `origin` is the repo it was opened from.
 */
function load(text: string, name: string, size: number, gridDef?: { input: string; proj4: string }, origin?: JobOrigin) {
  const rw5 = isRw5(text);
  if (!loaded || loaded.text !== text) rw5Units = undefined;
  try {
    if (rw5) {
      const chosen = gridDef ?? rw5Projection();
      const preset = PRESETS.find((p) => p.id === chosen.input);
      doc = parseRw5(text, { projection: { label: preset?.label ?? chosen.input, proj4: chosen.proj4, id: preset?.id }, units: rw5Units });
    } else {
      doc = parseJxl(text, { proj4: gridDef?.proj4 });
    }
  } catch (e) {
    setStatus((e as Error).message, true);
    return;
  }
  loaded = { text, name, size, origin };
  jobs.setOpenFile({ doc, text, name, origin });
  selected = undefined;
  selectedLine = undefined;
  back = undefined;
  showingDetail = false;
  document.body.classList.add('loaded');
  $('#dropzone strong').textContent = 'Open another file';
  doc.metadata.unshift({
    title: 'File',
    entries: [
      ['Name', name],
      ['Size', formatBytes(size)],
      ...(origin ? [['From', `${origin.repo}${origin.version ? ` at ${origin.version.slice(0, 7)}` : ''}`] as [string, string]] : []),
    ],
  });
  // A job in assumed coordinates goes where it was placed by hand, unless a
  // coordinate system has just been chosen for it.
  setPlacing(false);
  placement = gridDef || !canPlace(doc.points) ? undefined : newer(origin?.placement, readPlacement());
  if (placement) {
    doc.placement = placement;
    applyPlacement(doc.points, placement);
  }
  // Place grid-only points straight away when the job's projection is known.
  let projected = 0;
  let projectionError = '';
  const detected = doc.crs.projection;
  const projection = gridDef ?? (detected && { input: detected.id ?? '', proj4: detected.proj4 });
  const projectionLabel = gridDef ? gridDef.input : detected?.label;
  // Assumed coordinates (N 5000, E 5000) don't belong to any real zone.
  gridAssumed = !!doc.gridOnlyCount && !!projection && !gridFitsProjection(doc.points, projection.proj4);
  if (projection) $<HTMLInputElement>('#proj-input').value = projection.input;
  if (doc.gridOnlyCount && projection && !gridAssumed && !placement) {
    try {
      projected = projectGrid(doc.points, projection.proj4, doc.crs.adjustment);
      $<HTMLInputElement>('#proj-input').value = projection.input;
    } catch (err) {
      // For a detected projection, quietly leave it to the user to pick one.
      if (gridDef) projectionError = `Couldn't use that coordinate system: ${esc((err as Error).message)}`;
    }
  }
  statusNote = { name, projected: projected ? `${projected} grid points placed using ${projectionLabel}.` : '' };
  renderLoadStatus();
  $('#align-row').hidden = !doc.crs.nad83;
  alignPoints();
  setImageryOffset(readOffset(), false);
  linework = buildLinework(doc.points, library, jobUnit().metres);
  renderProjection();
  $('#tabs').hidden = false;
  showTab('points');
  renderTable();
  renderMetadata();
  renderDetail();
  renderLibrary();
  setSheet(false);
  if (map.isStyleLoaded()) addPointLayers();
  setSelectedFilter();
  refreshMap(true);
  refreshLines();
  libraryReady.then(() => matchJobLibrary(text));
  if (projectionError) setStatus(projectionError, true);
}

/** The job's grid points don't fit its coordinate system, so they look assumed. */
let gridAssumed = false;

/**
 * The coordinate system panel. JobXML only needs it when grid points are left
 * over; an RW5 never says what its grid is, so it's always shown, with units.
 * A job in assumed coordinates is offered placing by hand instead.
 */
function renderProjection() {
  if (!doc) return;
  const remaining = doc.points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;
  const rw5 = doc.format === 'rw5';
  $('#projection').hidden = !rw5 && remaining === 0;
  $('#units-row').hidden = !rw5;
  $<HTMLSelectElement>('#units-select').value = Object.entries(UNIT_LABELS).find(([, v]) => v === doc?.crs.distanceUnits)?.[0] ?? 'usft';
  const n = `${remaining} point${remaining === 1 ? '' : 's'}`;
  let text: string;
  if (placement) {
    text = `Placed by hand on the map. If you know the job's coordinate system, apply it instead.`;
  } else if (gridAssumed) {
    text = `<strong>These look like assumed coordinates</strong>, so ${n} aren't on the map. They don't fall inside the chosen coordinate system's zone.`;
  } else if (rw5) {
    text = remaining
      ? `RW5 files don't record their coordinate system. ${n} couldn't be placed with this one.`
      : `RW5 files don't record their coordinate system, so check this is the one the crew used.`;
  } else {
    text = `${n} only have grid coordinates. Choose their coordinate system to place them on the map.`;
  }
  $('#proj-text').innerHTML = text;
  // Placed points sit where they were put on the imagery, so there's nothing to shift.
  $('#align-row').hidden = !doc.crs.nad83 || !!placement;
  $('#place-offer').hidden = !!placement || !placeOffered();
  $('#place-offer-text').textContent = gridAssumed
    ? 'Drag and turn the job into place on the map instead.'
    : 'In assumed coordinates, like 10000, 10000? Drag and turn the job into place on the map instead.';
  renderPlace();
}

/** The open file and how its points got on the map, for the status line. */
let statusNote = { name: '', projected: '' };

function renderLoadStatus() {
  if (!doc) return;
  const mapped = doc.points.filter((p) => p.coords.lat !== undefined).length;
  const placed = doc.points.filter((p) => p.coords.source === 'Placed').length;
  const types = (['GNSS', 'Total station', 'Computed', 'Keyed in'] as ObservationType[])
    .map((t) => [t, doc!.points.filter((p) => p.type === t).length] as const)
    .filter(([, n]) => n)
    .map(([t, n]) => `${n} ${t === 'GNSS' ? t : t.toLowerCase()}`);
  setStatus(
    `<strong>${esc(statusNote.name)}</strong>: ${doc.points.length} points${types.length ? ` (${types.join(', ')})` : ''}, ${mapped} on the map.` +
      (statusNote.projected ? `<br><span class="muted">${esc(statusNote.projected)}</span>` : '') +
      (placed ? `<br><span class="muted">${placed} points in assumed coordinates, placed by hand.</span>` : ''),
  );
}

function setStatus(html: string, error = false) {
  const el = $('#status');
  el.innerHTML = html;
  el.classList.toggle('error', error);
}

$<HTMLInputElement>('#file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) loadFile(file);
  // Allow re-opening the same file after editing it.
  input.value = '';
});

$('#sample-rw5-btn').addEventListener('click', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}sample.rw5`);
  const text = await res.text();
  load(text, 'sample.rw5', text.length);
});

$<HTMLSelectElement>('#units-select').addEventListener('change', (e) => {
  if (!loaded) return;
  rw5Units = (e.target as HTMLSelectElement).value as Rw5Units;
  const projection = doc?.crs.projection;
  load(loaded.text, loaded.name, loaded.size, projection && { input: $<HTMLInputElement>('#proj-input').value || projection.label, proj4: projection.proj4 }, loaded.origin);
});

$('#sample-btn').addEventListener('click', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}sample.jxl`);
  const text = await res.text();
  load(text, 'sample.jxl', text.length);
});
$('#sample-local-btn').addEventListener('click', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}sample-local.jxl`);
  const text = await res.text();
  load(text, 'sample-local.jxl', text.length);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('#drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

// ---------------------------------------------------------------- feature library

// Libraries are kept on the device; the one in use is remembered by name.
let storedLibraries: string[] = [];
let libraryNote = '';

/** Use a library (or none) for linework and colours. */
function useLibrary(lib: FeatureLibrary | undefined, note = '') {
  library = lib;
  libraryNote = note;
  writePref('library', lib?.name ?? '');
  if (doc) {
    rebuildLinework();
    refreshMap(false);
    renderTable();
    renderDetail();
    renderMetadata();
  }
  renderLibrary();
}

async function activateLibrary(name: string, note = ''): Promise<boolean> {
  const stored = await getLibrary(name);
  if (!stored) return false;
  try {
    useLibrary(parseFxl(stored.text, name), note);
    return true;
  } catch (e) {
    useLibrary(undefined, `${name} couldn't be read: ${(e as Error).message}`);
    return false;
  }
}

/** Add a library from a file, keep it on the device, and use it. */
async function addLibrary(text: string, fileName: string) {
  let lib: FeatureLibrary;
  try {
    lib = parseFxl(text, fileName);
  } catch (e) {
    setStatus(`${esc(fileName)}: ${esc((e as Error).message)}`, true);
    return;
  }
  const kept = await saveLibrary(lib.name, text);
  storedLibraries = await listLibraries();
  useLibrary(lib, kept ? '' : "This browser won't keep it, so add it again next time.");
}

/** Switch to the library a job was coded with, if it's on the device. */
async function matchJobLibrary(jxl: string) {
  const wanted = jobLibraryName(jxl);
  if (!wanted || library?.name.toLowerCase() === wanted.toLowerCase()) return;
  const stored = storedLibraries.find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (stored) await activateLibrary(stored, `Switched to ${stored}, the library this job was coded with.`);
  else {
    libraryNote = `This job was coded with ${wanted}.fxl. Add it to draw the job's line styles.`;
    renderLibrary();
  }
}

function renderLibrary() {
  const select = $<HTMLSelectElement>('#fxl-select');
  const names = new Set(storedLibraries);
  if (library) names.add(library.name);
  select.innerHTML =
    `<option value="">None (default control codes)</option>` +
    [...names].sort().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  select.value = library?.name ?? '';
  const status = $('#fxl-status');
  const parts: string[] = [];
  if (library) {
    const n = (kind: string) => [...library!.features.values()].filter((f) => f.kind === kind).length;
    const counts = [`${n('line')} line`, `${n('polygon')} polygon`, `${n('point')} point`].filter((c) => !c.startsWith('0 '));
    parts.push(`${library.features.size} feature codes (${counts.join(', ')}).`);
  } else {
    parts.push(`Lines are joined using the Caltrans control codes ${DEFAULT_CONTROLS.map((c) => c.code).join(', ')}.`);
  }
  if (libraryNote) parts.push(`<strong>${esc(libraryNote)}</strong>`);
  status.innerHTML = parts.join('<br>');
  $('#fxl-clear').hidden = !library || !storedLibraries.includes(library.name);
  const lines = linework?.lines.features.length ?? 0;
  $('#lines-count').textContent = doc ? `(${lines} ${lines === 1 ? 'figure' : 'figures'})` : '';
}

$<HTMLSelectElement>('#fxl-select').addEventListener('change', (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (name) activateLibrary(name);
  else useLibrary(undefined);
});

$<HTMLInputElement>('#fxl-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) addLibrary(await file.text(), file.name);
  input.value = '';
});

$('#fxl-clear').addEventListener('click', async () => {
  if (!library) return;
  await deleteLibrary(library.name);
  storedLibraries = await listLibraries();
  useLibrary(undefined);
});

$<HTMLInputElement>('#lines-toggle').checked = showLines;
$<HTMLInputElement>('#lines-toggle').addEventListener('change', (e) => {
  showLines = (e.target as HTMLInputElement).checked;
  writePref('showLines', String(showLines));
  lineMap.setVisible(showLines && !jobs.isActive());
  refreshMap(false);
});

renderLibrary();
libraryReady = (async () => {
  storedLibraries = await listLibraries();
  const last = readPref('library');
  if (last && storedLibraries.includes(last)) await activateLibrary(last);
  else renderLibrary();
})();

$('#proj-presets').innerHTML = PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');

$('#proj-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!loaded) return;
  const input = $<HTMLInputElement>('#proj-input').value.trim();
  if (!input) return;
  try {
    const def = await resolveProjection(input);
    if (isRw5(loaded.text)) writePref('rw5.projection', JSON.stringify({ input, proj4: def }));
    // Re-parse so total station shots from GNSS setups can be reduced too.
    load(loaded.text, loaded.name, loaded.size, { input, proj4: def }, loaded.origin);
  } catch (err) {
    setStatus(`Couldn't use that coordinate system: ${esc((err as Error).message)}`, true);
  }
});

/**
 * Work out where each point is drawn. Lat/long in a NAD83 job are shifted to
 * WGS84 at today's epoch so they sit on the imagery; the file's values are
 * left untouched for display.
 */
function alignPoints() {
  if (!doc) return;
  const shift = alignToImagery && doc.crs.nad83;
  let moved = 0;
  for (const p of doc.points) {
    const c = p.coords;
    if (c.lat === undefined || c.lon === undefined) continue;
    // Placed by eye on the imagery, so already where it should be drawn.
    if (shift && c.source !== 'Placed') {
      const w = nad83ToWgs84(c.lat, c.lon, c.height ?? 0, mapEpoch, doc.crs.datumChain);
      c.mapLat = w.lat;
      c.mapLon = w.lon;
      if (!moved) moved = groundDistance(c.lat, c.lon, w.lat, w.lon);
    } else {
      c.mapLat = c.lat;
      c.mapLon = c.lon;
    }
  }
  $('#align-shift').textContent = shift && moved ? `(moves points ${moved.toFixed(2)} m)` : '';
}

function groundDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const dn = (lat2 - lat1) * r * 6371000;
  const de = (lon2 - lon1) * r * 6371000 * Math.cos(lat1 * r);
  return Math.hypot(dn, de);
}

$<HTMLInputElement>('#align-toggle').checked = alignToImagery;
$<HTMLInputElement>('#align-toggle').addEventListener('change', (e) => {
  alignToImagery = (e.target as HTMLInputElement).checked;
  writePref('alignToImagery', String(alignToImagery));
  alignPoints();
  refreshMap(false);
  rebuildLinework();
  renderDetail();
});

function readPref(key: string): string | null {
  try {
    // Fall back to the key used before the rename to OpenFieldView.
    return localStorage.getItem(`openfieldview.${key}`) ?? localStorage.getItem(`fieldview.${key}`);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`openfieldview.${key}`, value);
  } catch {
    // Private mode etc.; the setting just won't stick.
  }
}

// ---------------------------------------------------------------- sidebar

// On narrow screens the sidebar is a panel under the map that can be expanded.
const sheet = $('#sidebar');
const isSheet = () => window.matchMedia('(max-width: 760px)').matches;
function setSheet(expanded: boolean) {
  sheet.classList.toggle('expanded', expanded);
}
$('#sheet-handle').addEventListener('click', () => setSheet(!sheet.classList.contains('expanded')));

document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab!)),
);

function showTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-points').hidden = tab !== 'points';
  $('#tab-metadata').hidden = tab !== 'metadata';
}

$('#search').addEventListener('input', renderTable);

function renderTable() {
  if (!doc) return;
  const q = $<HTMLInputElement>('#search').value.trim().toLowerCase();
  const color = colorFn();
  const points = doc.points.filter((p) => !q || [p.name, p.code, p.type, TYPE_SHORT[p.type]].some((s) => s.toLowerCase().includes(q)));
  listed = points.map((p) => p.index);
  $('#points-table tbody').innerHTML = points
    .map(
      (p) => `<tr data-index="${p.index}" class="${p.index === selected ? 'selected' : ''} ${p.deleted ? 'deleted' : ''}">
        <td><span class="swatch" style="background:${color(p)}" title="${esc(p.type)}"></span>${esc(p.name)}${
          p.coords.lat === undefined ? ' <span class="no-pos" title="No position, so not on the map">no position</span>' : ''
        }</td>
        <td>${esc(p.code)}</td>
      </tr>`,
    )
    .join('');
}

$('#points-table tbody').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('tr');
  if (row) select(Number(row.dataset.index), true);
});

/** Show a point's properties. `from` is the line it was opened from, for the back button. */
function select(index: number, fly: boolean, from?: { line: number }) {
  if (!doc) return;
  selected = index;
  selectedLine = undefined;
  back = from;
  showDetail();
  const p = doc.points[index];
  if (fly && p.coords.mapLat !== undefined) map.flyTo({ center: [p.coords.mapLon!, p.coords.mapLat!], zoom: Math.max(map.getZoom(), 17) });
}

/** Show a line's properties. `from` is the point it was opened from, for the back button. */
function selectLine(fid: number, fit: boolean, from?: { point: number }) {
  const line = linework?.lines.features[fid];
  if (!line) return;
  selectedLine = fid;
  selected = undefined;
  back = from;
  showDetail();
  if (fit) {
    const bounds = new maplibregl.LngLatBounds();
    for (const c of line.geometry.type === 'Polygon' ? line.geometry.coordinates[0] : line.geometry.coordinates) bounds.extend(c as [number, number]);
    map.fitBounds(bounds, { padding: isSheet() ? 40 : 80, maxZoom: Math.max(map.getZoom(), 20), duration: 600 });
  }
}

function showDetail() {
  showingDetail = true;
  showTab('points');
  setSelectedFilter();
  if (isSheet()) setSheet(false);
  renderTable();
  renderDetail();
  // Bring the properties to the top of the panel.
  $('#point-detail').scrollIntoView({ block: 'start' });
}

/**
 * Back to the line or point the panel was opened from, or else to the list,
 * keeping the selection highlighted and the list where it was.
 */
function goBack() {
  if (back && 'line' in back) return selectLine(back.line, false);
  if (back && 'point' in back) return select(back.point, false);
  showingDetail = false;
  renderDetail();
  document.querySelector(`#points-table tr[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (aligning && alignKey(e)) return;
  if (placing && placeKey(e)) return;
  if (!showingDetail || (e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'Escape') goBack();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1);
  else return;
  e.preventDefault();
});

/**
 * Move to the next or previous line, or point: along the line the point was
 * opened from, otherwise in the list.
 */
function step(by: 1 | -1) {
  if (selectedLine !== undefined) {
    if (linework?.figures[selectedLine + by]) selectLine(selectedLine + by, true);
    return;
  }
  const order = stepOrder();
  const next = order[order.indexOf(selected ?? -1) + by];
  const line = backLine();
  if (next !== undefined) select(next, true, line === undefined ? undefined : { line });
}

function stepOrder(): number[] {
  const line = linework?.figures[backLine() ?? -1];
  return line ? line.nodes.map((n) => n.index) : listed;
}

function setSelectedFilter() {
  if (map.getLayer('points-selected')) map.setFilter('points-selected', ['==', ['get', 'index'], selected ?? -1]);
  // A point opened from a line keeps the line highlighted.
  lineMap.setSelected(selectedLine ?? backLine());
}

function renderDetail() {
  const el = $('#point-detail');
  const line = showingDetail && selectedLine !== undefined ? linework?.figures[selectedLine] : undefined;
  const p = showingDetail && !line && selected !== undefined ? doc?.points[selected] : undefined;
  el.hidden = !p && !line;
  $('#point-list').hidden = !el.hidden;
  if (line) renderLineDetail(el, line);
  else if (p) renderPointDetail(el, p);
  else return;
  el.querySelector('.back')!.addEventListener('click', goBack);
  // Tap an attribute's name to read the library's description of it.
  el.querySelectorAll('tr.has-hint').forEach((tr) => tr.addEventListener('click', () => tr.classList.toggle('show-hint')));
  el.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step) as 1 | -1)));
  // Rows that open a line's points, or the lines through a point.
  el.querySelectorAll<HTMLElement>('tr[data-point]').forEach((tr) =>
    tr.addEventListener('click', () => select(Number(tr.dataset.point), true, line && { line: line.fid })),
  );
  el.querySelectorAll<HTMLElement>('tr[data-line]').forEach((tr) =>
    tr.addEventListener('click', () => selectLine(Number(tr.dataset.line), true, p && { point: p.index })),
  );
}

function renderPointDetail(el: HTMLElement, p: JxlPoint) {
  const unit = jobUnit();
  const order = stepOrder();
  const at = order.indexOf(p.index);
  const from = linework?.figures[backLine() ?? -1];
  const groups: PropGroup[] = [
    coordinateGroup(p),
    ...featureGroups(p, library),
    linesAtPoint(p.index, linework, doc!.points, unit),
    pointGroup(p),
    ...p.observation,
  ];
  el.innerHTML = `
    ${detailHead({
      back: from ? `‹ ${from.code}` : '‹ Points',
      backTitle: from ? `Back to ${from.code}` : 'Back to the point list',
      position: at >= 0 ? `${at + 1} of ${order.length}${from ? ` on ${from.code}` : ''}` : '',
      prev: at > 0,
      next: at >= 0 && at < order.length - 1,
      noun: 'point',
      heading: `<span class="name">${esc(p.name || '(unnamed)')}</span>${p.code ? ` <span class="code">${esc(p.code)}</span>` : ''}`,
    })}
    ${p.deleted ? '<p class="warn">This point is marked deleted in the field book.</p>' : ''}
    ${groupsHtml(groups, unit)}
    <details class="group"><summary>All attributes (${Object.keys(p.attributes).length})</summary>${table('', Object.entries(p.attributes))}</details>
  `;
}

function renderLineDetail(el: HTMLElement, line: LineFigure) {
  const unit = jobUnit();
  const props = linework!.lines.features[line.fid].properties;
  // The colour it's drawn in on this basemap.
  const color = lineMap.visibleColor(props.color ?? codeColorFn()(props.code));
  const from = back && 'point' in back ? doc?.points[back.point] : undefined;
  const count = linework!.figures.length;
  el.innerHTML = `
    ${detailHead({
      back: from ? `‹ ${from.name}` : '‹ Points',
      backTitle: from ? `Back to point ${from.name}` : 'Back to the point list',
      position: `Line ${line.fid + 1} of ${count}`,
      prev: line.fid > 0,
      next: line.fid < count - 1,
      noun: 'line',
      heading: `<span class="line-swatch" style="background:${esc(color)}"></span><span class="name">${esc(line.code)}</span>${props.description ? ` <span class="desc">${esc(props.description)}</span>` : ''}`,
    })}
    ${groupsHtml(lineGroups(line, linework!, doc!.points, library, unit), unit)}
  `;
}

/** The panel's sticky top: back, position and stepping, then the heading (HTML). */
function detailHead(h: { back: string; backTitle: string; position: string; prev: boolean; next: boolean; noun: string; heading: string }): string {
  return `<div class="detail-head">
      <div class="detail-nav">
        <button class="back" title="${esc(h.backTitle)} (Esc)">${esc(h.back)}</button>
        <span class="muted">${esc(h.position)}</span>
        <span class="stepper">
          <button data-step="-1" title="Previous ${h.noun} (↑)" ${h.prev ? '' : 'disabled'}>↑</button>
          <button data-step="1" title="Next ${h.noun} (↓)" ${h.next ? '' : 'disabled'}>↓</button>
        </span>
      </div>
      <h2>${h.heading}</h2>
    </div>`;
}

function groupsHtml(groups: PropGroup[], unit: Unit): string {
  return groups
    .filter((g) => g.props.length)
    .map((g) => `<details class="group" open><summary>${esc(g.title)}</summary><table class="kv">${g.props.map((prop) => propRow(prop, unit)).join('')}</table></details>`)
    .join('');
}

function propRow(prop: Prop, unit: Unit): string {
  const classes = [prop.hint && 'has-hint', prop.link && 'link-row'].filter(Boolean).join(' ');
  const data = !prop.link ? '' : 'point' in prop.link ? ` data-point="${prop.link.point}"` : ` data-line="${prop.link.line}"`;
  const label = prop.link
    ? `<button class="row-link">${esc(prop.label)}</button>`
    : prop.hint
      ? `<span class="label">${esc(prop.label)}</span><span class="hint">${esc(prop.hint)}</span>`
      : esc(prop.label);
  const value = prop.kind === 'html' ? String(prop.value) : esc(formatProp(prop, unit));
  return `<tr${classes ? ` class="${classes}"` : ''}${data}><th>${label}</th><td>${value}</td></tr>`;
}

function pointGroup(p: JxlPoint): PropGroup {
  const props: PropGroup['props'] = [{ label: 'Measured by', value: p.type }];
  if (p.method) props.push({ label: 'Method', value: p.method });
  if (p.surveyMethod) props.push({ label: 'Survey method', value: p.surveyMethod });
  if (p.classification && p.classification !== 'Normal') props.push({ label: 'Classification', value: p.classification });
  if (p.stored) props.push({ label: 'Stored', value: p.stored.replace('T', ' ') });
  if (doc?.format === 'rw5') props.push({ label: 'Line in file', value: p.id });
  else props.push({ label: 'Record ID', value: `${p.id} (${p.origin})` });
  return { title: 'Point', props };
}

/** Coordinates as the crew saw them: grid in the job's units, lat/long in DMS. */
function coordinateGroup(p: JxlPoint): PropGroup {
  const c = p.coords;
  const props: PropGroup['props'] = [];
  const length = (label: string, v: number | undefined) => v !== undefined && props.push({ label, value: v, kind: 'length' as const });
  length('Northing', c.north);
  length('Easting', c.east);
  length('Elevation', c.elevation);
  if (c.reduced) props.push({ label: 'Grid from', value: 'Reduced from the total station observation by OpenFieldView' });
  if (c.lat !== undefined) {
    const deg = (v: number) => `<span class="sub-value">${v.toFixed(9)}°</span>`;
    props.push({ label: 'Latitude', value: `${esc(latLonDms(c.lat, 'N', 'S'))}${deg(c.lat)}`, kind: 'html' });
    props.push({ label: 'Longitude', value: `${esc(latLonDms(c.lon!, 'E', 'W'))}${deg(c.lon!)}`, kind: 'html' });
    length('Height (ellipsoid)', c.height);
    const from = { Grid: 'Grid coordinates', Localized: 'Local grid, through the GPS localization', Placed: 'Placed by hand on the map (assumed coordinates)' } as Record<string, string>;
    props.push({ label: 'Lat/long from', value: from[c.source!] ?? c.source! });
    if (c.mapLat !== undefined && (c.mapLat !== c.lat || c.mapLon !== c.lon)) {
      props.push({ label: `Map position (ITRF2020 ≈ WGS84, ${mapEpoch.toFixed(2)})`, value: `${c.mapLat.toFixed(9)}, ${c.mapLon!.toFixed(9)}` });
    }
  }
  return { title: 'Coordinates', props };
}

function jobUnit(): Unit {
  const u = (doc?.crs.distanceUnits ?? '').toLowerCase();
  if (u.includes('survey')) return { label: 'sft', metres: 1200 / 3937 };
  if (u.includes('feet') || u.includes('foot')) return { label: 'ift', metres: 0.3048 };
  return { label: 'm', metres: 1 };
}

function renderMetadata() {
  if (!doc) return;
  const lines: [string, string][] = [
    ['Feature library', library ? library.name : 'None (default control codes)'],
    ['Figures drawn', String(linework?.lines.features.length ?? 0)],
    [
      'Control codes',
      (library?.controls.size ? [...library.controls.values()] : DEFAULT_CONTROLS).map((c) => `${c.code} ${c.description}`).join(', '),
    ],
  ];
  if (linework?.undefinedCodes.length) {
    lines.push([library ? 'Line codes not in the library' : 'Line codes', linework.undefinedCodes.join(', ')]);
  }
  if (library?.unknownControls.size) {
    lines.push(['Control codes not supported yet', [...library.unknownControls].map(([c, a]) => `${c} (${a})`).join(', ')]);
  }
  const sections = [...doc.metadata, { title: 'Linework', entries: lines }];
  if (placement) sections.push({ title: 'Placed on the map', entries: placementEntries(placement) });
  $('#tab-metadata').innerHTML = sections.map((s) => table(s.title, s.entries)).join('');
}

function table(title: string, entries: [string, string][]) {
  if (!entries.length) return '';
  return `${title ? `<h3>${esc(title)}</h3>` : ''}<table class="kv">${entries
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

// ---------------------------------------------------------------- basemap

document.querySelectorAll<HTMLButtonElement>('#basemap-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('#basemap-toggle button').forEach((x) => x.classList.toggle('active', x === b));
    styleReady = false;
    basemap = b.dataset.basemap!;
    lineMap.setBasemap(basemap);
    map.setStyle(BASEMAPS[basemap]);
    if (basemap !== 'satellite') setAligning(false);
    renderAlign();
    renderPlace();
  }),
);

// ---------------------------------------------------------------- imagery alignment

// The imagery is moved, not the survey: drag it until it sits under the
// points and linework. The offset is kept on this device for each job.
let imageryOffset: ImageryOffset | undefined;
let aligning = false;
let dragFrom: { pointer: number; at: maplibregl.LngLat; offset: ImageryOffset } | undefined;
const pointers = new Set<number>();

/** The job's own name, so every version of it opened from a repo shares its settings. */
function jobKey() {
  return doc?.job.jobName || (loaded?.name ?? '').replace(/(_[0-9a-f]{7})?\.(jxl|rw5)$/i, '');
}

function offsetKey() {
  return `imageryOffset.${jobKey()}`;
}

function readOffset(): ImageryOffset | undefined {
  try {
    const o = JSON.parse(readPref(offsetKey()) || 'null');
    return o && [o.east, o.north, o.lat].every(Number.isFinite) ? o : undefined;
  } catch {
    return undefined;
  }
}

function setImageryOffset(o: ImageryOffset | undefined, save: boolean) {
  imageryOffset = isZero(o) ? undefined : o;
  imagery.set(imageryOffset);
  if (save && doc) writePref(offsetKey(), imageryOffset ? JSON.stringify(imageryOffset) : '');
  renderAlign();
}

function setAligning(on: boolean) {
  if (on) setPlacing(false);
  aligning = on;
  dragFrom = undefined;
  syncMapLock();
  renderAlign();
}

let mapLocked = false;
/**
 * While the imagery or a job is being moved, one finger drags it rather than
 * the map; pinching still zooms, without rotating.
 */
function syncMapLock() {
  const on = aligning || (placing && !!placement);
  if (on === mapLocked) return;
  mapLocked = on;
  for (const h of [map.dragPan, map.dragRotate, map.keyboard, map.touchPitch]) {
    if (on) h.disable();
    else h.enable();
  }
  if (on) map.touchZoomRotate.disableRotation();
  else map.touchZoomRotate.enableRotation();
  map.getCanvas().style.cursor = on ? 'move' : '';
  // Without this the browser takes a one-finger drag as a page scroll.
  map.getCanvasContainer().classList.toggle('aligning', on);
}

function renderAlign() {
  const button = $<HTMLButtonElement>('#align-imagery');
  button.hidden = basemap !== 'satellite' || !doc;
  button.classList.toggle('active', aligning);
  button.classList.toggle('moved', !!imageryOffset);
  $('#align-bar').hidden = !aligning;
  $<HTMLButtonElement>('#align-reset').disabled = !imageryOffset;
  $('#align-offset').textContent = imageryOffset ? `Moved ${describeOffset(imageryOffset)}` : 'Not moved';
}

function describeOffset(o: ImageryOffset) {
  const unit = jobUnit();
  const part = (v: number, pos: string, neg: string) => `${(Math.abs(v) / unit.metres).toFixed(2)} ${unit.label} ${v < 0 ? neg : pos}`;
  return `${part(o.east, 'east', 'west')}, ${part(o.north, 'north', 'south')}`;
}

$('#align-imagery').addEventListener('click', () => setAligning(!aligning));
$('#align-done').addEventListener('click', () => setAligning(false));
$('#align-reset').addEventListener('click', () => setImageryOffset(undefined, true));

const mapArea = map.getCanvasContainer();
function lngLatAt(e: PointerEvent) {
  const box = mapArea.getBoundingClientRect();
  return map.unproject([e.clientX - box.left, e.clientY - box.top]);
}
mapArea.addEventListener('pointerdown', (e) => {
  if (!aligning) return;
  pointers.add(e.pointerId);
  // A second finger is a pinch: leave the imagery where it is.
  if (pointers.size > 1) {
    if (dragFrom) setImageryOffset(imageryOffset, true);
    dragFrom = undefined;
    return;
  }
  const offset = imageryOffset ?? { east: 0, north: 0, lat: map.getCenter().lat };
  dragFrom = { pointer: e.pointerId, at: lngLatAt(e), offset };
  mapArea.setPointerCapture(e.pointerId);
});
mapArea.addEventListener('pointermove', (e) => {
  if (!dragFrom || e.pointerId !== dragFrom.pointer) return;
  const { offset } = dragFrom;
  const [east, north] = groundDelta(dragFrom.at, lngLatAt(e), offset.lat);
  setImageryOffset({ east: offset.east + east, north: offset.north + north, lat: offset.lat }, false);
});
const endDrag = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (dragFrom?.pointer !== e.pointerId) return;
  dragFrom = undefined;
  setImageryOffset(imageryOffset, true);
};
mapArea.addEventListener('pointerup', endDrag);
mapArea.addEventListener('pointercancel', endDrag);

/** Arrow keys nudge the imagery a screen pixel (ten with Shift); Esc finishes. */
function alignKey(e: KeyboardEvent): boolean {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return false;
  if (e.key === 'Escape') {
    setAligning(false);
    e.preventDefault();
    return true;
  }
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir) return false;
  const step = e.shiftKey ? 10 : 1;
  const c = map.project(map.getCenter());
  const offset = imageryOffset ?? { east: 0, north: 0, lat: map.getCenter().lat };
  const [east, north] = groundDelta(map.unproject(c), map.unproject([c.x + dir[0] * step, c.y + dir[1] * step]), offset.lat);
  setImageryOffset({ east: offset.east + east, north: offset.north + north, lat: offset.lat }, true);
  e.preventDefault();
  return true;
}


// ---------------------------------------------------------------- placing a job

// A job in assumed coordinates (10000, 10000 and an assumed north) has no
// place on the earth until someone puts it there: drag it into position and
// turn it about a pin until it sits on the imagery. The placement is kept on
// this device for each job, and goes into the repo's index on upload.
let placement: Placement | undefined;
let placing = false;
let placeDrag: { pointer: number; turn: boolean; at: maplibregl.LngLat; start: Placement; moved: boolean } | undefined;
const placePointers = new Set<number>();
let pin: maplibregl.Marker | undefined;
let redrawQueued = false;

function placementKey() {
  return `placement.${jobKey()}`;
}

function readPlacement(): Placement | undefined {
  try {
    const o = JSON.parse(readPref(placementKey()) || 'null');
    return isPlacement(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Move the job; `save` when a change is finished, rather than mid-drag. */
function setPlacement(pl: Placement | undefined, save: boolean) {
  if (!doc) return;
  placement = pl && { ...pl, rotation: normalizeAngle(pl.rotation), updated: new Date().toISOString() };
  doc.placement = placement;
  if (placement) applyPlacement(doc.points, placement);
  else removePlacement(doc.points);
  if (save) {
    writePref(placementKey(), placement ? JSON.stringify(placement) : '');
    // Starting over shouldn't bring back the placement the job was opened with.
    if (!placement && loaded?.origin) loaded.origin = { ...loaded.origin, placement: undefined };
    redrawPlaced();
    renderLoadStatus();
    renderProjection();
    renderLibrary();
    renderTable();
    renderDetail();
    renderMetadata();
  } else if (!redrawQueued) {
    // Dragging: redraw once a frame at most, so the controller keeps up.
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      redrawPlaced();
    });
  }
}

function redrawPlaced() {
  alignPoints();
  refreshMap(false);
  rebuildLinework();
  updatePin();
  renderPlaceFields();
}

function setPlacing(on: boolean) {
  if (on && !doc) return;
  if (on) setAligning(false);
  placing = on;
  placeDrag = undefined;
  renderPlace();
}

/** The point the job turns about, when the pin is on one. */
function pivotPoint(): JxlPoint | undefined {
  if (!doc || !placement) return undefined;
  const { north, east } = placement;
  return doc.points.find((p) => !p.deleted && p.coords.north === north && p.coords.east === east);
}

/**
 * Placing by hand is offered for grid-only jobs that are off the map, or
 * already placed; not for one its coordinate system put on the map.
 */
function placeOffered(): boolean {
  if (!doc || !canPlace(doc.points)) return false;
  return !!placement || doc.points.some((p) => p.coords.lat === undefined && p.coords.north !== undefined);
}

function renderPlace() {
  const button = $<HTMLButtonElement>('#place-job');
  button.hidden = !placeOffered() && !placing;
  button.classList.toggle('active', placing);
  button.classList.toggle('moved', !!placement);
  $('#place-bar').hidden = !placing;
  $('#place-target').hidden = !placing || !!placement;
  syncMapLock();
  updatePin();
  if (!placing) return;
  // Phones get the short version so the bar leaves room for the map.
  $('#place-help').innerHTML = placement
    ? `<span class="place-long"><strong>Drag</strong> to move the job and <strong>turn the ↻ handle</strong> to rotate it; the handle points along the job's north. <span class="muted">Tap a point to turn about it instead.</span></span>` +
      `<span class="place-short"><strong>Drag</strong> to move, <strong>turn ↻</strong> to rotate. <span class="muted">Tap a point to pivot on it.</span></span>`
    : `<span class="place-long"><strong>Find the site:</strong> pan and zoom until the target in the middle of the map is where this job goes, then tap Put it here.</span>` +
      `<span class="place-short"><strong>Find the site:</strong> put the target where the job goes, then tap Put it here.</span>`;
  $('#place-fields').hidden = !placement;
  const here = $('#place-here');
  here.textContent = placement ? 'Bring to middle' : 'Put it here';
  here.classList.toggle('primary', !placement);
  $('#place-reset').hidden = !placement;
  const done = $('#place-done');
  done.textContent = placement ? 'Done' : 'Cancel';
  done.classList.toggle('primary', !!placement);
  renderPlaceFields();
}

function renderPlaceFields() {
  if (!placing || !placement) return;
  const input = $<HTMLInputElement>('#place-rotation');
  if (document.activeElement !== input) {
    input.value = formatDms(placement.rotation);
    input.classList.remove('invalid');
  }
  const pivot = pivotPoint();
  $('#place-pivot').textContent = pivot ? `pivot ${pivot.name}` : '';
}

/** The pin the job turns about, with a handle along the job's north. */
function updatePin() {
  if (!placing || !placement) {
    pin?.remove();
    pin = undefined;
    return;
  }
  if (!pin) {
    const el = document.createElement('div');
    el.className = 'place-pin';
    el.innerHTML = '<div class="pin-arm"></div><div class="pin-dot"></div><div class="pin-knob" title="Turn the job" role="img" aria-label="Turn the job">↻</div>';
    pin = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' }).setLngLat([placement.lon, placement.lat]).addTo(map);
  }
  pin.setLngLat([placement.lon, placement.lat]).setRotation(placement.rotation);
}

function placementEntries(pl: Placement): [string, string][] {
  const unit = jobUnit();
  const len = (v: number) => `${(v / unit.metres).toFixed(3)} ${unit.label}`;
  const pivot = pivotPoint();
  return [
    ['Pinned at', `${pivot ? `${pivot.name}, ` : ''}N ${len(pl.north)}, E ${len(pl.east)}`],
    ['Which is at', `${pl.lat.toFixed(8)}, ${pl.lon.toFixed(8)} (WGS84)`],
    ['Rotation', `${formatDms(pl.rotation)} added to the job's bearings`],
    ['Placed', `${pl.updated.slice(0, 16).replace('T', ' ')} UTC`],
    ['How', 'By eye against the basemap. Distances and angles are kept as measured.'],
  ];
}

/** A tap while placing moves the pin to that point, so the job turns about it. */
function pivotAt(at: maplibregl.Point) {
  if (!doc || !placement) return;
  const hit = nearestPoint(at);
  const p = hit && hit.d <= TAP_TOLERANCE ? doc.points[hit.index] : undefined;
  if (p?.coords.source === 'Placed') setPlacement(repin(placement, p.coords.north!, p.coords.east!), true);
}

$('#place-job').addEventListener('click', () => setPlacing(!placing));
$('#place-start').addEventListener('click', () => {
  setPlacing(true);
  // On a phone, get the panel out of the way of the map.
  setSheet(false);
});
$('#place-done').addEventListener('click', () => setPlacing(false));
$('#place-reset').addEventListener('click', () => setPlacement(undefined, true));
$('#place-here').addEventListener('click', () => {
  if (!doc) return;
  const c = map.getCenter();
  if (placement) return setPlacement({ ...placement, lat: c.lat, lon: c.lng }, true);
  const pl = initialPlacement(doc.points, c.lat, c.lng);
  if (!pl) return;
  setPlacement(pl, true);
  renderPlace();
  refreshMap(true);
});
$<HTMLInputElement>('#place-rotation').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const rotation = parseAngle(input.value);
  input.classList.toggle('invalid', rotation === undefined);
  if (rotation === undefined || !placement) return;
  input.blur();
  setPlacement({ ...placement, rotation }, true);
});

mapArea.addEventListener('pointerdown', (e) => {
  if (!placing || !placement) return;
  placePointers.add(e.pointerId);
  // A second finger is a pinch: leave the job where it is.
  if (placePointers.size > 1) {
    if (placeDrag?.moved) setPlacement(placement, true);
    placeDrag = undefined;
    return;
  }
  const turn = !!(e.target as HTMLElement).closest('.pin-knob');
  placeDrag = { pointer: e.pointerId, turn, at: lngLatAt(e), start: placement, moved: false };
  mapArea.setPointerCapture(e.pointerId);
});
mapArea.addEventListener('pointermove', (e) => {
  if (!placeDrag || e.pointerId !== placeDrag.pointer) return;
  const { start, at } = placeDrag;
  const now = lngLatAt(e);
  placeDrag.moved = true;
  // Fade the bar so it doesn't hide what's being lined up.
  $('#place-bar').classList.add('dragging');
  if (placeDrag.turn) {
    const turned = bearingFromPin(start, now.lat, now.lng) - bearingFromPin(start, at.lat, at.lng);
    setPlacement({ ...start, rotation: start.rotation + turned }, false);
  } else {
    setPlacement({ ...start, lat: start.lat + now.lat - at.lat, lon: start.lon + now.lng - at.lng }, false);
  }
});
const endPlaceDrag = (e: PointerEvent) => {
  placePointers.delete(e.pointerId);
  if (placeDrag?.pointer !== e.pointerId) return;
  const moved = placeDrag.moved;
  placeDrag = undefined;
  $('#place-bar').classList.remove('dragging');
  if (moved) setPlacement(placement, true);
};
mapArea.addEventListener('pointerup', endPlaceDrag);
mapArea.addEventListener('pointercancel', endPlaceDrag);

/**
 * Arrow keys move the job a screen pixel (ten with Shift); [ and ] turn it a
 * minute of arc (ten with Shift); Esc finishes.
 */
function placeKey(e: KeyboardEvent): boolean {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return false;
  if (e.key === 'Escape') {
    setPlacing(false);
    e.preventDefault();
    return true;
  }
  if (!placement) return false;
  const turn = { '[': -1, ']': 1, '{': -1, '}': 1 }[e.key];
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  const step = e.shiftKey ? 10 : 1;
  if (turn) {
    setPlacement({ ...placement, rotation: placement.rotation + (turn * step) / 60 }, true);
  } else if (dir) {
    const c = map.project([placement.lon, placement.lat]);
    const to = map.unproject([c.x + dir[0] * step, c.y + dir[1] * step]);
    setPlacement({ ...placement, lat: to.lat, lon: to.lng }, true);
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}
