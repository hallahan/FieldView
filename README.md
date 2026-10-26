# OpenFieldView

A free and open source way to get field data off your data collector, onto a map, and into the cloud, without paying for a SaaS subscription. It reads Trimble JobXML (`.jxl`) and Carlson SurvCE / SurvPC raw data (`.rw5`), and will grow to cover other data collector formats.

Try it at https://hallahan.github.io/OpenFieldView/.

OpenFieldView is a fully client-side web app. Open a `.jxl` or `.rw5` file and you get:

- its points on a MapLibre map (streets or satellite basemap), coloured by code
- linework built from the points' feature codes, styled from a Trimble feature library (`.fxl`) if you add one, with each line's properties a tap away
- a searchable point list with each point's position, field-captured feature attributes, and every raw attribute in the file
- metadata about the job: job properties, coordinate system, units, record counts, time span, and bounds

Opening or dropping a file only shows it; it's parsed in the browser. It leaves your machine only if you tap **Upload** to send it to a GitHub repo.

## Carlson raw data (RW5)

An RW5 is a log of the raw observations, so OpenFieldView reduces them itself: side shots and traverses (`SS`, `TR`) from the occupied point and backsight (`OC`, `BK`, `LS`), angle sets (`BD`, `FD`, `FR`, `BR`) averaged across faces and sets, stored points (`SP`) and GPS positions (`GPS`, with their `--GS` local grid and `G0`-`G3` / `--HRMS` quality). Angles right are taken as circle readings from the backsight's, as SurvCE writes them, and the `MO` record's units, south azimuths, scale factor and curvature setting are applied. A shot to a point that's already known is kept as a check shot and doesn't move it. Each point's description is its code, so linework works as for a JXL, and `--` notes after a shot appear in its properties.

An RW5 doesn't say which coordinate system it's in, so pick one under the point list. It defaults to NAD83(2011) California zone 3, and the last one used is remembered on the device. The distance unit comes from the file and can be changed there too. Then:

- grid coordinates in that zone are placed on the map, like a JXL's grid-only points
- when GPS points carry both lat/long and a local grid, the rest of the job's local grid is fitted to them (a 2D similarity transformation), so total station work on a localized, assumed grid lands in the right place
- otherwise, assumed coordinates such as N 5000, E 5000 don't fall in the zone, so they're left off the map rather than drawn hundreds of miles away

## Linework from feature codes

