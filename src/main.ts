import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import type { FeatureCollection, Point } from 'geojson';
import { PRESETS } from './crs';
import { currentEpoch, nad83ToWgs84 } from './datum';
import { DEFAULT_CONTROLS, jobLibraryName, lookupFeature, parseFxl, type FeatureLibrary } from './fxl';
import { deleteLibrary, getLibrary, listLibraries, saveLibrary } from './librarystore';
import { initLineMap } from './linemap';
import { parseJxl, type JxlDocument, type JxlPoint, type ObservationType } from './jxl';
import { initJobs, type JobOrigin } from './jobs';
import { buildLinework, parseCode, type Linework } from './linework';
import { projectGrid, resolveProjection } from './projection';
import { featureGroups } from './featureprops';
import { groundDelta, IMAGERY_TILES, initImagery, isZero, type ImageryOffset } from './imagery';
import { formatProp, latLonDms, type PropGroup, type Unit } from './properties';
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
/** Whether the properties panel is showing in place of the point list. */
let showingDetail = false;
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
  linework = doc ? buildLinework(doc.points, library) : undefined;
  refreshLines();
}

function refreshLines() {
  lineMap.update(linework?.lines ?? { type: 'FeatureCollection', features: [] }, library, codeColorFn());
}

// Pick the nearest point within a finger-sized box rather than requiring an
// exact hit on a small circle.
const TAP_TOLERANCE = 14;
map.on('click', (e) => {
  if (aligning) return;
  if (jobs.handleClick(e, TAP_TOLERANCE)) return;
  if (!map.getLayer('points-circle')) return;
  const { x, y } = e.point;
  const hits = map.queryRenderedFeatures(
    [
      [x - TAP_TOLERANCE, y - TAP_TOLERANCE],
      [x + TAP_TOLERANCE, y + TAP_TOLERANCE],
    ],
    { layers: ['points-circle'] },
  );
  if (!hits.length) return;
  const nearest = hits
    .map((f) => ({ f, d: map.project((f.geometry as Point).coordinates as [number, number]).dist(e.point) }))
    .sort((a, b) => a.d - b.d)[0].f;
  select(Number(nearest.properties.index), false);
});
map.on('mouseenter', 'points-circle', () => !aligning && (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'points-circle', () => !aligning && (map.getCanvas().style.cursor = ''));

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
  map.fitBounds(bounds, { padding: isSheet() ? 30 : 60, maxZoom: 18, duration: 600 });
}

// ---------------------------------------------------------------- loading

async function loadFile(file: File) {
  const text = await file.text();
  if (isLibraryFile(file.name, text)) addLibrary(text, file.name);
  else load(text, file.name, file.size);
}

function isLibraryFile(name: string, text: string) {
  if (/\.fxl$/i.test(name)) return true;
  if (/\.jxl$/i.test(name)) return false;
  // Unknown extension: anything that isn't a JobXML job is tried as a library.
  return !/<JOBFile[\s>]/.test(text.slice(0, 4096));
}

let loaded: { text: string; name: string; size: number; origin?: JobOrigin } | undefined;

/**
 * Parse and show a file. `gridDef` is a user-chosen projection for grid-only
 * points; `origin` is the repo it was opened from.
 */
function load(text: string, name: string, size: number, gridDef?: { input: string; proj4: string }, origin?: JobOrigin) {
  try {
    doc = parseJxl(text, { proj4: gridDef?.proj4 });
  } catch (e) {
    setStatus((e as Error).message, true);
    return;
  }
  loaded = { text, name, size, origin };
  jobs.setOpenFile({ doc, text, name, origin });
  selected = undefined;
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
  // Place grid-only points straight away when the job's projection is known.
  let projected = 0;
  let projectionError = '';
  const detected = doc.crs.projection;
  const projection = gridDef ?? (detected && { input: detected.id ?? '', proj4: detected.proj4 });
  const projectionLabel = gridDef ? gridDef.input : detected?.label;
  if (doc.gridOnlyCount && projection) {
    try {
      projected = projectGrid(doc.points, projection.proj4, doc.crs.adjustment);
      $<HTMLInputElement>('#proj-input').value = projection.input;
    } catch (err) {
      // For a detected projection, quietly leave it to the user to pick one.
      if (gridDef) projectionError = `Couldn't use that coordinate system: ${esc((err as Error).message)}`;
    }
  }
  const mapped = doc.points.filter((p) => p.coords.lat !== undefined).length;
  const types = (['GNSS', 'Total station', 'Computed', 'Keyed in'] as ObservationType[])
    .map((t) => [t, doc!.points.filter((p) => p.type === t).length] as const)
    .filter(([, n]) => n)
    .map(([t, n]) => `${n} ${t === 'GNSS' ? t : t.toLowerCase()}`);
  setStatus(
    `<strong>${esc(name)}</strong>: ${doc.points.length} points${types.length ? ` (${types.join(', ')})` : ''}, ${mapped} on the map.` +
      (projected ? `<br><span class="muted">${projected} grid points placed using ${esc(projectionLabel!)}.</span>` : ''),
  );
  $('#align-row').hidden = !doc.crs.nad83;
  alignPoints();
  setImageryOffset(readOffset(), false);
  linework = buildLinework(doc.points, library);
  const remaining = doc.points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;
  $('#projection').hidden = remaining === 0;
  $('#grid-count').textContent = String(doc.gridOnlyCount);
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

$('#sample-btn').addEventListener('click', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}sample.jxl`);
  const text = await res.text();
  load(text, 'sample.jxl', text.length);
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
    if (shift) {
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

function select(index: number, fly: boolean) {
  if (!doc) return;
  selected = index;
  showingDetail = true;
  const p = doc.points[index];
  showTab('points');
  setSelectedFilter();
  if (isSheet()) setSheet(false);
  if (fly && p.coords.mapLat !== undefined) map.flyTo({ center: [p.coords.mapLon!, p.coords.mapLat!], zoom: Math.max(map.getZoom(), 17) });
  renderTable();
  renderDetail();
  // Bring the properties to the top of the panel.
  $('#point-detail').scrollIntoView({ block: 'start' });
}

/** Back to the list, keeping the point highlighted and the list where it was. */
function showList() {
  showingDetail = false;
  renderDetail();
  document.querySelector(`#points-table tr[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (aligning && alignKey(e)) return;
  if (!showingDetail || (e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'Escape') showList();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1);
  else return;
  e.preventDefault();
});

