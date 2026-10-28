// The Jobs view: jobs saved in GitHub repos as a list and as pins on the map,
// plus uploading the open file and the GitHub sign-in and repo choices.

import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import {
  beginSignIn,
  chooseReposUrl,
  completeRedirect,
  currentSession,
  getToken,
  listRepos,
  signInAvailable,
  SignInExpired,
  signOut,
  type PickableRepo,
} from './auth';
import { GitHub, GitHubError, parseRepo, type Commit, type RepoInfo, type RepoRef } from './github';
import type { JxlDocument } from './jxl';
import { loadIndex, saveJob, type JobFeature, type SaveResult } from './library';
import type { Placement } from './placement';
import { addRepo, loadSettings, repoSlug, sameRepo, saveSettings, type Settings } from './settings';
import {
  createLink,
  describeAccess,
  describeExpiry,
  listLinks,
  revokeLink,
  shareFromLocation,
  sharingAvailable,
  ShareClient,
  ShareError,
  shareUrl,
  type SharedRepo,
  type ShareLink,
} from './share';
import { stash, takeStash, type Stash } from './stash';
import { esc, formatBytes } from './util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Where an open file came from, so saving it again defaults to the same repo. */
export interface JobOrigin {
  repo: string;
  path: string;
  /** Commit the file was read at, when it's an older version. */
  version?: string;
  /** Where the job was placed on the map by hand, from the repo's index. */
  placement?: Placement;
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
  /** Whether the viewer's linework toggle is on. */
  showLines: () => boolean;
  /** After switching between the viewer and the Jobs map. */
  viewChanged: () => void;
}

const PIN = '#1c7ed6';

