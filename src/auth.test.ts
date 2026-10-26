// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({
  GITHUB_CLIENT_ID: 'Iv23test',
  GITHUB_APP_SLUG: 'openfieldview',
  AUTH_URL: 'https://auth.example.workers.dev',
  DEFAULT_REPO: 'hallahan/OFVData',
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let assigned: string | undefined;

/** Pretend to be at https://hallahan.github.io/OpenFieldView/<search>. */
function at(search = '') {
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    origin: 'https://hallahan.github.io',
    pathname: '/OpenFieldView/',
    search,
    hash: '',
    assign: (url: string) => (assigned = url),
  } as unknown as Location);
}

async function freshAuth() {
  vi.resetModules();
  return import('./auth');
}

describe('sign-in', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    assigned = undefined;
    at();
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends the person to GitHub with state and a PKCE challenge', async () => {
    const auth = await freshAuth();
    await auth.beginSignIn();
    const url = new URL(assigned!);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv23test');
    expect(url.searchParams.get('redirect_uri')).toBe('https://hallahan.github.io/OpenFieldView/');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const pending = JSON.parse(sessionStorage.getItem('openfieldview.auth.pending')!);
    expect(url.searchParams.get('state')).toBe(pending.state);
  });

  it('swaps the code for a token through the worker and remembers the user', async () => {
    const auth = await freshAuth();
    sessionStorage.setItem('openfieldview.auth.pending', JSON.stringify({ state: 'abc', verifier: 'v' }));
    at('?code=c0de&state=abc');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ access_token: 'ghu_1', expires_in: 28800, refresh_token: 'ghr_1' }))
      .mockResolvedValueOnce(json({ login: 'hallahan', avatar_url: 'https://avatars/x?v=4' }));
    expect(await auth.completeRedirect()).toBe('signed-in');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.example.workers.dev');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ code: 'c0de', redirect_uri: 'https://hallahan.github.io/OpenFieldView/', code_verifier: 'v' });
    expect(auth.currentSession()?.login).toBe('hallahan');
    expect(await auth.getToken()).toBe('ghu_1');
    expect(JSON.parse(localStorage.getItem('openfieldview.auth')!).refreshToken).toBe('ghr_1');
  });

  it('refuses a code this tab never asked for', async () => {
    const auth = await freshAuth();
    sessionStorage.setItem('openfieldview.auth.pending', JSON.stringify({ state: 'abc', verifier: 'v' }));
    at('?code=c0de&state=evil');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(auth.completeRedirect()).rejects.toThrow(/stale/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats coming back from choosing repos as a repo change', async () => {
    const auth = await freshAuth();
    at('?installation_id=1&setup_action=update');
    expect(await auth.completeRedirect()).toBe('repos-changed');
  });

  it('refreshes an expiring token', async () => {
    localStorage.setItem('openfieldview.auth', JSON.stringify({ token: 'old', expiresAt: Date.now() + 1000, refreshToken: 'ghr_1', login: 'hallahan' }));
    const auth = await freshAuth();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'new', expires_in: 28800, refresh_token: 'ghr_2' }));
    expect(await auth.getToken()).toBe('new');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ refresh_token: 'ghr_1' });
    expect(auth.currentSession()?.refreshToken).toBe('ghr_2');
  });

  it('lists the repos the app can reach, the data repo first', async () => {
    localStorage.setItem('openfieldview.auth', JSON.stringify({ token: 't', login: 'hallahan' }));
    const auth = await freshAuth();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ installations: [{ id: 7 }] }))
      .mockResolvedValueOnce(
        json({
          repositories: [
            { full_name: 'hallahan/Alpha', private: false, permissions: { push: true } },
            { full_name: 'hallahan/OFVData', private: true, permissions: { push: true } },
            { full_name: 'someone/ReadOnly', private: false, permissions: { push: false } },
          ],
        }),
      );
    const repos = await auth.listRepos();
    expect(repos.map((r) => r.slug)).toEqual(['hallahan/OFVData', 'hallahan/Alpha', 'someone/ReadOnly']);
    expect(repos[2].canPush).toBe(false);
  });
});
