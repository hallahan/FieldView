import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetKeyCache, signedInEmail, teamUrl } from './access';

const TEAM = 'https://ofv.cloudflareaccess.com';
const AUD = 'aud-tag-123';
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetKeyCache();
});

const b64 = (b: Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? new TextEncoder().encode(b) : b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function token(claims: Record<string, unknown>, kid = 'k1') {
  const head = b64(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}

function serveCerts() {
  const f = vi.fn(async (url: string) => {
    expect(url).toBe(`${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }));
  });
  vi.stubGlobal('fetch', f);
  return f;
}

const env = { ACCESS_TEAM_DOMAIN: 'ofv', ACCESS_AUD: AUD };
const now = Date.parse('2026-10-28T21:00:00Z');
const good = { aud: [AUD], iss: TEAM, email: 'Crew@Example.com', exp: now / 1000 + 3600, iat: now / 1000 };
const req = (t?: string, url = 'https://openfieldview.example.workers.dev/api/me') =>
  new Request(url, { headers: t ? { 'Cf-Access-Jwt-Assertion': t } : {} });

describe('Cloudflare Access sign-in', () => {
  it('accepts a token Access signed for this application', async () => {
    const f = serveCerts();
    expect(await signedInEmail(req(await token(good)), env, now)).toBe('crew@example.com');
    expect(await signedInEmail(req(await token(good)), env, now)).toBe('crew@example.com');
    expect(f).toHaveBeenCalledTimes(1); // keys are cached
  });

  it('reads the CF_Authorization cookie when the header is missing', async () => {
    serveCerts();
    const r = new Request('https://x.workers.dev/api/me', { headers: { Cookie: `a=b; CF_Authorization=${await token(good)}` } });
    expect(await signedInEmail(r, env, now)).toBe('crew@example.com');
  });

  it('refuses tokens for another application, team, or that have expired', async () => {
    serveCerts();
    await expect(signedInEmail(req(await token({ ...good, aud: ['other'] })), env, now)).rejects.toThrow('different Access application');
    await expect(signedInEmail(req(await token({ ...good, iss: 'https://evil.cloudflareaccess.com' })), env, now)).rejects.toThrow('different Access team');
    await expect(signedInEmail(req(await token({ ...good, exp: now / 1000 - 600 })), env, now)).rejects.toThrow('expired');
    await expect(signedInEmail(req(), env, now)).rejects.toThrow('Not signed in');
  });

  it('refuses a token with a forged signature', async () => {
    serveCerts();
    const t = await token(good);
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64(JSON.stringify({ ...good, email: 'boss@example.com' }))}.${s}`;
    await expect(signedInEmail(req(forged), env, now)).rejects.toThrow('signature');
  });

  it('is switched off until Access is set up, except for local development', async () => {
    await expect(signedInEmail(req(), {}, now)).rejects.toMatchObject({ status: 503 });
    await expect(signedInEmail(req(), { DEV_USER_EMAIL: 'me@dev' }, now)).rejects.toMatchObject({ status: 503 });
    expect(await signedInEmail(req(undefined, 'http://localhost:8787/api/me'), { DEV_USER_EMAIL: 'me@dev' }, now)).toBe('me@dev');
  });

  it('takes the team domain in either form', () => {
    expect(teamUrl('ofv')).toBe(TEAM);
    expect(teamUrl('https://ofv.cloudflareaccess.com/')).toBe(TEAM);
  });
});
