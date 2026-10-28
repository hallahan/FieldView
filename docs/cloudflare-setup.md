# Setting up uploads: Cloudflare R2 and Access

OpenFieldView runs as one Cloudflare Worker that serves the app and keeps uploaded jobs in an R2 bucket. Cloudflare Access sits in front of the whole site, so only the people you list can open it. They sign in with their email address and a one-time code that Access emails them. There are no passwords and no accounts to make.

Everything below is done once, in the Cloudflare dashboard (https://dash.cloudflare.com). It takes about 20 minutes. All of it fits in Cloudflare's free plans: R2 includes 10 GB of storage a month, Workers 100,000 requests a day, and Zero Trust (which is where Access lives) up to 50 users. Turning on R2 and Zero Trust can ask for a payment card even on the free plans.

You end up with:

| What | Name used here |
| --- | --- |
| R2 bucket | `openfieldview-jobs` |
| Worker | `openfieldview`, at `https://openfieldview.<your-subdomain>.workers.dev` |
| Access application | made for you in step 3 |

The names `openfieldview-jobs` and `openfieldview` are set in [`wrangler.jsonc`](../wrangler.jsonc). If you pick other names, change them there too.

## 1. Make the R2 bucket

1. In the sidebar, open **R2 Object Storage**. If it's your first time, follow the prompts to turn R2 on.
2. Click **Create bucket**.
3. Name it `openfieldview-jobs`. Leave **Location** on Automatic and **Default storage class** on Standard.
4. Click **Create bucket**.

Leave **Public access** off: don't turn on the r2.dev URL or add a custom domain to the bucket. Files are only reached through the Worker, which checks the Access sign-in.

## 2. Deploy the Worker from GitHub

Cloudflare builds and deploys the site from the repo on every push to `main`.

1. In the sidebar, open **Workers & Pages**, then click **Create application**.
2. Choose **Import a repository** (it may be under the **Workers** tab, or labelled **Connect to Git**). Connect your GitHub account if asked, and pick `hallahan/OpenFieldView`.
3. Set:
   - **Project name**: `openfieldview`. This has to match `name` in `wrangler.jsonc`.
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy` (the default)
   - **Root directory**: leave empty.
4. Click **Create and deploy** and wait for the first build to finish (about two minutes).
5. Open the Worker's **Settings → Build → Branch control** and turn off builds for non-production branches. Otherwise every pull request is also deployed to a preview URL.
6. Check **Settings → Bindings**: it lists an R2 bucket binding called `BUCKET` for `openfieldview-jobs`. It comes from `wrangler.jsonc`, so there's nothing to add by hand.

The site is now at `https://openfieldview.<your-subdomain>.workers.dev`. The viewer works, but anyone can open it, and **Upload** says uploads are switched off until Access is set up. That's on purpose: the Worker won't touch the bucket until step 4 is done.

## 3. Turn on Cloudflare Access

1. Still on the Worker, open **Settings → Domains & Routes**.
2. On the `workers.dev` row, click **Enable Cloudflare Access**. If you haven't used Zero Trust before, Cloudflare first asks for a team name (any name, say `openfieldview`) and a plan. Pick **Free**.
3. A box shows two values. Copy both somewhere for step 4:
   - **POLICY_AUD**: a long hex string, the application's Audience (AUD) tag.
   - **TEAM_DOMAIN**: something like `https://openfieldview.cloudflareaccess.com`.
4. On the **Preview URLs** row, click **Disable**, so there's no address that skips Access.

To find the two values again later: the AUD tag is on the application's **Overview** in **Zero Trust → Access → Applications**, and the team domain is under **Zero Trust → Settings → Custom Pages**.

## 4. Tell the Worker about Access

1. On the Worker, open **Settings → Variables and Secrets** and click **Add**.
2. Add two variables, type **Text**:
   - `ACCESS_TEAM_DOMAIN` = the TEAM_DOMAIN from step 3, e.g. `https://openfieldview.cloudflareaccess.com`
   - `ACCESS_AUD` = the POLICY_AUD from step 3
3. Click **Deploy**.

These stay in place when later pushes deploy, because `wrangler.jsonc` has `"keep_vars": true`. Neither value is secret, but keeping them in the dashboard means the repo doesn't need to know them.

## 5. Choose who can sign in

1. Back in **Settings → Domains & Routes**, click **Manage Cloudflare Access** on the `workers.dev` row (or go to **Zero Trust → Access → Applications** and open the application).
2. Open **Policies** and edit the policy (there's one already, allowing your own email).
3. Under **Include**, list who's allowed:
   - **Emails**: one address per crew member, or
   - **Emails ending in**: e.g. `@theoutpost.io` to let in everyone with a company address.
4. Save.

Sign-in uses **One-time PIN**, which is on by default (**Zero Trust → Settings → Authentication → Login methods**). Access emails a six-digit code to the address the person types; nobody needs a Cloudflare account.

### How long people stay signed in

On the application, open **Settings** (or **Overview**, depending on the dashboard version) and set **Session duration**. The default is 24 hours, which means a code every day. **1 month** suits the controller and phones better. When a session runs out in the middle of something, OpenFieldView says so and keeps the open job and its photos while the person signs in again.

### Taking someone off

Remove their email from the policy, then revoke any session they still have: **Zero Trust → My Team → Users**, pick them, **Revoke session**.

## 6. Try it

1. Open `https://openfieldview.<your-subdomain>.workers.dev` in a private window. You should get the Cloudflare Access page asking for an email.
2. Enter an allowed email, then the code from the email.
3. Open the sample job (**Try a sample file**) and tap **Upload**.
4. Go to **Jobs**: the job is in the list and on the map, and **Account** shows who you're signed in as.
5. In the dashboard, open **R2 Object Storage → openfieldview-jobs → Objects**. You'll see `index.json` and a folder named after the job, with a folder inside named by the upload's UTC time. Every file can be downloaded from there.

## Uploading from the controller

Chrome on Android, which is what the TSC710 runs, can't pick a whole folder: a website can only ask for files there. (Desktop browsers get a **Pick a folder** button.) To send a job's photos from the controller:

1. In Trimble Access, export the job as JobXML, as usual.
2. In Chrome, open the site, tap **Open a .jxl or .rw5 file** and pick the `.jxl`.
3. Before tapping **Upload**, open **Photos, attachments and note**, tap **Add photos or files**, and go to the job's photo folder. Trimble Access usually keeps it at `Trimble Data/Projects/<project>/<Job name> Files/`.
4. Long-press one photo so it's selected, then tap ⋮ → **Select all**, then **Select** (or **Done**).
5. To send the Trimble `.job` too, tap **Add photos or files** again and pick it from the project folder.
6. Add a note if you like, then tap **Upload**.

The panel lists any photos the job file mentions that haven't been added yet. A `.zip` of the job's folder works too: the app opens it up and sends each file on its own. A bookmark or home-screen shortcut to the site saves typing the address each time.

## What's in the bucket

```
index.json                                    every job: name, centroid, latest upload
<Job name>/versions.json                      every upload of the job, newest first
<Job name>/2026-10-28T213627Z/<Job>.jxl       one upload, in a folder named by its UTC time
<Job name>/2026-10-28T213627Z/<Job>.job       ...and the Trimble .job, if it was sent
<Job name>/2026-10-28T213627Z/upload.json     who uploaded it, when, the note, every file with its size and SHA-256
<Job name>/media/IMG_0001.jpg                 photos and attachments, shared by all of the job's uploads
<Job name>/placement.json                     where a job in assumed coordinates was placed on the map
```

- Nothing is ever overwritten. A changed photo with the same name is kept beside the old one as `IMG_0001 (2026-10-28T213627Z).jpg`.
- An upload folder without an `upload.json` is one that was cut off part way. The Jobs list ignores it, and it's safe to delete.
- `index.json` and the `versions.json` files are only there to make the Jobs list quick. If they're deleted or edited by hand, **Jobs → Account → Rebuild the job list** writes them again from the `upload.json` files.
- Each file can be up to 100 MB (the most a Worker accepts in one request on the free plan).

## Later: your own domain

When there's a domain for the site:

1. Add the domain to Cloudflare, then on the Worker go to **Settings → Domains & Routes → Add → Custom domain**.
2. In **Zero Trust → Access → Applications**, open the application and add the new hostname under its public hostnames (or destinations), so Access protects it too. The AUD tag doesn't change, so the Worker variables stay as they are.
3. Turn off the `workers.dev` route if it's no longer needed.

## Retiring the GitHub data store

Jobs are no longer read from or written to GitHub. Once nothing needs it, these can go:

- the `hallahan/OFVData` repo (download any jobs in it first and upload them here)
- the `openfieldview` GitHub App (github.com/settings/apps)
- the `openfieldview-auth` Worker
- the repo's Actions variables `OFV_GITHUB_CLIENT_ID`, `OFV_GITHUB_APP_SLUG` and `OFV_AUTH_URL`

## Running it on your computer

```sh
npm install
npm run build
npm run dev:worker   # http://localhost:8787, with a local bucket, signed in as you@example.com
```

Without Access, the Worker only answers on `localhost`, and only when `DEV_USER_EMAIL` is set, which `npm run dev:worker` does. For changes to the app, run `npm run dev` alongside it: Vite's dev server passes `/api/` to the Worker.
