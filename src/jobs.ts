// The Jobs view: jobs kept in the OpenFieldView bucket as a list and as pins
// on the map, plus uploading the open file with its photos and attachments.
//
// Signing in is Cloudflare Access's job: the site only opens for people its
// policy allows, so here we just ask the server who that is.

import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { ApiError, fileUrl, loadIndex, loadVersions, post, readFile, SignInExpired, whoAmI, type Who } from './api';
import type { JxlDocument } from './jxl';
import { isViewable, stampTime, type IndexEntry, type JobIndex, type StoredFile, type StoredPlacement, type VersionList } from './layout';
import type { Placement } from './placement';
import { stash, takeStash } from './stash';
import { addItems, expandZips, jobName, referencedMedia, summarize, upload, type UploadItem } from './upload';
import { esc, formatBytes } from './util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Where an open file came from in the bucket. */
export interface JobOrigin {
  folder: string;
  /** The upload it was read from. */
  stamp: string;
  key: string;
  /** True when it's not the newest upload of the job. */
  older?: boolean;
  /** Where the job was placed on the map by hand, from the job's placement.json. */
  placement?: Placement;
}

/** The file open in the viewer, and what will go up with it. */
export interface OpenFile {
  /** Missing for a file the viewer can't show, like a Trimble .job on its own. */
  doc?: JxlDocument;
  text?: string;
  name: string;
  /** The file itself, when it isn't text the viewer read. */
  blob?: Blob;
  origin?: JobOrigin;
}

interface Options {
  map: maplibregl.Map;
  open: (text: string, name: string, size: number, origin: JobOrigin, extras?: File[]) => void;
  isSheet: () => boolean;
  setSheet: (expanded: boolean) => void;
  /** Whether the viewer's linework toggle is on. */
  showLines: () => boolean;
  /** After switching between the viewer and the Jobs map. */
  viewChanged: () => void;
}

const PIN = '#1c7ed6';

/**
 * Folder picking only works in desktop browsers: Chrome on Android (the
 * TSC710, phones) shows the input but can only pick files.
 */
const canPickFolder = 'webkitdirectory' in document.createElement('input') && !/Android|iPhone|iPad/i.test(navigator.userAgent);