export function initJobs({ map, open, isSheet, setSheet, showLines, viewChanged }: Options) {
  const settings: Settings = loadSettings();
  let repos: RepoState[] = [];
  let loadedOnce = false;
  let active = false;
  let selected: string | undefined;
  let saveTarget: { doc: JxlDocument; text: string; name: string; origin?: JobOrigin } | undefined;
  let savePickerOpen = false;
  let settingsPickerOpen = false;

  // Opened from a share link: only that repo's jobs, read through the link.
  const shareSecret = shareFromLocation();
  const shareClient = shareSecret ? new ShareClient(shareSecret) : undefined;
  let shared: SharedRepo | undefined;
  const isShared = (slug: string) => !!shared && sameRepo(slug, shared.repo);
  const client = (slug: string): Pick<GitHub, 'readText' | 'commits'> =>
    isShared(slug) ? shareClient! : new GitHub(parseRepo(slug)!, getToken);
  /** The repos in the list: the shared one, or the ones picked in settings. */
  const listedRepos = () => (shareClient ? repos.map((r) => r.ref) : settings.repos);
  let sharePanel: { repo: string; job?: JobFeature; links?: ShareLink[]; error?: string; created?: string } | undefined;
  const key = (repo: string, f: JobFeature) => `${repo}|${f.properties.path}`;

  // ------------------------------------------------------------ loading

  async function refresh() {
    if (shareClient) return refreshShared();
    const status = $('#jobs-status');
    if (!settings.repos.length) {
      repos = [];
      status.innerHTML = currentSession() ? 'Pick a repo below to see its jobs.' : 'Sign in with GitHub below to see your jobs.';
      ($('#library-settings') as HTMLDetailsElement).open = true;
      if (currentSession() && !settingsPickerOpen) {
        settingsPickerOpen = true;
        renderSettings();
      }
      render();
      return;
    }
    status.textContent = 'Loading jobs…';
    repos = await Promise.all(
      settings.repos.map(async (ref): Promise<RepoState> => {
        const gh = new GitHub(ref, getToken);
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

  async function refreshShared() {
    setJobsStatus('Opening the shared jobs…');
    try {
      shared = await shareClient!.open();
    } catch (e) {
      shared = undefined;
      repos = [];
      renderBanner((e as Error).message);
      setJobsStatus('');
      render();
      renderSaveRow();
      return;
    }
    const s = shared;
    repos = [{ ref: parseRepo(s.repo)!, info: { private: s.private, defaultBranch: s.defaultBranch, canPush: s.upload, empty: false }, jobs: s.index.features }];
    loadedOnce = true;
    renderBanner();
    const n = s.index.features.length;
    setJobsStatus(s.job ? '' : n ? `${n} job${n === 1 ? '' : 's'}. Tap one to download it.` : 'No jobs here yet.');
    render();
    renderSaveRow();
    if (s.job) {
      const job = s.index.features[0];
      if (job) openJob(s.repo, job);
      else setJobsStatus("That job isn't in the repo any more.", true);
    } else {
      fitJobs();
    }
  }

  function renderBanner(error?: string) {
    const el = $('#share-banner');
    el.hidden = false;
    el.classList.toggle('error', !!error);
    if (error) {
      el.innerHTML = `<strong>This link doesn't work.</strong><br>${esc(error)}`;
      return;
    }
    const s = shared!;
    const job = s.job ? s.index.features[0] : undefined;
    const what = s.job ? `the job <strong>${esc(s.index.features[0]?.properties.jobName ?? s.job)}</strong>` : `the jobs in <strong>${esc(s.repo.split('/')[1])}</strong>`;
    el.innerHTML = `<p><span class="share-label">Shared link</span> <strong>${esc(s.createdBy)}</strong> shared ${what} with you.</p>
      <p class="muted small">You can ${describeAccess(s)}. No sign-in needed. This link works ${describeExpiry(s)}.</p>
      ${job ? `<div class="actions"><button class="primary" data-act="download">Download ${esc(job.properties.path.split('/').pop()!)}</button></div>` : ''}`;
    // A link to one job: the download is the point, so it's right at the top.
    if (job) el.querySelector('[data-act=download]')!.addEventListener('click', () => downloadJob(s.repo, job));
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
      `<option value="">All repos</option>` + listedRepos().map((r) => `<option>${esc(repoSlug(r))}</option>`).join('');
    select.value = listedRepos().some((r) => repoSlug(r) === current) ? current : '';
    select.hidden = listedRepos().length < 2;

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
        ${
          isShared(slug)
            ? `<button data-act="download" class="primary">Download .${esc(ext(job))}</button><button data-act="open">Open</button>`
            : `<button data-act="open" class="primary">Open</button><button data-act="download">Download .${esc(ext(job))}</button>`
        }
        ${!shareClient && currentSession() && sharingAvailable() ? '<button data-act="share">Share</button>' : ''}
      </div>
      <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <details class="versions"><summary>Versions</summary><div class="versions-body muted">Loading…</div></details>
      ${
        // Someone using a link may have no GitHub account, and can't see a private repo there.
        isShared(slug) && repo.info?.private
          ? ''
          : `<p><a href="https://github.com/${esc(slug)}/commits/${esc(branch)}/${esc(p.path)}" target="_blank" rel="noopener">History on GitHub</a></p>`
      }
    `;
    el.querySelector('.close')!.addEventListener('click', () => {
      selected = undefined;
      setSelectedFilter();
      render();
    });
    el.querySelector('[data-act=open]')!.addEventListener('click', () => openJob(slug, job));
    el.querySelector('[data-act=download]')!.addEventListener('click', () => downloadJob(slug, job));
    el.querySelector('[data-act=share]')?.addEventListener('click', () => openSharePanel(slug, job));
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
      open(text, fileName(job, sha), new TextEncoder().encode(text).length, {
        repo: slug,
        path: job.properties.path,
        version: sha,
        placement: job.properties.placement,
      });
    } catch (e) {
      setJobsStatus(esc((e as Error).message), true);
    }
  }

  async function downloadJob(slug: string, job: JobFeature, sha?: string) {
    try {
      saveFile(await fetchJob(slug, job, sha), fileName(job, sha));
    } catch (e) {
      setJobsStatus(esc((e as Error).message), true);
    }
  }

  const ext = (job: JobFeature) => job.properties.path.split('.').pop() ?? 'jxl';

  function fileName(job: JobFeature, sha?: string) {
    const base = job.properties.path.split('/').pop()!;
    return sha ? base.replace(/\.(jxl|rw5)$/i, (ext) => `_${sha.slice(0, 7)}${ext}`) : base;
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
    savePickerOpen = false;
    renderSaveRow();
  }

  /** The repo the open file came from, else the one picked last time. */
  const uploadTarget = () => (shareClient ? shared?.repo : (saveTarget?.origin?.repo ?? settings.uploadRepo));

  function renderSaveRow() {
    const el = $('#save-row');
    el.hidden = !saveTarget;
    if (!saveTarget) return;
    if (shareClient) return renderSharedSaveRow(el);
    const session = currentSession();
    if (!session) {
      el.innerHTML = signInAvailable()
        ? `<button id="signin-btn" class="primary github">${GITHUB_MARK} Sign in with GitHub to upload</button><div id="save-status" class="muted"></div>`
        : `<p class="muted small">Uploading needs GitHub sign-in, which isn't set up on this site yet.</p><div id="save-status" class="muted"></div>`;
      el.querySelector('#signin-btn')?.addEventListener('click', () => signIn('upload'));
      return;
    }
    const target = uploadTarget();
    const picking = savePickerOpen || !target;
    el.innerHTML = `
      <div class="save-controls" ${picking ? 'hidden' : ''}>
        <button id="save-btn" class="primary" title="Upload to ${esc(target ?? '')}">Upload to ${esc(target?.split('/')[1] ?? '')}</button>
        <button id="change-repo">Change</button>
      </div>
      <div id="save-picker" ${picking ? '' : 'hidden'}></div>
      <div id="save-status" class="muted"></div>`;
    el.querySelector('#save-btn')!.addEventListener('click', () => upload(target!));
    el.querySelector('#change-repo')!.addEventListener('click', () => {
      savePickerOpen = true;
      renderSaveRow();
    });
    if (picking) {
      renderPicker($('#save-picker'), {
        title: 'Pick the repo to upload to',
        forUpload: true,
        then: 'upload',
        onPick: (slug) => {
          settings.uploadRepo = slug;
          addRepo(settings, slug);
          saveSettings(settings);
          savePickerOpen = false;
          renderSettings();
          renderSaveRow();
          upload(slug);
        },
        onCancel: target
          ? () => {
              savePickerOpen = false;
              renderSaveRow();
            }
          : undefined,
      });
    }
  }

  /** Through a share link: download what's open, and upload if the link allows it. */
  function renderSharedSaveRow(el: HTMLElement) {
    const t = saveTarget!;
    const fromLink = !!t.origin && isShared(t.origin.repo);
    const canUpload = !!shared?.upload;
    el.innerHTML = `
      ${fromLink && !shared?.job ? `<div class="actions"><button id="download-open" class="primary">Download ${esc(t.name)}</button></div>` : ''}
      ${
        canUpload
          ? `<div class="share-upload">
              <label for="uploader">Your name <span class="muted">(optional, saved with the upload)</span></label>
              <input id="uploader" maxlength="60" autocomplete="name" value="${esc(readUploader())}" />
              <button id="save-btn" class="${fromLink ? '' : 'primary'}">Upload to ${esc(shared!.repo.split('/')[1])}</button>
            </div>`
          : !fromLink && shared
            ? '<p class="muted small">This link is for viewing only, so files opened here stay on this device.</p>'
            : ''
      }
      <div id="save-status" class="muted"></div>`;
    el.hidden = !fromLink && !shared;
    el.querySelector('#download-open')?.addEventListener('click', () => saveFile(t.text, t.name));
    el.querySelector('#uploader')?.addEventListener('change', (e) => writeUploader((e.target as HTMLInputElement).value));
    el.querySelector('#save-btn')?.addEventListener('click', () => upload(shared!.repo));
  }

  async function upload(slug: string) {
    if (!saveTarget) return;
    const btn = $<HTMLButtonElement>('#save-btn');
    const status = $('#save-status');
    btn.disabled = true;
    status.textContent = `Uploading to ${slug}…`;
    try {
      let r: SaveResult;
      if (isShared(slug)) {
        const by = document.querySelector<HTMLInputElement>('#uploader')?.value.trim() ?? '';
        writeUploader(by);
        r = await shareClient!.upload(saveTarget.text, saveTarget.doc, saveTarget.name, by);
      } else {
        r = await saveJob(new GitHub(parseRepo(slug)!, getToken), saveTarget.text, saveTarget.doc, saveTarget.name);
      }
      // Someone using a link may not be able to open a private repo on GitHub.
      const where = isShared(slug) && shared?.private ? esc(slug) : `<a href="https://github.com/${esc(slug)}/commit/${r.status === 'saved' ? r.commit : ''}" target="_blank" rel="noopener">${esc(slug)}</a>`;
      status.innerHTML = r.status === 'unchanged' ? `Already uploaded: ${esc(slug)} has this exact file.` : `Uploaded to ${where}.`;
      saveTarget.origin = { repo: slug, path: r.path };
      loadedOnce = false; // reload the list next time Jobs is shown
    } catch (e) {
      const message = (e as Error).message;
      if (expired(e)) {
        renderSaveRow();
        renderSettings();
      }
      $('#save-status').innerHTML = `<span class="error-text">${esc(message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  /** True when the error means the sign-in is gone, after signing out. */
  function expired(e: unknown) {
    if (e instanceof SignInExpired || (e instanceof GitHubError && e.status === 401)) {
      signOut();
      pickable = undefined;
      return true;
    }
    return false;
  }

  async function signIn(then: Stash['then']) {
    await stash({ then, file: saveTarget && { text: saveTarget.text, name: saveTarget.name, origin: saveTarget.origin } });
    await beginSignIn();
  }

  // ------------------------------------------------------------ repo picker

  let pickable: Promise<PickableRepo[]> | undefined;

  function renderPicker(
    el: HTMLElement,
    opts: { title: string; forUpload: boolean; then: Stash['then']; onPick: (slug: string) => void; onCancel?: () => void },
  ) {
    el.className = 'picker';
    el.innerHTML = `<p class="picker-title">${esc(opts.title)}</p><p class="muted small">Loading your repos…</p>`;
    pickable ??= listRepos();
    pickable.then(
      (list) => {
        const rows = list.map((r) => {
          const shown = settings.repos.some((x) => sameRepo(repoSlug(x), r.slug));
          const disabled = opts.forUpload ? !r.canPush : shown;
          const note = opts.forUpload ? (r.canPush ? '' : 'read only') : shown ? 'added' : '';
          return `<li><button data-slug="${esc(r.slug)}" ${disabled ? 'disabled' : ''}>
            <span class="repo-name"><span class="muted">${esc(r.owner)}/</span>${esc(r.name)}</span>
            <span class="tag ${r.private ? 'private' : ''}">${r.private ? 'private' : 'public'}</span>${note ? `<span class="muted small">${note}</span>` : ''}
          </button></li>`;
        });
        el.innerHTML = `
          <p class="picker-title">${esc(opts.title)}</p>
          ${
            list.length
              ? `<ul class="picker-list">${rows.join('')}</ul>
                 <p class="muted small">Repo not listed? <button class="link" data-act="choose">Give OpenFieldView access to it on GitHub</button></p>`
              : `<p class="small">OpenFieldView can't see any of your repos yet. Choose which ones it may use on GitHub, then come back here.</p>
                 <button class="primary github" data-act="choose">${GITHUB_MARK} Choose repos on GitHub</button>`
          }
          ${opts.onCancel ? '<div class="actions"><button data-act="cancel">Cancel</button></div>' : ''}`;
        el.querySelectorAll<HTMLButtonElement>('[data-slug]').forEach((b) => b.addEventListener('click', () => opts.onPick(b.dataset.slug!)));
        el.querySelector('[data-act=choose]')!.addEventListener('click', () => chooseRepos(opts.then));
        el.querySelector('[data-act=cancel]')?.addEventListener('click', () => opts.onCancel!());
      },
      (e) => {
        pickable = undefined;
        const gone = expired(e);
        el.innerHTML = `<p class="error-text small">${esc((e as Error).message)}</p>
          <div class="actions"><button data-act="retry">${gone ? 'Sign in again' : 'Try again'}</button></div>`;
        el.querySelector('[data-act=retry]')!.addEventListener('click', () => (gone ? signIn(opts.then) : renderPicker(el, opts)));
      },
    );
  }

  async function chooseRepos(then: Stash['then']) {
    await stash({ then, file: saveTarget && { text: saveTarget.text, name: saveTarget.name, origin: saveTarget.origin } });
    location.assign(chooseReposUrl());
  }

  // ------------------------------------------------------------ settings

  function renderSettings() {
    const body = $('#settings-body');
    const session = currentSession();
    const list = settings.repos
      .map((r) => {
        const state = repos.find((x) => repoSlug(x.ref) === repoSlug(r));
        const tag = state?.info ? (state.info.private ? 'private' : 'public') : state?.error ? 'error' : '';
        const share = session && sharingAvailable() ? `<button class="link" data-share="${esc(repoSlug(r))}">Share</button>` : '';
        return `<li><span>${esc(repoSlug(r))} ${tag ? `<span class="tag ${tag}">${tag}</span>` : ''}</span><span class="row-actions">${share}<button data-remove="${esc(repoSlug(r))}" title="Remove from this list">×</button></span></li>`;
      })
      .join('');
    const account = session
      ? `<div class="account">
          ${session.avatar ? `<img src="${esc(session.avatar)}&s=48" alt="" width="24" height="24" />` : ''}
          <span>Signed in as <strong>${esc(session.login)}</strong></span>
          <button class="link" id="sign-out">Sign out</button>
        </div>`
      : signInAvailable()
        ? `<button id="signin-jobs" class="primary github">${GITHUB_MARK} Sign in with GitHub</button>`
        : `<p class="muted small">GitHub sign-in isn't set up on this site yet.</p>`;
    body.innerHTML = `
      ${account}
      ${list ? `<ul class="repo-list">${list}</ul>` : ''}
      ${session ? (settingsPickerOpen ? '<div id="settings-picker"></div>' : '<div><button id="add-repo-btn">Add a repo</button></div>') : ''}
      ${!session && list ? '<p class="muted small">Public repos can be browsed signed out. Sign in for private repos and uploading.</p>' : ''}`;
    body.querySelector('#signin-jobs')?.addEventListener('click', () => signIn('jobs'));
    body.querySelector('#sign-out')?.addEventListener('click', () => {
      signOut();
      pickable = undefined;
      settingsPickerOpen = false;
      renderSettings();
      renderSaveRow();
    });
    body.querySelector('#add-repo-btn')?.addEventListener('click', () => {
      settingsPickerOpen = true;
      renderSettings();
    });
    const pickerEl = body.querySelector<HTMLElement>('#settings-picker');
    if (pickerEl) {
      renderPicker(pickerEl, {
        title: 'Pick a repo to show its jobs',
        forUpload: false,
        then: 'jobs',
        onPick: (slug) => {
          addRepo(settings, slug);
          settingsPickerOpen = false;
          update();
        },
        onCancel: settings.repos.length
          ? () => {
              settingsPickerOpen = false;
              renderSettings();
            }
          : undefined,
      });
    }
    body.querySelectorAll<HTMLButtonElement>('[data-share]').forEach((b) => b.addEventListener('click', () => openSharePanel(b.dataset.share!)));
    body.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        settings.repos = settings.repos.filter((r) => repoSlug(r) !== b.dataset.remove);
        update();
      }),
    );
  }

  function update() {
    saveSettings(settings);
    renderSettings();
    renderSaveRow();
    refresh();
  }

  // ------------------------------------------------------------ share links (repo admins)

  function openSharePanel(repo: string, job?: JobFeature) {
    sharePanel = { repo, job };
    renderSharePanel();
    loadLinks();
    requestAnimationFrame(() => $('#share-panel').scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  async function loadLinks() {
    const panel = sharePanel;
    if (!panel) return;
    try {
      const links = await listLinks(panel.repo);
      panel.links = panel.job ? links.filter((l) => l.job === panel.job!.properties.path) : links;
      panel.error = undefined;
    } catch (e) {
      panel.error = shareMessage(e);
    }
    if (panel === sharePanel) renderSharePanel();
  }

  function shareMessage(e: unknown) {
    if (e instanceof ShareError && e.code === 'sign_in') {
      signOut();
      pickable = undefined;
      renderSettings();
    }
    return (e as Error).message;
  }

  function renderSharePanel() {
    const el = $('#share-panel');
    el.hidden = !sharePanel;
    if (!sharePanel) return;
    const { repo, job, links, error, created } = sharePanel;
    const name = job ? job.properties.jobName : repo.split('/')[1];
    const list = links?.length
      ? `<ul class="share-links">${links
          .map((l) => {
            const url = shareUrl(l.secret ?? '');
            return `<li class="${l.id === created ? 'new' : ''}" data-id="${l.id}">
              <div><strong>${esc(l.label)}</strong>${l.id === created ? ' <span class="tag public">new</span>' : ''}<br>
                <span class="muted small">${l.job && !job ? `One job: ${esc(l.job.split('/')[1])} · ` : ''}${describeAccess(l)} · ${describeExpiry(l)}</span></div>
              <input readonly value="${esc(url)}" aria-label="Link" />
              <div class="actions">
                <button data-act="copy" class="${l.id === created ? 'primary' : ''}">Copy link</button>
                ${'share' in navigator ? '<button data-act="send">Send…</button>' : ''}
                <button data-act="revoke" class="danger">Turn off</button>
              </div>
            </li>`;
          })
          .join('')}</ul>`
      : links
        ? `<p class="muted small">No links yet.</p>`
        : '';
    el.innerHTML = `
      <div class="detail-head">
        <h2>Share ${esc(name)}</h2>
        <button class="close" title="Close">×</button>
      </div>
      <p class="small">${
        job
          ? `Anyone with the link can see this one job on the map and download it. They don't need a GitHub account.`
          : `Anyone with a link can see every job in <strong>${esc(repo)}</strong> on the map and download it, and upload jobs if you allow it. They don't need a GitHub account.`
      }</p>
      <form class="share-form">
        <label>Name <input name="label" maxlength="60" placeholder="${job ? esc(name) : 'Crew'}" autocomplete="off" /></label>
        ${
          job
            ? ''
            : `<div class="segmented share-access" role="radiogroup">
                <label><input type="radio" name="access" value="view" checked /><span>View and download</span></label>
                <label><input type="radio" name="access" value="upload" /><span>Also upload</span></label>
              </div>`
        }
        <label>Stops working
          <select name="expires">
            <option value="1">in 1 day</option>
            <option value="7">in a week</option>
            <option value="30" selected>in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="">never</option>
          </select>
        </label>
        <button type="submit" class="primary">Create link</button>
      </form>
      <div id="share-status" class="small ${error ? 'error-text' : 'muted'}">${error ? esc(error) : links ? '' : 'Loading links…'}</div>
      ${list}`;
    el.querySelector('.close')!.addEventListener('click', () => {
      sharePanel = undefined;
      renderSharePanel();
    });
    const form = el.querySelector<HTMLFormElement>('.share-form')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const btn = form.querySelector<HTMLButtonElement>('[type=submit]')!;
      btn.disabled = true;
      $('#share-status').textContent = 'Creating link…';
      try {
        const link = await createLink({
          repo,
          label: String(data.get('label') ?? '').trim(),
          upload: data.get('access') === 'upload',
          job: job?.properties.path,
          expiresInDays: data.get('expires') ? Number(data.get('expires')) : undefined,
        });
        if (sharePanel?.repo !== repo) return;
        sharePanel.links = [link, ...(sharePanel.links ?? [])];
        sharePanel.created = link.id;
        sharePanel.error = undefined;
        renderSharePanel();
      } catch (err) {
        btn.disabled = false;
        $('#share-status').innerHTML = `<span class="error-text">${esc(shareMessage(err))}</span>`;
      }
    });
    el.querySelectorAll<HTMLLIElement>('.share-links li').forEach((li) => {
      const link = links!.find((l) => l.id === li.dataset.id)!;
      const url = li.querySelector('input')!.value;
      li.querySelector('input')!.addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
      li.querySelector('[data-act=copy]')!.addEventListener('click', async (e) => {
        const b = e.target as HTMLButtonElement;
        b.textContent = (await copyText(url, li.querySelector('input')!)) ? 'Copied' : 'Select and copy above';
        setTimeout(() => (b.textContent = 'Copy link'), 2000);
      });
      li.querySelector('[data-act=send]')?.addEventListener('click', () =>
        navigator.share({ title: `OpenFieldView: ${link.label}`, url }).catch(() => undefined),
      );
      li.querySelector('[data-act=revoke]')!.addEventListener('click', async () => {
        if (!confirm(`Turn off "${link.label}"? Anyone using it loses access straight away.`)) return;
        try {
          await revokeLink(link.id);
          if (sharePanel) sharePanel.links = sharePanel.links?.filter((l) => l.id !== link.id);
          renderSharePanel();
        } catch (err) {
          $('#share-status').innerHTML = `<span class="error-text">${esc(shareMessage(err))}</span>`;
        }
      });
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

  renderSettings();
  if (shareClient) {
    // Only what the link gives: no GitHub account or repo settings.
    $('#library-settings').hidden = true;
    // Once the viewer has finished setting up.
    queueMicrotask(() => showView('jobs'));
    // Pasting another link into the address bar doesn't reload the page on its own.
    window.addEventListener('hashchange', () => shareFromLocation() !== shareSecret && location.reload());
  }
  resumeAfterGitHub();

  /** Pick up where the person left off before going to GitHub to sign in or choose repos. */
  async function resumeAfterGitHub() {
    let result: Awaited<ReturnType<typeof completeRedirect>>;
    let error = '';
    try {
      result = await completeRedirect();
    } catch (e) {
      error = (e as Error).message;
    }
    if (!result && !error) return;
    pickable = undefined;
    const before = await takeStash();
    if (before?.file) {
      const { text, name, origin } = before.file;
      open(text, name, new TextEncoder().encode(text).length, origin as JobOrigin);
    }
    if (before?.then === 'jobs' || (!before?.file && !saveTarget)) {
      showView('jobs');
      if (result && !settings.repos.length) settingsPickerOpen = true;
      ($('#library-settings') as HTMLDetailsElement).open = true;
      renderSettings();
      if (error) setJobsStatus(esc(error), true);
    } else {
      // Back from choosing repos: show the fresh list straight away.
      savePickerOpen = result === 'repos-changed';
      renderSaveRow();
      if (error) $('#save-status').innerHTML = `<span class="error-text">${esc(error)}</span>`;
    }
  }

  return { addLayers, handleClick, setOpenFile, showView, isActive: () => active };
}

/** Hand the browser a file to save. */
function saveFile(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: /\.rw5$/i.test(name) ? 'text/plain' : 'application/xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string, input: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Android WebViews: fall back to selecting it.
    input.focus();
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

const UPLOADER = 'openfieldview.uploader';

function readUploader() {
  try {
    return localStorage.getItem(UPLOADER) ?? '';
  } catch {
    return '';
  }
}

function writeUploader(name: string) {
  try {
    localStorage.setItem(UPLOADER, name.trim());
  } catch {
    // Private mode.
  }
}

function formatDate(iso: string, time = false) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

const GITHUB_MARK =
  '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
