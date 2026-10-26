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
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
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
let colorBy: 'code' | 'type' = 'code';
let alignToImagery = readPref('alignToImagery') !== 'false';
let showLines = readPref('showLines') !== 'false';
let basemap = 'streets';
let library: FeatureLibrary | undefined;
/** Resolves once the stored libraries have been listed and the last one opened. */
let libraryReady: Promise<void> = Promise.resolve();
let linework: Linework | undefined;
const mapEpoch = currentEpoch();

let map: maplibregl.Map;
try {
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS.streets,
    center: [0, 20],
    zoom: 1.5,
    attributionControl: { compact: true },
  });
} catch (e) {
  $('#map').innerHTML = `<p class="map-error">The map can't start in this browser (WebGL is unavailable). Points and metadata still work in the panel.<br><small>${esc(String(e))}</small></p>`;
  throw e;
}
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
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

// Layers are re-added whenever the basemap style is swapped.
let styleReady = false;
map.on('style.load', () => {
  styleReady = true;
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
  map.addSource('points', { type: 'geojson', data: toGeoJSON() });
  map.addLayer({
    id: 'points-circle',
    type: 'circle',
    source: 'points',
    layout,
    paint: {
      // Vertices of linework are smaller, and points drawn with a library
      // symbol shrink to a dot at its centre.
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4,
        3,
        16,
        ['case', ['!=', ['get', 'symbol'], ''], 2.5, ['get', 'onLine'], 4.5, 7],
      ],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
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
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 16, 12],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ffd43b',
      'circle-stroke-width': 3,
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
      'text-offset': [0, 1.1],
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
map.on('mouseenter', 'points-circle', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'points-circle', () => (map.getCanvas().style.cursor = ''));

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
  const rows = doc.points
    .filter((p) => !q || [p.name, p.code, p.type, TYPE_SHORT[p.type]].some((s) => s.toLowerCase().includes(q)))
    .map(
      (p) => `<tr data-index="${p.index}" class="${p.index === selected ? 'selected' : ''} ${p.deleted ? 'deleted' : ''}">
        <td><span class="swatch" style="background:${color(p)}"></span>${esc(p.name)}</td>
        <td>${esc(p.code)}</td>
        <td>${TYPE_SHORT[p.type]}${p.coords.lat === undefined ? ' <span class="muted">· no position</span>' : ''}</td>
      </tr>`,
    );
  $('#points-table tbody').innerHTML = rows.join('');
}

$('#points-table tbody').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('tr');
  if (row) select(Number(row.dataset.index), true);
});

function select(index: number, fly: boolean) {
  if (!doc) return;
  selected = index;
  const p = doc.points[index];
  showTab('points');
  setSelectedFilter();
  if (isSheet()) {
    // Keep the map visible above the sheet, with the detail card in view.
    setSheet(false);
    requestAnimationFrame(() => $('#point-detail').scrollIntoView({ block: 'start' }));
  }
  if (fly && p.coords.mapLat !== undefined) map.flyTo({ center: [p.coords.mapLon!, p.coords.mapLat!], zoom: Math.max(map.getZoom(), 17) });
  renderTable();
  renderDetail();
  if (!isSheet()) document.querySelector(`#points-table tr[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
}

function setSelectedFilter() {
  if (map.getLayer('points-selected')) map.setFilter('points-selected', ['==', ['get', 'index'], selected ?? -1]);
}

function renderDetail() {
  const el = $('#point-detail');
  const p = selected !== undefined ? doc?.points[selected] : undefined;
  el.hidden = !p;
  if (!p) return;
  el.innerHTML = `
    <div class="detail-head">
      <h2>${esc(p.name || '(unnamed)')}${p.code ? ` <span class="code">${esc(p.code)}</span>` : ''}</h2>
      <button class="close" title="Close">×</button>
    </div>
    ${p.deleted ? '<p class="warn">This point is marked deleted in the field book.</p>' : ''}
    ${p.features.map((f) => table(`Feature: ${f.name}`, Object.entries(f.attributes).filter(([, v]) => v !== ''))).join('')}
    ${table('Position', positionEntries(p))}
    <details><summary>All attributes (${Object.keys(p.attributes).length})</summary>${table('', Object.entries(p.attributes))}</details>
  `;
  el.querySelector('.close')!.addEventListener('click', () => {
    selected = undefined;
    setSelectedFilter();
    renderDetail();
    renderTable();
  });
}

function positionEntries(p: JxlPoint): [string, string][] {
  const c = p.coords;
  const out: [string, string][] = [];
  out.push(['Measured by', p.type]);
  // Grid values in the job's own units, as the crew saw them.
  const unit = jobUnit();
  if (c.north !== undefined) out.push([`North (${unit.label})`, (c.north / unit.metres).toFixed(3)]);
  if (c.east !== undefined) out.push([`East (${unit.label})`, (c.east / unit.metres).toFixed(3)]);
  if (c.elevation !== undefined) out.push([`Elevation (${unit.label})`, (c.elevation / unit.metres).toFixed(3)]);
  if (c.reduced) out.push(['Grid from', 'Reduced from the total station observation by OpenFieldView']);
  if (c.lat !== undefined) {
    out.push(['Latitude', c.lat.toFixed(9)], ['Longitude', c.lon!.toFixed(9)]);
    if (c.height !== undefined) out.push(['Ellipsoid height (m)', c.height.toFixed(3)]);
    out.push(['Lat/long from', c.source === 'Grid' ? 'Grid coordinates' : c.source!]);
    if (c.mapLat !== undefined && (c.mapLat !== c.lat || c.mapLon !== c.lon)) {
      out.push([`Map position (ITRF2020 ≈ WGS84, ${mapEpoch.toFixed(2)})`, `${c.mapLat.toFixed(9)}, ${c.mapLon!.toFixed(9)}`]);
    }
  }
  out.push(['Record ID', p.id], ['From', p.origin]);
  return out;
}

function jobUnit(): { label: string; metres: number } {
  const u = (doc?.crs.distanceUnits ?? '').toLowerCase();
  if (u.includes('survey')) return { label: 'US ft', metres: 1200 / 3937 };
  if (u.includes('feet') || u.includes('foot')) return { label: 'ft', metres: 0.3048 };
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
  }),
);