Points with the same line code are joined in the order they were measured, the way Trimble Access and Business Center do it. Control codes after a feature code shape the line: in Caltrans coding, `PCC1 BL` begins a line, `EL` ends it, `BC`/`EC` bracket a smooth curve, `CL` closes it, `JP 1001` joins to point 1001, `R3` draws a rectangle from three shots, `C3` a circle through three points and `C2 1.5` a circle of radius 1.5 (in the job's units). A point can carry several codes (`BARB EL BARB1 BL`), and numbered strings (`PCC1`, `PCC2`) are separate lines of the same feature.

Without a feature library the Caltrans control codes are used, and any code that ever carries one is treated as a line. Add a Trimble feature library (`.fxl`, as exported from Business Center's Feature Definition Manager) under **Feature library** to use its own control codes and draw each feature as the library defines it:

- colours from the feature or its layer (CAD white is drawn black on the street map, as on a white CAD background)
- line styles from their patterns: dashes, and decorations such as guardrail posts, fence crosses, wall notches and text, at a fixed paper size
- point symbols, polygon fills, and parallel offset lines such as a curb's back

Libraries are kept in the browser (IndexedDB), so each one is added once per device. When a job names the library it was coded with (`FeatureCodingRecord`), that library is picked automatically if it's on the device.

Tap a line or polygon to see its properties, as for a point:

- its shape and size: 2D and 3D length (or perimeter), area, radius or sides, and elevation range, measured on the job's grid and following curves
- the feature's definition from the library, and the attributes captured at its points. Attributes are recorded at every shot, so where a value changes along the line (a guardrail going from Thrie beam to MBGR, say) each value is listed with the points it covers
- its points, each of which opens that point; from a point, ↑/↓ then step along the line

A point's properties list the lines through it in the same way. A tap within a few pixels of a point picks the point; further along a line, the line.

## Uploading jobs to GitHub

The **Jobs** tab keeps jobs in one or more GitHub repos, public or private, and shows them as a list and as pins on the map. From a job you can open it in the viewer, download it, or open any earlier version.

A data repo looks like this:

```
index.geojson                         one Point per job at its centroid, with upload dates and counts
jobs/<jobName>/<jobName>.jxl          the latest upload of each job (.rw5 for Carlson jobs)
```

Uploading the same job again overwrites its file, so every field visit is a commit and git history holds the versions. The JXL and the updated index are written in one commit, and an upload identical to the last one is skipped.

To upload, tap **Sign in with GitHub to upload**, approve OpenFieldView on GitHub, and pick a repo from the list. Nothing is typed. The repo is remembered, so after that it's one **Upload** button (with **Change** to pick another). OpenFieldView signs in through a GitHub App, so it only sees the repos you choose to give it; **Give OpenFieldView access to it on GitHub** under the list adds more. More repos can be shown on the Jobs tab under **GitHub account and repos**. Public repos there can be browsed without signing in.

Sign-in needs a one-time setup by whoever hosts the site: a GitHub App and a small Cloudflare Worker ([`worker/auth.js`](worker/auth.js)) that swaps GitHub's sign-in code for a token, since that step needs a secret a static site can't hold. Step-by-step instructions are in [docs/github-sign-in.md](docs/github-sign-in.md).

## Positions

Points are placed using, in order of preference, their WGS84 latitude/longitude, their ECEF coordinates, or their grid (north/east) coordinates. Points from the `<Reductions>` section are shown when it exists, otherwise the raw `<FieldBook>` point records.

Jobs can mix GNSS and total station shots. Each point is tagged with how it was measured, and the map can colour by that. Total station shots usually come with reduced grid coordinates in `<Reductions>`. When they don't, OpenFieldView reduces them from the setup, backsight orientation and circle readings. That is a plane reduction with no scale factor or curvature correction.

NAD83(2011) / California State Plane Zone 3 (EPSG:6419, US-foot variant EPSG:6420) is built in and detected from the job's zone name, so grid-only points are placed automatically. The reference epoch (for example 2017.50 or 2025.00) is read from the file and shown in the metadata.

### Lining up with the basemap

Basemap imagery is referenced to WGS84, which tracks ITRF, while NAD83(2011) is fixed to the North American plate. In California the two are about 1.5 m apart. For NAD83 jobs, OpenFieldView moves each point onto WGS84 at today's date for drawing. It chains two time-dependent 14-parameter transformations, NAD83(2011) to ITRF2014 to ITRF2020 (≈ WGS84 G2296), the same way Trimble Access does, because NGS defines NAD83(2011) only against ITRF2014. Each step is taken from the job's `KinematicTransformationsRecord` when Trimble Access stored it, and otherwise from the NGS or IERS values. The file's coordinates are shown unchanged, and a checkbox turns the shift off for comparison.

This does not model deformation within the plate, which HTDP covers. In coastal California that is a few centimetres a year, so epoch 2017.50 and 2025.00 coordinates of the same mark get the same shift, and a few decimetres of difference remains. That is well inside the accuracy of typical web imagery.

Imagery itself is often a metre or more out. On the satellite basemap, **Align** lets you drag the imagery (with a finger or the mouse, or nudge it with the arrow keys) until it sits under the survey. The survey never moves: the imagery tiles are redrawn shifted by the offset. The offset is kept on the device for each job, by its job name, and **Reset** puts the imagery back.

### Jobs in assumed coordinates

A total station job started on an assumed system (say 10000, 10000, with an assumed basis of bearing) has no position on the earth. OpenFieldView offers **Place on the map** for any job whose points all come from grid coordinates. Pan and zoom until the target sits where the job goes and tap **Put it here**. Then drag the job into position and turn the handle (or type the rotation in decimal degrees or DMS) until it lines up with the imagery. Tapping a point makes it the pivot, so you can pin one known point and turn the job about it. On a keyboard, the arrow keys nudge the job and `[` `]` turn it a minute of arc (Shift for ten).

The rotation is the angle added to the job's bearings to give true bearings. The grid is laid on a plane tangent to the ellipsoid at the pin, so distances and angles stay as measured. The placement is kept on the device for each job and is written to the job's entry in `index.geojson` when it's uploaded, so the Jobs map and other devices see it too. **Start over** removes it. The sample link "or one in assumed coordinates" opens a synthetic job to try it on.

### Site calibration

Grid coordinates in a calibrated job include Trimble's horizontal plane adjustment (`HorizontalAdjustmentRecord`). OpenFieldView removes it before un-projecting grid-only points, which matches Trimble Access to the millimetre. The vertical adjustment (geoid plus inclined plane) doesn't affect map position and isn't applied. For other zones, enter an EPSG code (looked up on epsg.io) or a proj4 string in the sidebar.

Grid values are shown in the job's distance units (US survey feet, international feet or metres).

## Development

```sh
npm install
npm run dev     # local dev server
npm test        # parser and storage tests
npm run build   # production build into dist/
```

## License

MIT. See [LICENSE](LICENSE).

## Deployment

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`. In the repo settings, set **Pages → Source** to **GitHub Actions**.
