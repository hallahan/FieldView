// The Jobs view: jobs saved in GitHub repos as a list and as pins on the map,
// plus saving the open file and the repo/token settings.

import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { GitHub, GitHubError, parseRepo, type Commit, type RepoInfo, type RepoRef } from './github';
import type { JxlDocument } from './jxl';
import { loadIndex, saveJob, type JobFeature } from './library';
import { loadSettings, repoSlug, saveSettings, setupLink, takeSetupFromUrl, type Settings } from './settings';
import { esc, formatBytes } from './util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Where an open file came from, so saving it again defaults to the same repo. */
export interface JobOrigin {
  repo: string;
  path: string;
  /** Commit the file was read at, when it's an older version. */
  version?: string;
}

interface RepoState {
  ref: RepoRef;
  info?: RepoInfo;
  jobs: JobFeature[];
  error?: string;
}

interface Options {
  map: maplibregl.Map;
  open: (text: string, name: string, size: number, origin: JobOrigin) => void;
  isSheet: () => boolean;
  setSheet: (expanded: boolean) => void;
}

const PIN = '#1c7ed6';

export function initJobs({ map, open, isSheet, setSheet }: Options) {
  let settings: Settings = loadSettings();
  const fromLink = takeSetupFromUrl(settings);
  if (fromLink) {
    settings = fromLink;
    saveSettings(settings);
  }
  let repos: RepoState[] = [];
  let loadedOnce = false;
  let active = false;
  let selected: string | undefined;
  let saveTarget: { doc: JxlDocument; text: string; name: string; origin?: JobOrigin } | undefined;

  const client = (slug: string) => new GitHub(parseRepo(slug)!, settings.token);
  const key = (repo: string, f: JobFeature) => `${repo}|${f.properties.path}`;

  // ------------------------------------------------------------ loading

  async function refresh() {
    const status = $('#jobs-status');
    if (!settings.repos.length) {
      repos = [];
      status.innerHTML = 'Add a GitHub repo below to keep jobs there.';
      ($('#library-settings') as HTMLDetailsElement).open = true;
      render();
      return;
    }
    status.textContent = 'Loading jobs…';
    repos = await Promise.all(
      settings.repos.map(async (ref): Promise<RepoState> => {
        const gh = new GitHub(ref, settings.token);
        try {
          const [info, index] = await Promise.all([gh.info(), loadIndex(gh)]);
          return { ref, info, jobs: index.features };
        } catch (e) {
          return { ref, jobs: [], error: (e as Error).message };
        }
      }),
    );
    loadedOnce = true;
    renderSettings();
    const n = repos.reduce((s, r) => s + r.jobs.length, 0);
    const errors = repos.filter((r) => r.error).map((r) => `<br><span class="error-text">${esc(repoSlug(r.ref))}: ${esc(r.error!)}</span>`);
    status.innerHTML = `${n} job${n === 1 ? '' : 's'} in ${repos.length} repo${repos.length === 1 ? '' : 's'}.${errors.join('')}`;
    render();
    renderSaveRow();
    fitJobs();
  }

  // ------------------------------------------------------------ list

  function visibleJobs(): { repo: RepoState; job: JobFeature }[] {
    const q = $<HTMLInputElement>('#job-search').value.trim().toLowerCase();
    const only = $<HTMLSelectElement>('#job-repo').value;
    return repos
      .filter((r) => !only || repoSlug(r.ref) === only)
      .flatMap((repo) => repo.jobs.map((job) => ({ repo, job })))
      .filter(({ job }) => !q || job.properties.jobName.toLowerCase().includes(q))
      .sort((a, b) => b.job.properties.lastUpload.localeCompare(a.job.properties.lastUpload));
  }

  function render() {
    const select = $<HTMLSelectElement>('#job-repo');
    const current = select.value;
    select.innerHTML =
      `<option value="">All repos</option>` + settings.repos.map((r) => `<option>${esc(repoSlug(r))}</option>`).join('');
    select.value = settings.repos.some((r) => repoSlug(r) === current) ? current : '';
    select.hidden = settings.repos.length < 2;

    const rows = visibleJobs().map(({ repo, job }) => {
      const k = key(repoSlug(repo.ref), job);
      const p = job.properties;
      return `<li data-key="${esc(k)}" class="${k === selected ? 'selected' : ''}">
        <strong>${esc(p.jobName)}</strong>
        <span class="muted">${formatDate(p.lastUpload)} · ${p.pointCount} pts${repos.length > 1 ? ` · ${repoLabel(repo)}` : ''}${job.geometry ? '' : ' · no position'}</span>
      </li>`;
    });
    $('#job-list').innerHTML = rows.join('');
    renderDetail();
    (map.getSource('jobs') as GeoJSONSource | undefined)?.setData(toGeoJSON());
  }

  function repoLabel(r: RepoState) {
    return `${esc(repoSlug(r.ref))}${r.info?.private ? ' 🔒' : ''}`;
  }

  $('#job-list').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li) select(li.dataset.key!, true);
  });
  $('#job-search').addEventListener('input', render);
  $('#job-repo').addEventListener('change', () => {
    render();
    fitJobs();
  });

  function find(k: string) {
    for (const repo of repos) for (const job of repo.jobs) if (key(repoSlug(repo.ref), job) === k) return { repo, job };
    return undefined;
  }

  function select(k: string, fly: boolean) {
    selected = k;
    const hit = find(k);
    if (fly && hit?.job.geometry) {
      const bbox = hit.job.properties.bbox;
      if (bbox) map.fitBounds(bbox, { padding: isSheet() ? 30 : 60, maxZoom: 17, duration: 600 });
      else map.flyTo({ center: hit.job.geometry.coordinates as [number, number], zoom: 16 });
    }
    if (isSheet()) setSheet(false);
    setSelectedFilter();
    render();
    requestAnimationFrame(() => $('#job-detail').scrollIntoView({ block: 'nearest' }));
  }

  function renderDetail() {
    const el = $('#job-detail');
    const hit = selected ? find(selected) : undefined;
    el.hidden = !hit;
    if (!hit) return;
    const { repo, job } = hit;
    const p = job.properties;
    const slug = repoSlug(repo.ref);
    const branch = repo.info?.defaultBranch ?? 'main';
    const rows: [string, string][] = [
      ['Repo', repoLabel(repo)],
      ['Last upload', esc(formatDate(p.lastUpload, true))],
      ['First upload', esc(formatDate(p.firstUpload, true))],
      ['Uploads', String(p.uploadCount)],
      ['Points', String(p.pointCount)],
      ['Size', formatBytes(p.size)],
      ...(p.controller ? [['Controller', esc(p.controller)] as [string, string]] : []),
      ...(p.crs ? [['Coordinate system', esc(p.crs)] as [string, string]] : []),
    ];
    el.innerHTML = `
      <div class="detail-head">
        <h2>${esc(p.jobName)}</h2>
        <button class="close" title="Close">×</button>
      </div>
      <div class="actions">
        <button data-act="open" class="primary">Open</button>
        <button data-act="download">Download .jxl</button>
      </div>
      <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <details class="versions"><summary>Versions</summary><div class="versions-body muted">Loading…</div></details>
      <p><a href="https://github.com/${esc(slug)}/commits/${esc(branch)}/${esc(p.path)}" target="_blank" rel="noopener">History on GitHub</a></p>
    `;
    el.querySelector('.close')!.addEventListener('click', () => {
      selected = undefined;
      setSelectedFilter();
      render();
    });
    el.querySelector('[data-act=open]')!.addEventListener('click', () => openJob(slug, job));
    el.querySelector('[data-act=download]')!.addEventListener('click', () => downloadJob(slug, job));
    const versions = el.querySelector<HTMLDetailsElement>('.versions')!;
    versions.addEventListener('toggle', () => versions.open && loadVersions(slug, job, versions.querySelector('.versions-body')!), { once: true });
  }

  async function loadVersions(slug: string, job: JobFeature, el: HTMLElement) {
    let list: Commit[];
    try {
      list = await client(slug).commits(job.properties.path);
    } catch (e) {
      el.innerHTML = `<span class="error-text">${esc((e as Error).message)}</span>`;
      return;
    }
    el.classList.remove('muted');
    el.innerHTML = `<ul class="version-list">${list
      .map(
        (c, i) => `<li>
          <span>${esc(formatDate(c.date, true))}${i === 0 ? ' <span class="muted">latest</span>' : ''}<br><span class="muted">${esc(c.message.split('\n')[0])}</span></span>
          <span class="actions">
            <button data-sha="${c.sha}" data-act="open">Open</button>
            <button data-sha="${c.sha}" data-act="download" title="Download">⤓</button>
          </span>
        </li>`,
      )
      .join('')}</ul>`;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () =>
        b.dataset.act === 'open' ? openJob(slug, job, b.dataset.sha) : downloadJob(slug, job, b.dataset.sha),
      ),
    );
  }

  async function fetchJob(slug: string, job: JobFeature, sha?: string) {
    const text = await client(slug).readText(job.properties.path, sha);
    if (text === undefined) throw new Error(`${job.properties.path} isn't in ${slug} any more. Try reloading the list.`);
    return text;
  }

  async function openJob(slug: string, job: JobFeature, sha?: string) {
    setJobsStatus(`Opening ${esc(job.properties.jobName)}…`);
    try {
      const text = await fetchJob(slug, job, sha);
      setJobsStatus('');
      open(text, fileName(job, sha), new TextEncoder().encode(text).length, { repo: slug, path: job.properties.path, version: sha });
    } catch (e) {
      setJobsStatus(esc((e as Error).message), true);
    }
  }

  async function downloadJob(slug: string, job: JobFeature, sha?: string) {
    try {
      const text = await fetchJob(slug, job, sha);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(job, sha);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setJobsStatus(esc((e as Error).message), true);
    }
  }

  function fileName(job: JobFeature, sha?: string) {
    const base = job.properties.path.split('/').pop()!;
    return sha ? base.replace(/\.jxl$/i, `_${sha.slice(0, 7)}.jxl`) : base;
  }

  function setJobsStatus(html: string, error = false) {
    const el = $('#jobs-status');
    el.innerHTML = html;
    el.classList.toggle('error', error);
  }

  // ------------------------------------------------------------ map

  function toGeoJSON(): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: visibleJobs()
        .filter(({ job }) => job.geometry)
        .map(({ repo, job }) => ({
          type: 'Feature',
          geometry: job.geometry as Point,
          properties: { key: key(repoSlug(repo.ref), job), name: job.properties.jobName },
        })),
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

  // ------------------------------------------------------------ saving

  /** Call whenever a file is opened in the viewer. */
  function setOpenFile(target: typeof saveTarget) {
    saveTarget = target;
    renderSaveRow();
  }

  function renderSaveRow() {
    const el = $('#save-row');
    el.hidden = !saveTarget;
    if (!saveTarget) return;
    const slugs = settings.repos.map(repoSlug);
    const origin = saveTarget.origin?.repo;
    const preferred = origin && slugs.includes(origin) ? origin : slugs[0];
    const options = slugs.map((s) => `<option ${s === preferred ? 'selected' : ''}>${esc(s)}</option>`);
    el.innerHTML = `
      <div class="save-controls">
        <select id="save-repo" ${slugs.length < 2 ? 'hidden' : ''}>${options.join('')}</select>
        <button id="save-btn" class="primary">Upload to ${slugs.length === 1 ? esc(preferred) : 'GitHub'}</button>
      </div>
      <form id="connect-form" class="connect" hidden>
        <p class="small">Connect to GitHub to upload. This is only needed once on each device.</p>
        <label>Repo<input id="connect-repo" placeholder="owner/repo" value="${esc(preferred ?? '')}" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        <label>Token<input id="connect-token" type="password" placeholder="github_pat_…" autocomplete="off" /></label>
        <p class="muted small"><a href="${tokenUrl()}" target="_blank" rel="noopener">Create a token on GitHub</a>: under
          <em>Repository access</em> pick the repo, and give it <em>Contents: Read and write</em>.
          The token stays in this browser.</p>
        <div class="actions">
          <button type="submit" class="primary">Connect and upload</button>
          <button type="button" data-act="cancel">Cancel</button>
        </div>
      </form>
      <div id="save-status" class="muted"></div>`;
    el.querySelector('#save-btn')!.addEventListener('click', () => (connected() ? upload() : showConnect(true)));
    el.querySelector('[data-act=cancel]')!.addEventListener('click', () => showConnect(false));
    el.querySelector('#connect-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      connect();
    });
  }

  const connected = () => !!settings.token && settings.repos.length > 0;

  function showConnect(on: boolean) {
    $('#connect-form').hidden = !on;
    $('.save-controls').hidden = on;
    $('#save-status').textContent = '';
    if (on) ($('#connect-repo') as HTMLInputElement).focus();
  }

  /** Check the repo and token work before keeping them, then upload. */
  async function connect() {
    const status = $('#save-status');
    const ref = parseRepo($<HTMLInputElement>('#connect-repo').value);
    const token = $<HTMLInputElement>('#connect-token').value.trim() || settings.token;
    if (!ref) {
      status.innerHTML = '<span class="error-text">Enter the repo as owner/repo, for example hallahan/OFVData.</span>';
      return;
    }
    if (!token) {
      status.innerHTML = '<span class="error-text">Paste a GitHub token.</span>';
      return;
    }
    status.textContent = 'Checking access…';
    try {
      const info = await new GitHub(ref, token).info();
      if (!info.canPush) throw new Error(`This token can read ${repoSlug(ref)} but can't write to it. It needs Contents: Read and write.`);
    } catch (e) {
      status.innerHTML = `<span class="error-text">${esc((e as Error).message)}</span>`;
      return;
    }
    settings.token = token;
    if (!settings.repos.some((r) => repoSlug(r) === repoSlug(ref))) settings.repos.push(ref);
    saveSettings(settings);
    renderSettings();
    renderSaveRow();
    $<HTMLSelectElement>('#save-repo').value = repoSlug(ref);
    upload();
  }

  async function upload() {
    if (!saveTarget) return;
    const slug = $<HTMLSelectElement>('#save-repo').value;
    const btn = $<HTMLButtonElement>('#save-btn');
    const status = $('#save-status');
    btn.disabled = true;
    status.textContent = `Uploading to ${slug}…`;
    try {
      const r = await saveJob(client(slug), saveTarget.text, saveTarget.doc, saveTarget.name);
      status.innerHTML =
        r.status === 'unchanged'
          ? `Already uploaded: ${esc(slug)} has this exact file.`
          : `Uploaded to <a href="https://github.com/${esc(slug)}/commit/${r.commit}" target="_blank" rel="noopener">${esc(slug)}</a>.`;
      saveTarget.origin = { repo: slug, path: r.path };
      loadedOnce = false; // reload the list next time Jobs is shown
    } catch (e) {
      status.innerHTML = `<span class="error-text">${esc((e as Error).message)}</span>`;
      // A rejected token goes back to the connect form.
      if (e instanceof GitHubError && e.status === 401) {
        settings.token = undefined;
        saveSettings(settings);
        showConnect(true);
        $('#save-status').innerHTML = `<span class="error-text">${esc((e as Error).message)}</span>`;
      }
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ settings

  function renderSettings() {
    const body = $('#settings-body');
    const list = settings.repos
      .map((r) => {
        const state = repos.find((x) => repoSlug(x.ref) === repoSlug(r));
        const tag = state?.info ? (state.info.private ? 'private' : 'public') : state?.error ? 'error' : '';
        return `<li><span>${esc(repoSlug(r))} ${tag ? `<span class="tag ${tag}">${tag}</span>` : ''}</span><button data-remove="${esc(repoSlug(r))}" title="Remove">×</button></li>`;
      })
      .join('');
    body.innerHTML = `
      <ul class="repo-list">${list}</ul>
      <form id="add-repo" class="inline-form">
        <input id="repo-input" placeholder="owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <button type="submit">Add repo</button>
      </form>
      <p class="muted small">Public repos can be browsed without a token. Saving, and private repos, need a
        <a href="${tokenUrl()}" target="_blank" rel="noopener">fine-grained token</a>
        with access to those repos and <em>Contents: Read and write</em>. It's kept in this browser only.</p>
      <form id="token-form" class="inline-form">
        <input id="token-input" type="password" placeholder="${settings.token ? 'Token saved. Paste to replace' : 'github_pat_…'}" autocomplete="off" />
        <button type="submit">Save</button>
      </form>
      ${settings.token ? '<button class="link" id="forget-token">Forget token</button>' : ''}
      ${
        settings.repos.length
          ? `<div class="setup-link">
              <p class="muted small">Set up another device, like the controller, with the same repos: open this link there.</p>
              <label class="check"><input type="checkbox" id="link-token" /><span>Include the token (only send the link somewhere private)</span></label>
              <button id="copy-link">Copy setup link</button> <span id="copy-status" class="muted"></span>
            </div>`
          : ''
      }`;
    body.querySelector('#add-repo')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('#repo-input');
      const ref = parseRepo(input.value);
      if (!ref) {
        input.setCustomValidity('Enter owner/repo, for example hallahan/fieldview-data');
        input.reportValidity();
        return;
      }
      if (!settings.repos.some((r) => repoSlug(r) === repoSlug(ref))) settings.repos.push(ref);
      update();
    });
    body.querySelector('#repo-input')!.addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity(''));
    body.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        settings.repos = settings.repos.filter((r) => repoSlug(r) !== b.dataset.remove);
        update();
      }),
    );
    body.querySelector('#token-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = $<HTMLInputElement>('#token-input').value.trim();
      if (token) {
        settings.token = token;
        update();
      }
    });
    body.querySelector('#forget-token')?.addEventListener('click', () => {
      settings.token = undefined;
      update();
    });
    body.querySelector('#copy-link')?.addEventListener('click', async () => {
      const link = setupLink(settings, $<HTMLInputElement>('#link-token').checked);
      try {
        await navigator.clipboard.writeText(link);
        $('#copy-status').textContent = 'Copied.';
      } catch {
        prompt('Copy this link', link);
      }
    });
  }

  function update() {
    saveSettings(settings);
    renderSettings();
    renderSaveRow();
    refresh();
  }

  // ------------------------------------------------------------ views

  function showView(view: 'viewer' | 'jobs') {
    document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('#view-viewer').hidden = view !== 'viewer';
    $('#view-jobs').hidden = view !== 'jobs';
    $('#sidebar').scrollTop = 0;
    for (const id of ['points-circle', 'points-selected', 'points-label']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', view === 'viewer' ? 'visible' : 'none');
    }
    show(view === 'jobs');
  }
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view as 'viewer' | 'jobs')),
  );

  renderSettings();
  // A setup link means the person wants to see their jobs.
  if (fromLink) showView('jobs');

  return { addLayers, handleClick, setOpenFile, showView, isActive: () => active };
}

/** GitHub's new-token page, pre-filled where GitHub supports it. */
function tokenUrl() {
  const q = new URLSearchParams({ name: 'FieldView', description: 'Upload JXL jobs from FieldView', contents: 'write' });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

function formatDate(iso: string, time = false) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