export function initJobs({ map, open, isSheet, setSheet, showLines, viewChanged }: Options) {
  let who: Who | undefined;
  const whoReady = whoAmI().then(
    (w) => (who = w),
    (e) => (who = e instanceof SignInExpired ? { none: 'not-set-up', message: e.message } : { none: 'no-server' }),
  );
  let index: JobIndex | undefined;
  let loadedOnce = false;
  let active = false;
  let selected: string | undefined;
  let openFile: OpenFile | undefined;
  /** Photos, attachments and the .job going up with the open file. */
  let extras: UploadItem[] = [];
  let uploading = false;

  // ------------------------------------------------------------ loading

  async function refresh() {
    await whoReady;
    renderAccount();
    if (!who || !('email' in who)) {
      setJobsStatus(esc(unavailable()), who && 'none' in who && who.none === 'not-set-up');
      render();
      return;
    }
    setJobsStatus('Loading jobs…');
    try {
      index = await loadIndex();
      loadedOnce = true;
      const n = index?.jobs.length ?? 0;
      setJobsStatus(n ? '' : 'No jobs uploaded yet. Open a job in the Viewer and tap Upload.');
    } catch (e) {
      setJobsStatus(esc(message(e)), true);
    }
    render();
    fitJobs();
  }

  function unavailable(): string {
    if (who && 'none' in who && who.none === 'not-set-up') return who.message ?? 'Uploads are switched off on this site.';
    return 'Saved jobs live on your OpenFieldView server, and this copy of the site has none. The viewer works the same without one.';
  }

  function message(e: unknown): string {
    return (e as Error).message;
  }

  // ------------------------------------------------------------ list

  const jobs = () => index?.jobs ?? [];

  function visibleJobs(): IndexEntry[] {
    const q = $<HTMLInputElement>('#job-search').value.trim().toLowerCase();
    return jobs()
      .filter((j) => !q || j.job.toLowerCase().includes(q))
      .sort((a, b) => b.lastUpload.localeCompare(a.lastUpload));
  }

  function render() {
    $('#job-list').innerHTML = visibleJobs()
      .map(
        (j) => `<li data-key="${esc(j.folder)}" class="${j.folder === selected ? 'selected' : ''}">
        <strong>${esc(j.job)}</strong>
        <span class="muted">${formatDate(j.lastUpload)} · ${j.pointCount ?? '?'} pts · ${j.uploads} upload${j.uploads === 1 ? '' : 's'}${j.center ? '' : ' · no position'}</span>
      </li>`,
      )
      .join('');
    renderDetail();
    (map.getSource('jobs') as GeoJSONSource | undefined)?.setData(toGeoJSON());
  }

  $('#job-list').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li) select(li.dataset.key!, true);
  });
  $('#job-search').addEventListener('input', render);

  const find = (folder: string) => jobs().find((j) => j.folder === folder);

  function select(folder: string, fly: boolean) {
    selected = folder;
    const job = find(folder);
    if (fly && job?.center) {
      if (job.bbox) map.fitBounds(job.bbox, { padding: isSheet() ? 30 : 60, maxZoom: 17, duration: 600 });
      else map.flyTo({ center: job.center, zoom: 16 });
    }
    if (isSheet()) setSheet(false);
    setSelectedFilter();
    render();
    requestAnimationFrame(() => $('#job-detail').scrollIntoView({ block: 'nearest' }));
  }

  function renderDetail() {
    const el = $('#job-detail');
    const job = selected ? find(selected) : undefined;
    el.hidden = !job;
    if (!job) return;
    const rows: [string, string][] = [
      ['Last upload', `${esc(formatDate(job.lastUpload, true))}<span class="sub-value">${esc(job.lastUploadedBy)}</span>`],
      ['First upload', esc(formatDate(job.firstUpload, true))],
      ['Uploads', String(job.uploads)],
      ...(job.pointCount !== undefined ? [['Points', String(job.pointCount)] as [string, string]] : []),
      ...(job.controller ? [['Controller', esc(job.controller)] as [string, string]] : []),
      ...(job.crs ? [['Coordinate system', esc(job.crs)] as [string, string]] : []),
      ['Folder', `<span class="key">${esc(job.folder)}/</span>`],
    ];
    const main = job.main;
    el.innerHTML = `
      <div class="detail-head">
        <h2>${esc(job.job)}</h2>
        <button class="close" title="Close">×</button>
      </div>
      <div class="actions">
        ${main ? `<button data-act="open" class="primary">Open</button><a class="button" href="${esc(fileUrl(main, true))}">Download .${esc(main.split('.').pop()!)}</a>` : '<span class="muted">No .jxl or .rw5 in the latest upload.</span>'}
      </div>
      <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <details class="versions"><summary>Uploads and files</summary><div class="versions-body muted">Loading…</div></details>
    `;
    el.querySelector('.close')!.addEventListener('click', () => {
      selected = undefined;
      setSelectedFilter();
      render();
    });
    el.querySelector('[data-act=open]')?.addEventListener('click', () => openKey(job, main!, job.latest));
    const versions = el.querySelector<HTMLDetailsElement>('.versions')!;
    versions.addEventListener('toggle', () => versions.open && renderVersions(job, versions.querySelector('.versions-body')!), { once: true });
  }

  async function renderVersions(job: IndexEntry, el: HTMLElement) {
    let list: VersionList | undefined;
    try {
      list = await loadVersions(job.folder);
    } catch (e) {
      el.innerHTML = `<span class="error-text">${esc(message(e))}</span>`;
      return;
    }
    if (!list) {
      el.textContent = 'versions.json is missing. Rebuild the job list (under Account) to bring it back.';
      return;
    }
    el.classList.remove('muted');
    const fileLink = (f: StoredFile) =>
      `<li><a href="${esc(fileUrl(f.key))}" target="_blank" rel="noopener">${esc(f.name)}</a> <span class="muted">${formatBytes(f.size)}</span>
        <a class="dl" href="${esc(fileUrl(f.key, true))}" title="Download ${esc(f.name)}" aria-label="Download ${esc(f.name)}">⤓</a></li>`;
    el.innerHTML = `<ul class="version-list">${list.versions
      .map(
        (v, i) => `<li>
          <div class="version-head">
            <span><strong>${esc(formatDate(v.uploadedAt, true))}</strong>${i === 0 ? ' <span class="tag">latest</span>' : ''}<br>
              <span class="muted">${esc(v.uploadedBy)} · <span class="key">${esc(v.stamp)}</span></span></span>
            ${v.main ? `<span class="actions"><button data-key="${esc(v.main)}" data-stamp="${esc(v.stamp)}">Open</button></span>` : ''}
          </div>
          ${v.note ? `<p class="note">${esc(v.note)}</p>` : ''}
          <ul class="files">${v.files.map(fileLink).join('')}${v.media.map(fileLink).join('')}</ul>
        </li>`,
      )
      .join('')}</ul>`;
    el.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((b) => b.addEventListener('click', () => openKey(job, b.dataset.key!, b.dataset.stamp!)));
  }

  async function openKey(job: IndexEntry, key: string, at: string) {
    setJobsStatus(`Opening ${esc(job.job)}…`);
    try {
      const text = await (await readFile(key)).text();
      setJobsStatus('');
      open(text, key.split('/').pop()!, new TextEncoder().encode(text).length, {
        folder: job.folder,
        stamp: at,
        key,
        older: at !== job.latest,
        placement: job.placement,
      });
    } catch (e) {
      if (e instanceof SignInExpired) return expiredInJobs();
      setJobsStatus(esc(message(e)), true);
    }
  }

  function setJobsStatus(html: string, error = false) {
    const el = $('#jobs-status');
    el.innerHTML = html;
    el.classList.toggle('error', error);
  }

  function expiredInJobs() {
    setJobsStatus(`${esc(new SignInExpired().message)} <button class="link" data-act="reload">Sign in again</button>`, true);
    $('#jobs-status [data-act=reload]').addEventListener('click', () => location.reload());
  }

  // ------------------------------------------------------------ map

  function toGeoJSON(): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: visibleJobs()
        .filter((j) => j.center)
        .map((j) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: j.center! }, properties: { key: j.folder, name: j.job } })),
    };
  }

  function addLayers() {
    if (map.getSource('jobs')) return;
    map.addSource('jobs', { type: 'geojson', data: toGeoJSON() });
    const visibility = active ? 'visible' : 'none';
    map.addLayer({
      id: 'jobs-pin',
      type: 'circle',
      source: 'jobs',
      layout: { visibility },
      paint: { 'circle-radius': 9, 'circle-color': PIN, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'jobs-selected',
      type: 'circle',
      source: 'jobs',
      layout: { visibility },
      filter: ['==', ['get', 'key'], selected ?? ''],
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffd43b', 'circle-stroke-width': 3.5 },
    });
    map.addLayer({
      id: 'jobs-label',
      type: 'symbol',
      source: 'jobs',
      layout: {
        visibility,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-max-width': 30,
        'text-optional': true,
      },
      paint: { 'text-color': '#212529', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
  }

  function setSelectedFilter() {
    if (map.getLayer('jobs-selected')) map.setFilter('jobs-selected', ['==', ['get', 'key'], selected ?? '']);
  }

  function fitJobs() {
    if (!active) return;
    const pts = toGeoJSON().features.map((f) => (f.geometry as Point).coordinates as [number, number]);
    if (!pts.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const p of pts) bounds.extend(p);
    map.fitBounds(bounds, { padding: isSheet() ? 60 : 100, maxZoom: 15, duration: 600 });
  }

  /** Tap on a pin. Returns true when it handled the click. */
  function handleClick(e: MapMouseEvent, tolerance: number): boolean {
    if (!active || !map.getLayer('jobs-pin')) return false;
    const { x, y } = e.point;
    const hits = map.queryRenderedFeatures(
      [
        [x - tolerance, y - tolerance],
        [x + tolerance, y + tolerance],
      ],
      { layers: ['jobs-pin'] },
    );
    if (hits.length) select(String(hits[0].properties.key), false);
    return true;
  }
  map.on('mouseenter', 'jobs-pin', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'jobs-pin', () => (map.getCanvas().style.cursor = ''));

  function show(on: boolean) {
    active = on;
    for (const id of ['jobs-pin', 'jobs-selected', 'jobs-label']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    if (on && !loadedOnce) refresh();
    else if (on) fitJobs();
  }

  // ------------------------------------------------------------ uploading

  /** Call whenever a file is opened in the viewer, with any files picked alongside it. */
  function setOpenFile(file: OpenFile | undefined, alongside: File[] = []) {
    const sameJob = openFile && file && uploadName(openFile) === uploadName(file);
    openFile = file;
    // Photos added for this job stay when it's reopened, say after changing the coordinate system.
    if (!sameJob) extras = [];
    extras = addItems(extras, alongside);
    renderSaveRow();
  }

  /** Photos or other files dropped while a job is open: they go up with it. */
  function addExtras(files: File[]) {
    extras = addItems(extras, files);
    renderSaveRow();
    ($('#upload-extras') as HTMLDetailsElement | null)?.setAttribute('open', '');
  }

  const uploadName = (f: OpenFile) => jobName(f.doc, f.origin?.folder ?? f.name);
  const hasOpenFile = () => !!openFile;

  async function renderSaveRow() {
    const el = $('#save-row');
    el.hidden = !openFile;
    if (!openFile) return;
    await whoReady;
    if (!who || !('email' in who)) {
      el.innerHTML = `<p class="muted small">${esc(unavailable())}</p>`;
      return;
    }
    const mentioned = openFile.text ? referencedMedia(openFile.text) : [];
    const added = new Set(extras.map((x) => x.name.toLowerCase()));
    const missing = mentioned.filter((m) => !added.has(m.toLowerCase()));
    const summaryText = extras.length ? `${extras.length} added` : '';
    el.innerHTML = `
      <div class="save-controls">
        <button id="save-btn" class="primary" ${uploading ? 'disabled' : ''}>Upload ${esc(uploadName(openFile))}</button>
      </div>
      <details id="upload-extras" ${extras.length || missing.length ? 'open' : ''}>
        <summary>Photos, attachments and note${summaryText ? ` <span class="count">· ${esc(summaryText)}</span>` : ''}</summary>
        <div class="extras-body">
          ${extras.length ? `<ul class="extras-list">${extras.map((x, i) => `<li><span class="name">${esc(x.name)}</span><span class="muted">${formatBytes(x.blob.size)}</span><button data-remove="${i}" title="Leave out ${esc(x.name)}" aria-label="Leave out ${esc(x.name)}">×</button></li>`).join('')}</ul>` : ''}
          ${missing.length ? `<p class="small warn-text">The job mentions ${missing.length} file${missing.length === 1 ? '' : 's'} not added yet: ${missing.slice(0, 6).map(esc).join(', ')}${missing.length > 6 ? '…' : ''}</p>` : ''}
          <div class="add-row">
            <label class="add-files button" for="extras-input">Add photos or files</label>
            ${canPickFolder ? '<label class="add-files button" for="folder-input">Pick a folder</label><input id="folder-input" type="file" webkitdirectory hidden />' : ''}
          </div>
          <input id="extras-input" type="file" multiple hidden />
          <p class="muted small">${canPickFolder ? 'Pick several files, a whole folder, or a .zip of it.' : "Pick several at once: open the job's Files folder, long-press a photo, then ⋮ → Select all. A .zip of the folder works too."} The Trimble .job file can go up as well.</p>
          <label class="note-label" for="upload-note">Note <span class="muted">(optional)</span></label>
          <textarea id="upload-note" rows="2" placeholder="What changed on this visit">${esc(noteDraft)}</textarea>
        </div>
      </details>
      <div id="save-status" class="muted"></div>`;
    el.querySelector('#save-btn')!.addEventListener('click', () => send());
    el.querySelectorAll<HTMLInputElement>('#extras-input, #folder-input').forEach((picker) => picker.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      input.value = '';
      try {
        addExtras(await expandZips(files));
      } catch (err) {
        $('#save-status').innerHTML = `<span class="error-text">${esc(message(err))}</span>`;
      }
    }));
    el.querySelector<HTMLTextAreaElement>('#upload-note')!.addEventListener('input', (e) => (noteDraft = (e.target as HTMLTextAreaElement).value));
    el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        extras.splice(Number(b.dataset.remove), 1);
        renderSaveRow();
      }),
    );
  }
  let noteDraft = '';

  async function send() {
    if (!openFile || uploading) return;
    const file = openFile;
    const btn = $<HTMLButtonElement>('#save-btn');
    const status = $('#save-status');
    uploading = true;
    btn.disabled = true;
    status.classList.remove('error-text');
    status.textContent = 'Checking what needs sending…';
    try {
      const main: UploadItem | undefined = file.text !== undefined
        ? { name: file.name, blob: new Blob([file.text], { type: /\.rw5$/i.test(file.name) ? 'text/plain' : 'application/xml' }), kind: 'job' }
        : file.blob && { name: file.name, blob: file.blob, kind: 'job' };
      const items = extras.filter((x) => !main || x.kind !== 'job' || x.name.toLowerCase() !== main.name.toLowerCase());
      if (main) items.unshift(main);
      const result = await upload(
        {
          job: uploadName(file),
          items,
          main: main && isViewable(main.name) ? main.name : undefined,
          note: noteDraft,
          summary: summarize(file.doc),
          placement: file.doc?.placement as StoredPlacement | undefined,
        },
        (sent, total, name) => {
          status.innerHTML = name
            ? `Uploading ${esc(name)}… <span class="muted">${formatBytes(sent)} of ${formatBytes(total)}</span><progress max="${total}" value="${sent}"></progress>`
            : 'Finishing…';
        },
      );
      if (result.status === 'unchanged') status.textContent = 'Already uploaded: nothing has changed since the last upload.';
      else if (result.status === 'placed') status.textContent = 'Saved where the job sits on the map. The files were already uploaded.';
      else if (result.status === 'uploaded') {
        const r = result.record;
        status.innerHTML = `Uploaded to <span class="key">${esc(r.folder)}/${esc(r.stamp)}/</span>${result.reused ? ` <span class="muted">(${result.reused} file${result.reused === 1 ? ' was' : 's were'} already there)</span>` : ''}`;
        noteDraft = '';
        const note = document.querySelector<HTMLTextAreaElement>('#upload-note');
        if (note) note.value = '';
        if (r.main && file.text !== undefined) file.origin = { folder: r.folder, stamp: r.stamp, key: r.main, placement: file.doc?.placement };
      }
      loadedOnce = false; // reload the list next time Jobs is shown
    } catch (e) {
      if (e instanceof SignInExpired) {
        await stash({ then: 'upload', file: { text: file.text, blob: file.blob, name: file.name, origin: file.origin }, extras, note: noteDraft });
        status.innerHTML = `<span class="error-text">${esc(e.message)}</span> <button class="link" data-act="reload">Sign in again</button>`;
        status.querySelector('[data-act=reload]')!.addEventListener('click', () => location.reload());
      } else {
        status.innerHTML = `<span class="error-text">${esc(message(e))}</span>`;
      }
    } finally {
      uploading = false;
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ account

  function renderAccount() {
    const body = $('#settings-body');
    if (!who) {
      body.innerHTML = '<p class="muted small">Checking…</p>';
      return;
    }
    if (!('email' in who)) {
      body.innerHTML = `<p class="muted small">${esc(unavailable())}</p>`;
      return;
    }
    body.innerHTML = `
      <div class="account">
        <span>Signed in as <strong>${esc(who.email)}</strong></span>
        <a class="link" href="/cdn-cgi/access/logout">Sign out</a>
      </div>
      <p class="muted small">Jobs are kept in the OpenFieldView R2 bucket, one folder per job and one folder per upload inside it.</p>
      <div class="actions"><button id="rebuild-btn">Rebuild the job list</button></div>
      <p class="muted small">Only needed if index.json or a versions.json was deleted or edited by hand in the bucket.</p>`;
    body.querySelector('#rebuild-btn')!.addEventListener('click', async (e) => {
      const b = e.target as HTMLButtonElement;
      b.disabled = true;
      setJobsStatus('Rebuilding the job list from the uploads in the bucket…');
      try {
        index = await post<JobIndex>('rebuild');
        setJobsStatus(`Rebuilt: ${index.jobs.length} job${index.jobs.length === 1 ? '' : 's'}.`);
        render();
        fitJobs();
      } catch (err) {
        if (err instanceof SignInExpired) expiredInJobs();
        else setJobsStatus(esc(err instanceof ApiError ? err.message : message(err)), true);
      } finally {
        b.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ views

  function showView(view: 'viewer' | 'jobs') {
    document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('#view-viewer').hidden = view !== 'viewer';
    $('#view-jobs').hidden = view !== 'jobs';
    $('#sidebar').scrollTop = 0;
    for (const layer of map.getStyle()?.layers ?? []) {
      if (!/^(points|lines)-/.test(layer.id)) continue;
      // Linework stays hidden if the viewer has turned it off.
      const on = view === 'viewer' && (!layer.id.startsWith('lines-') || showLines());
      map.setLayoutProperty(layer.id, 'visibility', on ? 'visible' : 'none');
    }
    show(view === 'jobs');
    viewChanged();
  }
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view as 'viewer' | 'jobs')),
  );

  whoReady.then(renderAccount);
  resumeAfterSignIn();

  /** Reopen the job that was being uploaded when the sign-in ran out. */
  async function resumeAfterSignIn() {
    const before = await takeStash();
    if (!before?.file) return;
    const { text, blob, name, origin } = before.file;
    noteDraft = before.note ?? '';
    const restored = (before.extras ?? []).map((x) => new File([x.blob], x.name));
    if (text !== undefined) open(text, name, new TextEncoder().encode(text).length, origin as JobOrigin, restored);
    else if (blob) {
      setOpenFile({ name, blob }, restored);
    }
    $('#save-status').textContent = 'Signed in again. Tap Upload to send it.';
  }

  return { addLayers, handleClick, setOpenFile, addExtras, hasOpenFile, showView, isActive: () => active };
}

function formatDate(iso: string, time = false) {
  const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(iso) ? stampTime(iso) : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
