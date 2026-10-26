import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import type { FeatureCollection, Point } from 'geojson';
import { PRESETS } from './crs';
import { currentEpoch, nad83ToWgs84 } from './datum';
import { parseJxl, type JxlDocument, type JxlPoint, type ObservationType } from './jxl';
import { initJobs, type JobOrigin } from './jobs';
import { projectGrid, resolveProjection } from './projection';
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
/** Whether the properties panel is showing in place of the point list. */
let showingDetail = false;
/** Point indices in list order, after the filter, for stepping through them. */
let listed: number[] = [];
let colorBy: 'code' | 'type' = 'code';
let alignToImagery = readPref('alignToImagery') !== 'false';
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
});

// Layers are re-added whenever the basemap style is swapped.
let styleReady = false;
map.on('style.load', () => {
  styleReady = true;
  addPointLayers();
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
  // Tile the points at full precision: the default (z18) quantises them to
  // about 2 cm, which smears shots that are a few hundredths apart.
  map.addSource('points', { type: 'geojson', data: toGeoJSON(), maxzoom: 24 });
  map.addLayer({
    id: 'points-circle',
    type: 'circle',
    source: 'points',
    layout,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 16, 7, 21, 7, 24, 5],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 21, 1.5, 24, 1],
      'circle-opacity': ['case', ['get', 'deleted'], 0.35, 1],
    },
  });
  map.addLayer({
    id: 'points-selected',
    type: 'circle',
    source: 'points',
    layout,
    filter: ['==', ['get', 'index'], selected ?? -1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 16, 12, 21, 12, 24, 9],
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
    ...p.features.map((f) => ({
      title: p.features.length > 1 || f.name !== p.code.split(/\s+/)[0] ? `Attributes · ${f.name}` : 'Attributes',
      // Unfilled photo/file/text fields are common and only add noise.
      props: Object.entries(f.attributes)
        .filter(([, v]) => v !== '')
        .map(([label, value]) => ({ label, value })),
    })),
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
          .map((prop) => `<tr><th>${esc(prop.label)}</th><td>${prop.kind === 'html' ? String(prop.value) : esc(formatProp(prop, unit))}</td></tr>`)
          .join('')}</table></details>`,
      )
      .join('')}
    <details class="group"><summary>All attributes (${Object.keys(p.attributes).length})</summary>${table('', Object.entries(p.attributes))}</details>
  `;
  el.querySelector('.back')!.addEventListener('click', showList);
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

