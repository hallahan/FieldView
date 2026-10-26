// The "Sign in with GitHub" setup for this site, filled in at build time from
// the repo's Actions variables (docs/github-sign-in.md). None of these are
// secret: the client secret lives only in the sign-in worker (worker/auth.js).

/** Client ID of the OpenFieldView GitHub App (github.com/settings/apps). */
export const GITHUB_CLIENT_ID: string = import.meta.env.VITE_GITHUB_CLIENT_ID ?? '';

/** The app's URL name, as in github.com/apps/<slug>. */
export const GITHUB_APP_SLUG: string = import.meta.env.VITE_GITHUB_APP_SLUG ?? '';

/** The deployed worker/auth.js, e.g. https://openfieldview-auth.<you>.workers.dev */
export const AUTH_URL: string = import.meta.env.VITE_AUTH_URL ?? '';

/** Listed first in the repo picker. */
export const DEFAULT_REPO = 'hallahan/OFVData';
