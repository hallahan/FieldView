// Which repos hold jobs, and the GitHub token, kept in this browser only.

import { parseRepo, type RepoRef } from './github';

export interface Settings {
  repos: RepoRef[];
  token?: string;
}

const KEY = 'fieldview.library';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { repos: Array.isArray(s.repos) ? s.repos.filter((r) => r?.owner && r?.name) : [], token: s.token || undefined };
  } catch {
    return { repos: [] };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode: settings last until the tab closes.
  }
}

export const repoSlug = (r: RepoRef) => `${r.owner}/${r.name}`;

/**
 * A link that sets up another device (say the controller) with the same
 * repos and token. The settings go in the #fragment, which browsers never
 * send to the server.
 */
export function setupLink(s: Settings, includeToken: boolean): string {
  const payload = { repos: s.repos.map(repoSlug), ...(includeToken && s.token && { token: s.token }) };
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#setup=${b64}`;
}

/** Read and remove a #setup= fragment. Returns the settings it carried, merged into `current`. */
export function takeSetupFromUrl(current: Settings): Settings | undefined {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
  if (!m) return undefined;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const json = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))) as { repos?: string[]; token?: string };
    const repos = [...current.repos];
    for (const slug of json.repos ?? []) {
      const r = parseRepo(slug);
      if (r && !repos.some((x) => repoSlug(x) === repoSlug(r))) repos.push(r);
    }
    return { repos, token: json.token || current.token };
  } catch {
    return undefined;
  }
}
