import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import type { FeatureCollection, Point } from 'geojson';
import { PRESETS } from './crs';
import { currentEpoch, nad83ToWgs84 } from './datum';
import { parseJxl, type JxlDocument, type JxlPoint, type ObservationType } from './jxl';
import { projectGrid, resolveProjection } from './projection';

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

// Layers are re-added whenever the basemap style is swapped.
let styleReady = false;
map.on('style.load', () => {
  styleReady = true;
  addPointLayers();
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
  map.addSource('points', { type: 'geojson', data: toGeoJSON() });
  map.addLayer({
    id: 'points-circle',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 16, 7],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
      'circle-opacity': ['case', ['get', 'deleted'], 0.35, 1],
    },
  });
  map.addLayer({
    id: 'points-selected',
    type: 'circle',
    source: 'points',
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
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#212529', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
}

// Pick the nearest point within a finger-sized box rather than requiring an
// exact hit on a small circle.
const TAP_TOLERANCE = 14;
map.on('click', (e) => {
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
  return {
    type: 'FeatureCollection',
    features: (doc?.points ?? [])
      .filter((p) => p.coords.mapLat !== undefined)
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.coords.mapLon!, p.coords.mapLat!] },
        properties: { index: p.index, name: p.name, code: p.code, deleted: p.deleted, color: color(p) },
      })),
  };
}

function colorFn(): (p: JxlPoint) => string {
  if (colorBy === 'type') return (p) => TYPE_COLORS[p.type];
  // Colour by feature code: the first word, so "PCC" and "PCC EC" match.
  const key = (p: JxlPoint) => p.code.split(/\s+/)[0];
  const counts = new Map<string, number>();
  for (const p of doc?.points ?? []) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  // The most common codes get distinct colours; the rest share grey.
  const byCode = new Map(ranked.map((code, i) => [code, PALETTE[Math.min(i, PALETTE.length - 1)]]));
  return (p) => byCode.get(key(p))!;
}

document.querySelectorAll<HTMLButtonElement>('#color-by button').forEach((b) =>
  b.addEventListener('click', () => {
    colorBy = b.dataset.colorBy as typeof colorBy;
    document.querySelectorAll('#color-by button').forEach((x) => x.classList.toggle('active', x === b));
    renderTable();
    refreshMap(false);
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
  load(await file.text(), file.name, file.size);
}

let loaded: { text: string; name: string; size: number } | undefined;

/** Parse and show a file. `gridDef` is a user-chosen projection for grid-only points. */
function load(text: string, name: string, size: number, gridDef?: { input: string; proj4: string }) {
  try {
    doc = parseJxl(text, { proj4: gridDef?.proj4 });
  } catch (e) {
    setStatus((e as Error).message, true);
    return;
  }
  loaded = { text, name, size };
  selected = undefined;
  document.body.classList.add('loaded');
  $('#dropzone strong').textContent = 'Open another file';
  doc.metadata.unshift({
    title: 'File',
    entries: [
      ['Name', name],
      ['Size', formatBytes(size)],
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
  const remaining = doc.points.filter((p) => p.coords.lat === undefined && p.coords.north !== undefined).length;
  $('#projection').hidden = remaining === 0;
  $('#grid-count').textContent = String(doc.gridOnlyCount);
  $('#tabs').hidden = false;
  showTab('points');
  renderTable();
  renderMetadata();
  renderDetail();
  setSheet(false);
  if (map.isStyleLoaded()) addPointLayers();
  setSelectedFilter();
  refreshMap(true);
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

$('#proj-presets').innerHTML = PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');

$('#proj-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!loaded) return;
  const input = $<HTMLInputElement>('#proj-input').value.trim();
  if (!input) return;
  try {
    const def = await resolveProjection(input);
    // Re-parse so total station shots from GNSS setups can be reduced too.
    load(loaded.text, loaded.name, loaded.size, { input, proj4: def });
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
  $('#tab-metadata').innerHTML = doc.metadata.map((s) => table(s.title, s.entries)).join('');
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
    map.setStyle(BASEMAPS[b.dataset.basemap!]);
  }),
);

// ---------------------------------------------------------------- utils

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
