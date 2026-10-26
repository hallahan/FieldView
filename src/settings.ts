// Which repos the Jobs tab shows and where uploads go, kept in this browser.
// The GitHub sign-in itself is in auth.ts.

import { parseRepo, type RepoRef } from './github';

export interface Settings {
  repos: RepoRef[];
  /** owner/name uploads go to, picked once and remembered. */
  uploadRepo?: string;
}

const KEY = 'openfieldview.library';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const repos = Array.isArray(s.repos) ? s.repos.filter((r) => r?.owner && r?.name) : [];
    const uploadRepo = typeof s.uploadRepo === 'string' && parseRepo(s.uploadRepo) ? s.uploadRepo : undefined;
    // Older versions also kept a pasted token here; sign-in replaces it.
    return { repos, uploadRepo };
  } catch {
    return { repos: [] };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ repos: s.repos, uploadRepo: s.uploadRepo }));
  } catch {
    // Private mode: settings last until the tab closes.
  }
}

export const repoSlug = (r: RepoRef) => `${r.owner}/${r.name}`;

export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Add a repo to the Jobs list if it isn't there. */
export function addRepo(s: Settings, slug: string) {
  const ref = parseRepo(slug);
  if (ref && !s.repos.some((r) => sameRepo(repoSlug(r), slug))) s.repos.push(ref);
}
