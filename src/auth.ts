// "Sign in with GitHub" through the OpenFieldView GitHub App.
//
// The browser goes to GitHub to approve, comes back with a one-time code,
// and the sign-in worker (worker/auth.js) swaps that for a token, since that
// step needs the app's secret. The token is kept in this browser and only
// reaches the repos the person chose when they installed the app.

import { AUTH_URL, DEFAULT_REPO, GITHUB_APP_SLUG, GITHUB_CLIENT_ID } from './config';

export interface Session {
  token: string;
  /** Epoch ms. GitHub App tokens last 8 hours unless the app turns expiry off. */
  expiresAt?: number;
  refreshToken?: string;
  login: string;
  avatar?: string;
}

export interface PickableRepo {
  owner: string;
  name: string;
  slug: string;
  private: boolean;
  canPush: boolean;
}

const KEY = 'openfieldview.auth';
const PENDING = 'openfieldview.auth.pending';
const API = 'https://api.github.com';

export const signInAvailable = () => !!(GITHUB_CLIENT_ID && AUTH_URL);

/** GitHub's page for choosing which repos the app can use (it shows "Configure" when already installed). */
export const chooseReposUrl = () => `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

let session: Session | undefined = load();

export const currentSession = () => session;

function load(): Session | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
    return s?.token && s.login ? s : undefined;
  } catch {
    return undefined;
  }
}

function store(s: Session | undefined) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: signed in until the tab closes.
  }
}

export function signOut() {
  store(undefined);
}

const redirectUri = () => `${location.origin}${location.pathname}`;

/** Leave for GitHub's sign-in page. Comes back to this page with ?code=. */
export async function beginSignIn() {
  const state = randomString();
  const verifier = randomString() + randomString();
  sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier }));
  const q = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri(),
    state,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: 'S256',
  });
  location.assign(`https://github.com/login/oauth/authorize?${q}`);
}

/**
 * Finish a sign-in if this page load is GitHub sending the person back.
 * Returns 'signed-in', 'repos-changed' (back from choosing repos on GitHub),
 * or undefined for an ordinary page load. Throws if the sign-in failed.
 */
export async function completeRedirect(): Promise<'signed-in' | 'repos-changed' | undefined> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const setup = params.get('setup_action');
  const state = params.get('state');
  const error = params.get('error_description') ?? params.get('error');
  if (!code && !setup && !error) return undefined;
  for (const k of ['code', 'state', 'setup_action', 'installation_id', 'error', 'error_description', 'error_uri']) params.delete(k);
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);

  if (!code) {
    if (setup) return 'repos-changed';
    throw new Error(error ?? 'GitHub sign-in was cancelled.');
  }
  let pending: { state: string; verifier: string } | undefined;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') ?? undefined;
  } catch {
    // Fall through to the error below.
  }
  sessionStorage.removeItem(PENDING);
  // Only take a code this tab asked for.
  if (!pending || state !== pending.state) throw new Error('That sign-in link was stale. Tap Sign in again.');
  const tokens = await exchange({ code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
  const user = await fetch(`${API}/user`, { headers: apiHeaders(tokens.access_token) });
  if (!user.ok) throw new Error(`GitHub didn't accept the new sign-in (${user.status}).`);
  const u = (await user.json()) as { login: string; avatar_url?: string };
  store({ ...toSession(tokens), login: u.login, avatar: u.avatar_url });
  return setup ? 'repos-changed' : 'signed-in';
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(AUTH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the sign-in service. Check the connection and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`GitHub sign-in failed: ${json.error_description ?? json.error ?? `error ${res.status}`}.`);
  }
  return json as TokenResponse;
}

function toSession(t: TokenResponse): Pick<Session, 'token' | 'expiresAt' | 'refreshToken'> {
  return { token: t.access_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, refreshToken: t.refresh_token };
}

/** A working token, refreshed if it's about to expire, or undefined when signed out. */
export async function getToken(): Promise<string | undefined> {
  if (!session) return undefined;
  if (session.expiresAt && Date.now() > session.expiresAt - 5 * 60_000) {
    if (!session.refreshToken) {
      signOut();
      return undefined;
    }
    try {
      const t = await exchange({ refresh_token: session.refreshToken });
      store({ ...session, ...toSession(t) });
    } catch (e) {
      // The refresh token lasts six months; past that, sign in again.
      signOut();
      throw new SignInExpired((e as Error).message);
    }
  }
  return session.token;
}

export class SignInExpired extends Error {}

/** Repos the person gave the app access to, the default data repo first. */
export async function listRepos(): Promise<PickableRepo[]> {
  const token = await getToken();
  if (!token) throw new SignInExpired('Sign in with GitHub first.');
  const installs = await getJson<{ installations: { id: number }[] }>('/user/installations?per_page=100', token);
  const all: PickableRepo[] = [];
  for (const inst of installs.installations) {
    for (let page = 1; ; page++) {
      const r = await getJson<{ repositories: { full_name: string; private: boolean; permissions?: { push?: boolean } }[] }>(
        `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
        token,
      );
      for (const repo of r.repositories) {
        const [owner, name] = repo.full_name.split('/');
        if (!all.some((x) => x.slug === repo.full_name)) {
          all.push({ owner, name, slug: repo.full_name, private: repo.private, canPush: !!repo.permissions?.push });
        }
      }
      if (r.repositories.length < 100) break;
    }
  }
  const isDefault = (r: PickableRepo) => r.slug.toLowerCase() === DEFAULT_REPO.toLowerCase();
  return all.sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)) || a.slug.localeCompare(b.slug));
}

async function getJson<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders(token), cache: 'no-store' });
  if (res.status === 401) {
    signOut();
    throw new SignInExpired('Your GitHub sign-in has expired. Sign in again.');
  }
  if (!res.ok) throw new Error(`GitHub error ${res.status} listing your repos.`);
  return res.json() as Promise<T>;
}

function apiHeaders(token: string) {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` };
}

function randomString() {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}

async function sha256Base64Url(text: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
