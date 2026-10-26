// OpenFieldView sign-in helper: a Cloudflare Worker that swaps a GitHub
// sign-in code (or a refresh token) for an access token.
//
// GitHub's token endpoint needs the app's client secret and doesn't allow
// browser (CORS) requests, so a static site can't call it itself. This is the
// only server-side piece, it stores nothing, and it only answers the origins
// listed in ALLOWED_ORIGINS.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GITHUB_CLIENT_ID      the GitHub App's Client ID
//   GITHUB_CLIENT_SECRET  a client secret generated on the GitHub App (type: Secret)
//   ALLOWED_ORIGINS       comma-separated, e.g. https://hallahan.github.io,http://localhost:5173

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {};
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!cors['Access-Control-Allow-Origin']) return reply(403, { error: 'origin_not_allowed', origin });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return reply(500, { error: 'worker_not_configured' });

    let input;
    try {
      input = await request.json();
    } catch {
      return reply(400, { error: 'bad_json' });
    }
    const params = { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET };
    if (typeof input.code === 'string') {
      params.code = input.code;
      if (typeof input.redirect_uri === 'string') params.redirect_uri = input.redirect_uri;
      if (typeof input.code_verifier === 'string') params.code_verifier = input.code_verifier;
    } else if (typeof input.refresh_token === 'string') {
      params.grant_type = 'refresh_token';
      params.refresh_token = input.refresh_token;
    } else {
      return reply(400, { error: 'missing_code' });
    }

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'openfieldview-auth' },
      body: JSON.stringify(params),
    });
    // GitHub answers 200 with an "error" field when the code is bad or used.
    const body = await res.json().catch(() => ({ error: 'bad_github_response' }));
    return reply(res.ok && !body.error ? 200 : 400, body);
  },
};
