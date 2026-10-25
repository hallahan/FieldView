# FieldView

A fully client-side web app for viewing Trimble JobXML (`.jxl`) survey files. Open a file and you get:

- its points on a MapLibre map (streets or satellite basemap), coloured by code
- a searchable point list with each point's position, field-captured feature attributes, and every raw attribute in the file
- metadata about the job: job properties, coordinate system, units, record counts, time span, and bounds

The file is parsed in the browser and never leaves your machine.

## Positions

Points are placed using, in order of preference, their WGS84 latitude/longitude, their ECEF coordinates, or their grid (north/east) coordinates. Points from the `<Reductions>` section are shown when it exists, otherwise the raw `<FieldBook>` point records.

Jobs can mix GNSS and total station shots. Each point is tagged with how it was measured, and the map can colour by that. Total station shots usually come with reduced grid coordinates in `<Reductions>`. When they don't, FieldView reduces them from the setup, backsight orientation and circle readings. That is a plane reduction with no scale factor or curvature correction.

NAD83(2011) / California State Plane Zone 3 (EPSG:6419, US-foot variant EPSG:6420) is built in and detected from the job's zone name, so grid-only points are placed automatically. The reference epoch (for example 2017.50 or 2025.00) is read from the file and shown in the metadata. Map display uses Web Mercator and does not apply datum or epoch shifts against the basemap. For other zones, enter an EPSG code (looked up on epsg.io) or a proj4 string in the sidebar.

Grid values are shown in the job's distance units (US survey feet, international feet or metres).

## Development

```sh
npm install
npm run dev     # local dev server
npm test        # parser tests
npm run build   # production build into dist/
```

## Deployment

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`. In the repo settings, set **Pages → Source** to **GitHub Actions**.
