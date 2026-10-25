# FieldView

A fully client-side web app for viewing Trimble JobXML (`.jxl`) survey files. Open a file and you get:

- its points on a MapLibre map (streets or satellite basemap), coloured by code
- a searchable point list with each point's position, field-captured feature attributes, and every raw attribute in the file
- metadata about the job: job properties, coordinate system, units, record counts, time span, and bounds

The file is parsed in the browser and never leaves your machine.

## Positions

Points are placed using, in order of preference, their WGS84 latitude/longitude, their ECEF coordinates, or their grid (north/east) coordinates. Points from the `<Reductions>` section are shown when it exists, otherwise the raw `<FieldBook>` point records.

Grid-only files need a coordinate system: enter an EPSG code (looked up on epsg.io) or a proj4 string in the sidebar.

## Development

```sh
npm install
npm run dev     # local dev server
npm test        # parser tests
npm run build   # production build into dist/
```

## Deployment

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`. In the repo settings, set **Pages → Source** to **GitHub Actions**.