/** Move to the next or previous point in the list. */
function step(by: 1 | -1) {
  const at = listed.indexOf(selected ?? -1);
  const next = listed[at + by];
  if (next !== undefined) select(next, true);
}

function setSelectedFilter() {
  if (map.getLayer('points-selected')) map.setFilter('points-selected', ['==', ['get', 'index'], selected ?? -1]);
}

function renderDetail() {
  const el = $('#point-detail');
  const p = showingDetail && selected !== undefined ? doc?.points[selected] : undefined;
  el.hidden = !p;
  $('#point-list').hidden = !!p;
  if (!p) return;
  const unit = jobUnit();
  const at = listed.indexOf(p.index);
  const groups: PropGroup[] = [
    coordinateGroup(p),
    ...featureGroups(p, library),
    pointGroup(p),
    ...p.observation,
  ];
  el.innerHTML = `
    <div class="detail-head">
      <div class="detail-nav">
        <button class="back" title="Back to the point list (Esc)">‹ Points</button>
        <span class="muted">${at >= 0 ? `${at + 1} of ${listed.length}` : ''}</span>
        <span class="stepper">
          <button data-step="-1" title="Previous point (↑)" ${at <= 0 ? 'disabled' : ''}>↑</button>
          <button data-step="1" title="Next point (↓)" ${at < 0 || at >= listed.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </div>
      <h2><span class="name">${esc(p.name || '(unnamed)')}</span>${p.code ? ` <span class="code">${esc(p.code)}</span>` : ''}</h2>
    </div>
    ${p.deleted ? '<p class="warn">This point is marked deleted in the field book.</p>' : ''}
    ${groups
      .filter((g) => g.props.length)
      .map(
        (g) => `<details class="group" open><summary>${esc(g.title)}</summary><table class="kv">${g.props
          .map((prop) => `<tr${prop.hint ? ' class="has-hint"' : ''}><th>${prop.hint ? `<span class="label">${esc(prop.label)}</span>` : esc(prop.label)}${prop.hint ? `<span class="hint">${esc(prop.hint)}</span>` : ''}</th><td>${prop.kind === 'html' ? String(prop.value) : esc(formatProp(prop, unit))}</td></tr>`)
          .join('')}</table></details>`,
      )
      .join('')}
    <details class="group"><summary>All attributes (${Object.keys(p.attributes).length})</summary>${table('', Object.entries(p.attributes))}</details>
  `;
  el.querySelector('.back')!.addEventListener('click', showList);
  // Tap an attribute's name to read the library's description of it.
  el.querySelectorAll('tr.has-hint').forEach((tr) => tr.addEventListener('click', () => tr.classList.toggle('show-hint')));
  el.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step) as 1 | -1)));
}

function pointGroup(p: JxlPoint): PropGroup {
  const props: PropGroup['props'] = [{ label: 'Measured by', value: p.type }];
  if (p.method) props.push({ label: 'Method', value: p.method });
  if (p.surveyMethod) props.push({ label: 'Survey method', value: p.surveyMethod });
  if (p.classification && p.classification !== 'Normal') props.push({ label: 'Classification', value: p.classification });
  if (p.stored) props.push({ label: 'Stored', value: p.stored.replace('T', ' ') });
  props.push({ label: 'Record ID', value: `${p.id} (${p.origin})` });
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
    props.push({ label: 'Lat/long from', value: c.source === 'Grid' ? 'Grid coordinates' : c.source! });
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
  $('#tab-metadata').innerHTML = [...doc.metadata, { title: 'Linework', entries: lines }].map((s) => table(s.title, s.entries)).join('');
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
  }),
);

// ---------------------------------------------------------------- imagery alignment

// The imagery is moved, not the survey: drag it until it sits under the
// points and linework. The offset is kept on this device for each job.
let imageryOffset: ImageryOffset | undefined;
let aligning = false;
let dragFrom: { pointer: number; at: maplibregl.LngLat; offset: ImageryOffset } | undefined;
const pointers = new Set<number>();

/** The job's own name, so every version of it opened from a repo shares an offset. */
function offsetKey() {
  const name = doc?.job.jobName || (loaded?.name ?? '').replace(/(_[0-9a-f]{7})?\.jxl$/i, '');
  return `imageryOffset.${name}`;
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
  aligning = on;
  dragFrom = undefined;
  // One finger moves the imagery; pinching still zooms, without rotating.
  for (const h of [map.dragPan, map.dragRotate, map.keyboard, map.touchPitch]) {
    if (on) h.disable();
    else h.enable();
  }
  if (on) map.touchZoomRotate.disableRotation();
  else map.touchZoomRotate.enableRotation();
  map.getCanvas().style.cursor = on ? 'move' : '';
  // Without this the browser takes a one-finger drag as a page scroll.
  map.getCanvasContainer().classList.toggle('aligning', on);
  renderAlign();
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

