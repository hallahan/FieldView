// Checks the sign-in Cloudflare Access puts on every request it lets through.
//
// Access sits in front of the whole site and only passes people who signed in
// with an emailed one-time PIN (or whatever login the Access policy allows).
// It adds a signed token in the Cf-Access-Jwt-Assertion header; checking that
// token here means the bucket can't be reached by going around Access, say
// through a URL the policy doesn't cover.

export interface AccessEnv {
  /** The team domain from Zero Trust → Settings, e.g. "openfieldview" or "openfieldview.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Audience (AUD) tag. */
  ACCESS_AUD?: string;
  /** Local development only: the email to act as when Access isn't set up. Ignored unless the request is to localhost. */
  DEV_USER_EMAIL?: string;
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

interface Jwk extends JsonWebKey {
  kid: string;
}

let certs: { url: string; keys: Map<string, CryptoKey>; fetched: number } | undefined;

export function teamUrl(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${d.includes('.') ? d : `${d}.cloudflareaccess.com`}`;
}

async function signingKey(team: string, kid: string): Promise<CryptoKey | undefined> {
  const url = `${team}/cdn-cgi/access/certs`;
  // Access rotates keys every few weeks; refetch when an unknown key shows up, at most once a minute.
  if (!certs || certs.url !== url || (!certs.keys.has(kid) && Date.now() - certs.fetched > 60_000)) {
    const res = await fetch(url);
    if (!res.ok) throw new AccessError(`Couldn't fetch the Access signing keys (${res.status})`, 503);
    const body = (await res.json()) as { keys: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys) {
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    certs = { url, keys, fetched: Date.now() };
  }
  return certs.keys.get(kid);
}

function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** The signed-in person's email, or throws AccessError. */
export async function signedInEmail(request: Request, env: AccessEnv, now = Date.now()): Promise<string> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
    const host = new URL(request.url).hostname;
    if (env.DEV_USER_EMAIL && (host === 'localhost' || host === '127.0.0.1')) return env.DEV_USER_EMAIL;
    throw new AccessError('Uploads are switched off: Cloudflare Access is not set up for this site yet (ACCESS_TEAM_DOMAIN and ACCESS_AUD).', 503);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization');
  if (!token) throw new AccessError('Not signed in.');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new AccessError('Bad sign-in token.');
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    throw new AccessError('Bad sign-in token.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new AccessError('Bad sign-in token.');
  const team = teamUrl(env.ACCESS_TEAM_DOMAIN);
  const key = await signingKey(team, header.kid);
  if (!key) throw new AccessError('Sign-in token signed with an unknown key.');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError('Sign-in token signature is wrong.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AccessError('Sign-in token is for a different Access application.');
  if (payload.iss !== team) throw new AccessError('Sign-in token is from a different Access team.');
  const sec = now / 1000;
  if (!payload.exp || payload.exp < sec - 30 || (payload.nbf && payload.nbf > sec + 30)) throw new AccessError('Sign-in has expired.');
  if (!payload.email) throw new AccessError('Sign-in token has no email address.', 403);
  return payload.email.toLowerCase();
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** For tests: forget fetched keys. */
export function resetKeyCache() {
  certs = undefined;
}
