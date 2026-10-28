# Setting up "Sign in with GitHub"

OpenFieldView signs people in through a GitHub App. GitHub needs the app's client secret to hand out a token, and a static GitHub Pages site can't keep a secret, so a tiny Cloudflare Worker ([`worker/auth.js`](../worker/auth.js), about 50 lines) does that one step. It stores nothing; every upload still goes straight from the browser to GitHub.

This is a one-time setup for whoever runs the site. It takes about 10 minutes. You'll end up with three values to paste into the repo: a **Client ID**, an **app slug**, and a **Worker URL**.

## 1. Create the GitHub App

1. Go to <https://github.com/settings/apps/new>.
2. **GitHub App name**: `OpenFieldView`. If GitHub says it's taken, use something like `OpenFieldView-hallahan`.
3. **Homepage URL**: `https://hallahan.github.io/OpenFieldView/`
4. Under **Identifying and authorizing users**:
   - **Callback URL**: `https://hallahan.github.io/OpenFieldView/`
   - Click **Add Callback URL** and add `https://hallahan.github.io/openfieldview/` (the same address in lower case, since GitHub matches it exactly).
   - Optionally add a third, `http://localhost:5173/`, for local development.
   - Leave **Expire user authorization tokens** ticked.
   - Leave **Request user authorization (OAuth) during installation** unticked.
   - Leave **Enable Device Flow** unticked.
5. Under **Post installation**:
   - **Setup URL**: `https://hallahan.github.io/OpenFieldView/`
   - Tick **Redirect on update**.
6. Under **Webhook**, untick **Active**.
7. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. (**Metadata: Read-only** is added automatically. Nothing else is needed.)
8. Under **Where can this GitHub App be installed?**, pick **Any account** so other people can use OpenFieldView with their own repos. (**Only on this account** also works if it's just you.)
9. Click **Create GitHub App**.
10. On the page that opens:
    - Copy the **Client ID** (it starts with `Iv`).
    - Click **Generate a new client secret** and copy it now. GitHub only shows it once.
    - Note the **Public link**, `https://github.com/apps/<slug>`. The last part is the **app slug**, e.g. `openfieldview`.
11. In the left sidebar click **Install App**, then **Install** next to your account, choose **Only select repositories**, pick **OFVData** (and any other data repos), and click **Install**. People can also do this later from inside OpenFieldView.

## 2. Deploy the Cloudflare Worker

1. Sign in at <https://dash.cloudflare.com>.
2. In the left sidebar open **Compute (Workers) → Workers & Pages** and click **Create**, then **Start with Hello World!**.
3. Name it `openfieldview-auth` and click **Deploy**. Leave the Hello World code as it is: the code shown on this page is a read-only preview, so pasting into it does nothing.
4. On the next page click **Edit code** (top right). This opens the real editor.
5. Open [`worker/auth.js`](../worker/auth.js) on GitHub and click the **Copy raw file** button (the two-squares icon above the code).
6. Back in the Cloudflare editor, click inside `worker.js` on the left, press **Ctrl+A** then **Ctrl+V** to replace everything, and click **Deploy** (top right). Use the keyboard shortcut: right-click **Paste** is blocked in Firefox and Brave because the page isn't allowed to read the clipboard.
7. Go back to the Worker and open **Settings → Variables and Secrets**. Click **Add** three times:
   | Type | Name | Value |
   | --- | --- | --- |
   | Text | `GITHUB_CLIENT_ID` | the Client ID from step 1.10 |
   | Secret | `GITHUB_CLIENT_SECRET` | the client secret from step 1.10 |
   | Text | `ALLOWED_ORIGINS` | `https://hallahan.github.io,http://localhost:5173` |

   Click **Deploy** to save them.
8. Copy the Worker's URL from the top of its page. It looks like `https://openfieldview-auth.<your-subdomain>.workers.dev`.

If the editor still won't take the paste, deploy from a terminal instead (needs [Node.js](https://nodejs.org)). In a copy of this repo:

```sh
cd worker
npx wrangler login                          # opens Cloudflare in the browser to approve
npx wrangler deploy                         # creates or updates openfieldview-auth with auth.js
npx wrangler secret put GITHUB_CLIENT_ID    # paste the Client ID when asked
npx wrangler secret put GITHUB_CLIENT_SECRET
```

`ALLOWED_ORIGINS` comes from `wrangler.toml`, and `wrangler deploy` prints the Worker URL.

## 3. Tell the site about them

1. Go to <https://github.com/hallahan/OpenFieldView/settings/variables/actions>.
2. Click **New repository variable** three times:
   | Name | Value |
   | --- | --- |
   | `OFV_GITHUB_CLIENT_ID` | the Client ID |
   | `OFV_GITHUB_APP_SLUG` | the app slug |
   | `OFV_AUTH_URL` | the Worker URL |
3. Re-deploy: open the **Actions** tab, pick **Deploy to GitHub Pages**, and click **Run workflow** on `main`. (Any push to `main` does the same.)

Open the site, open a job, and tap **Sign in with GitHub to upload**.

## If the site moves to its own domain

Sign-in only works from the addresses GitHub and the Worker know about. After a move, change the GitHub App's **Homepage URL**, **Callback URL** and **Setup URL** to the new address (in the app's **General** settings), and add the new origin, e.g. `https://example.org`, to the Worker's `ALLOWED_ORIGINS`.

## How it works for people using the site

1. Tap **Sign in with GitHub**. GitHub asks them to approve OpenFieldView, then sends them back. The open file is kept while they're away.
2. A list of their repos appears. They tap one and the job uploads. The choice is remembered, so next time it's a single **Upload** button.
3. If a repo isn't in the list, **Give OpenFieldView access to it on GitHub** opens GitHub's page for choosing which repos the app may use. The app can never see repos they didn't choose.

Tokens last 8 hours and are renewed in the background for up to six months, after which they sign in again.

To let people without a GitHub account see or upload jobs, see [share-links.md](share-links.md).

For local development, put the same three values in a `.env.local` file as `VITE_GITHUB_CLIENT_ID`, `VITE_GITHUB_APP_SLUG` and `VITE_AUTH_URL`.
