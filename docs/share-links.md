# Share links

A share link lets someone see a repo's jobs on the map and download them, and optionally upload jobs, without a GitHub account. Whoever has the link needs nothing else: no sign-in, no app, no settings.

## Making a link

1. Sign in with GitHub and open the **Jobs** tab.
2. Open **GitHub account and repos** and tap **Share** next to the repo. (Or open a job and tap **Share** to send just that one job.)
3. Give the link a name (e.g. "Crew 2"), choose **View and download** or **Also upload**, choose when it stops working, and tap **Create link**.
4. Tap **Copy link** (or **Send…** on a phone) and send it by text or email.

The same panel lists every live link for the repo. **Turn off** stops a link at once (within about a minute everywhere). Only admins of the repo can make or turn off links.

## What someone with a link can do

- **Repo link, view and download:** see every job in the repo on the map, open one, and tap **Download .jxl** (or .rw5). Older versions are under **Versions**.
- **Repo link with uploads:** also open a .jxl or .rw5 from their device and tap **Upload**. They can add their name, which goes in the commit message along with the link's name.
- **Job link:** opens straight into that one job with a **Download** button at the top. Always view only.

## How it's kept reasonably safe

- The link is `https://hallahan.github.io/OpenFieldView/#share=<secret>`, where the secret is 32 random bytes. Everything after `#` stays in the browser: GitHub Pages never sees it. The app sends it only to the Worker, in a request header rather than a URL.
- The Worker keeps each link in Workers KV under a hash of its secret, with the repo, the permissions and the expiry. It uses the GitHub App to get a token for that one repo, read-only unless the link allows uploads.
- A link can only read `index.geojson` and `jobs/<name>/<name>.jxl|.rw5`. Nothing else in the repo is reachable, and nothing can be deleted. An upload over an existing job is a new commit, so git history keeps every earlier version.
- Uploads must be a real JobXML or RW5 file under 25 MB, and each link can upload 30 times an hour.
- The main risk is a link being forwarded to someone it wasn't meant for. Use an expiry, give each crew its own link, and turn a link off when the job is done.

## Setup (once, about 5 minutes)

Share links reuse the sign-in Worker ([`worker/auth.js`](../worker/auth.js)) and GitHub App from [github-sign-in.md](github-sign-in.md). They need three more things.

### 1. A private key for the GitHub App

1. Open <https://github.com/settings/apps>, then **Edit** next to OpenFieldView.
2. Note the **App ID** near the top of the **General** page (a number).
3. Scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Keep it somewhere safe; it's the app's password.

The app's permissions stay as they are (**Contents: Read and write**). It can only reach repos it's installed on.

### 2. A KV store for the links

1. In the Cloudflare dashboard open **Storage & Databases → Workers KV** and click **Create instance** (or **Create namespace**). Name it `openfieldview-shares`.
2. Open the `openfieldview-auth` Worker, then **Settings → Bindings → Add → KV namespace**. Set **Variable name** to `SHARES` and pick `openfieldview-shares`. Save and deploy.

### 3. The Worker's new code and secrets

1. Paste the new [`worker/auth.js`](../worker/auth.js) into the Worker the same way as before (**Edit code**, Ctrl+A, Ctrl+V, **Deploy**).
2. Under **Settings → Variables and Secrets** add:
   | Type | Name | Value |
   | --- | --- | --- |
   | Text | `GITHUB_APP_ID` | the App ID from step 1 |
   | Secret | `GITHUB_APP_PRIVATE_KEY` | the whole contents of the `.pem` file, including the `-----BEGIN` and `-----END` lines |

   Click **Deploy**.

Nothing changes on the site itself: it already knows the Worker's address. Until the setup is done, **Share** answers "Share links aren't set up on this site yet".

## Trying it locally

`node worker/test/dev-server.js` runs the Worker against an in-memory fake GitHub and prints a view link and an upload link. Start the site with `VITE_AUTH_URL=http://localhost:8787 VITE_GITHUB_CLIENT_ID=dev npm run dev` and open one.
