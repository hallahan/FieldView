# Trimble Access job file (.job) format

Trimble doesn't publish the `.job` format. This is what has been worked out so
far, by comparing JOB files with JobXML (`.jxl`) exported from the same jobs.
It is enough to read points, codes, feature attributes, edits, deletes, GNSS
observations and the coordinate system. `src/job.ts` implements it, and
`src/job.compare.test.ts` checks it against JobXML.

Checked against Trimble Access 25.10, 25.20 and 26.10 (database versions
2510-3, 2520-12, 2610-15). Everything is little-endian. Confidence is marked
where it matters: **known** means it matches JobXML on every point of every
sample, **guess** means it fits the samples but hasn't been tested by a job
that would tell it apart from something else.

## File layout

| Offset | Size | What |
| --- | --- | --- |
| 0 | 42 | `Trimble General Survey Journal`, zero padded |
| 42 | 3 | `01 04 00` (unknown, constant) |
| 45 | 3 | database version: major, minor, build (`1a 0a 0f` = 26.10.15) |
| 48 | … | records, back to back, to the end of the file |

The file is a journal. Records are only ever appended: an edit is a new
record that points back at the record it changes, so the current state of
the job is found by replaying the file from the start.

## Records

Each record is a `u32` length *n*, then *n* bytes:

| Offset | Size | What |
| --- | --- | --- |
| 0 | 1 | status (0–3). Meaning unknown; constant for each record type |
| 1 | 2 | kind (below) |
| 3 | 4 | parent record ID (0 for top-level records) |
| 7 | 2 | record type (below) |
| 9 | 4 | record ID. JobXML's `ID` attribute is this in hex |
| 13 | 8 | time stored: `f64` seconds since 1980-01-01, controller local time |
| 21 | 2 | minutes to add to local time to get UTC (420 = PDT, 480 = PST) |
| 23 | n − 25 | payload |
| n − 2 | 2 | CRC-16/ARC of bytes 0 … n − 3 (reflected poly 0x8005, init 0) |

**Known:** framing and CRC check out on every record of every sample, and the
last record ends exactly at the end of the file.

Kinds:

| Kind | Meaning |
| --- | --- |
| `0x2a30` | a new record |
| `0x2a31` | a replacement for the record whose ID is in the parent field |
| `0x2a32` | a replacement child (seen once; treated like `0x2a33`) |
| `0x2a33` | a child of the parent record: position, edit, delete, note… |

## Value encodings

- Strings are null-terminated UTF-8.
- Doubles are IEEE `f64`. `a0 c8 eb 85 f3 cc e1 7f` (about 1e308) means "no value".
- Geodetic coordinates and projection angles are radians. Lengths are metres,
  whatever units the job displays in.
- Several records start with the two letters `KI` after the first byte. Points
  carry a similar two-letter tag (below).

## Record types

| Type | JobXML | Notes |
| --- | --- | --- |
| 0 | (`JOBFile` attributes) | name the job was created as, controller serial, Access version, product |
| 1 | `NoteRecord` / point `Notes` | text. As a child of a point: "Deleted 11:04:03 AM 9/25/2026", "Old values …" |
| 2 | `PointRecord` | see below |
| 8 | `ECEFDeltas` … | GNSS vector, no tilt |
| 9 | `ECEFDeltas`, `DeviceAxisOrientation` | GNSS vector with IMU tilt |
| 15 | `WGS84` | keyed-in or base position: lat, lon (radians), height |
| 17 | `Grid` | keyed-in grid: north, east, elevation (metres) |
| 19 | `SourcePoint`, `Polar` | COGO point: source name, azimuth, horizontal and vertical distance |
| 21 | (not in the samples' JobXML) | total station observation, probably HA, VA, SD and IDs of setup, backsight, target |
| 31 | — | end of a point's records (payload `00`) |
| 32 | `QualityControl1` | satellites, DOPs, epochs, start and end time |
| 33 | `QualityControl2` | vector covariance (VCV xx, xy, xz, yy, yz, zz) |
| 35 | `Precision` | horizontal, vertical |
| 36 | `EllipsoidRecord` | |
| 37 | `DatumRecord` | |
| 38 | `ProjectionRecord` | |
| 39 | `HorizontalAdjustmentRecord` | |
| 40 | `VerticalAdjustmentRecord` | |
| 41 | `CorrectionsRecord` | |
| 44 | `CalibrationPointRecord` | not decoded |
| 45 | `GPSEquipmentRecord` | |
| 46 | `AntennaRecord` | |
| 47 | `RoverSurveyOptionsRecord` | not decoded |
| 48 | `BaseSurveyOptionsRecord` | not decoded |
| 49 | `SurveyEventRecord` | not decoded |
| 51 | `UnitsRecord` | |
| 54 | `FeatureCodingRecord` | FXL name and path; not decoded |
| 68 | `InitialisationRecord` | not decoded |
| 70 | `ReferenceRecord` | GNSS base |
| 87 | `CoordinateSystemRecord` | |
| 125 | `LinkedFilesRecord` | not decoded |
| 127 | `ActiveMapFilesRecord` | not decoded |
| 128 | `JobPropertiesRecord` | not decoded |
| 146 | `TimeZoneRecord` | not decoded |
| 151 | `NTRIPDataSourceRecord` | not decoded |
| 173 | `TiltSensorCalibrationRecord` | not decoded |
| 204 | `IMUCenteringAlignmentRecord` | not decoded |
| 215–217 | `DisplacementModelsRecord`, `KinematicTransformationsRecord`, `ReferenceFrameTransformationsRecord` | 216 decoded |
| 1000 | `Deleted` | child of a point: `00 00` deleted, `00 01` restored. Latest wins |
| 1003 | `jobName` | child of record 0: the job's current name |
| 1004 | `Features` | child of a point: its whole code and attribute list again, after an edit. Latest wins |

Types 124, 144, 155, 172, 197 and 220 appear alongside total station work and
are not decoded yet.

### Point (type 2)

| What | Encoding |
| --- | --- |
| | `u8` 0 |
| feature codes | `u32` count, then for each: `u8` 0, name, `u8` 3, `u16` 0, `u32` attribute count, attributes |
| attribute | `u16` type, name, value: type 0 Numeric `f64`; 1 Text string; 2 Menu `u16` item index + string; 5 File string; 8 Photo string (file name only; JobXML adds `<job> Files/`) |
| description 1 | string |
| ? | 7 bytes, all zero in the samples. **Guess:** description 2 and the description names are in here; the reader finds the name from the end instead |
| name | string |
| source | 2 ASCII letters: `KI` keyed in, `TP` topo, `SI` base, `CN` control, `SN`, `F2`, `AV`… |
| method | `u16`: 1 Coordinates, 6 BearingDistancePointIntersection, 11 GpsStaticObservation, 13 GpsRTKControlPoint, 60 FromBase |
| survey method | `u16`: 0 KeyedIn, 1 Autonomous, 14 RTK, 15 NetworkRTK |
| classification | `u16`: 3 Construction, 4 Normal, 7 Averaged, 9 Control |
| ? | `u16` 0, `u16` 0 or 1 |

The point's code in JobXML is the feature code names joined by spaces.
JobXML from Access 26 only lists codes that have attributes as `Features`;
Access 25 also lists the plain ones (BL, EL…).

### GNSS vector (types 8 and 9)

`u8` 0, ΔX, ΔY, ΔZ (`f64`, ECEF metres), `u32` reference record ID, `u32`
antenna record ID. Type 9 then has `u8` 3 (IMU tilt), yaw, pitch, roll
(radians), and their standard deviations.

The vector runs from the base antenna's phase centre to the rover's. To get
the ground mark (**known**, matches JobXML to < 0.01 mm on every point):

1. Base mark: the WGS84 position of the point named in the reference record.
2. Base phase centre: up the ellipsoid normal by the base antenna's height.
3. Rover phase centre: base phase centre + ΔX, ΔY, ΔZ.
4. Pole length *H*: antenna record's measured height + the equipment record's vertical offset.
5. Down the pole. In local east/north/up at the phase centre, with
   *p* = −pitch, *r* = roll, *a* = −yaw:
   forward = *H* sin *p* cos *r*, right = *H* sin *r*, up = *H* cos *p* cos *r*;
   east = forward sin *a* + right cos *a*, north = forward cos *a* − right sin *a*.
   Without tilt, it's *H* straight down.

### Equipment (45) and antenna (46)

Equipment: `u8` 0, receiver type, a short serial, receiver serial, firmware
`f64`, antenna type, antenna short name, measurement method ("Bottom of quick
release"), antenna serial, `u16` antenna number, `u8` antenna method, `u8`,
tape adjustment, horizontal offset, vertical offset (`f64`s), …

Antenna: `u8` 0, measured height `f64`, `u8` measurement type, `u8`, `u32`
equipment record ID, ….

Reference (70): `u8` 0, base point name, `u32` antenna record ID, `KI`.

### Coordinate system

Payload offsets (after the 23-byte header):

- **Ellipsoid (36):** 3 semi-major axis, 11 flattening, 23 `i32` EPSG.
- **Projection (38):** 3 `u16` type (7 = Lambert2Parallel), 5 central latitude,
  13 central longitude, 21 scale, 29 false northing, 37 false easting,
  63 parallel 1, 71 parallel 2 (angles in radians). Project location height
  is 41 bytes from the end (the record is 2 bytes shorter before Access 26).
- **Datum (37):** 62 `i32` reference frame ID, 66 `i32` EPSG, 74 epoch,
  82 frame name, then displacement model name.
- **Horizontal adjustment (39):** 3 `u16` type (0 none, 1 PlaneAdjustment),
  then origin N, origin E, translation N, translation E, rotation (radians),
  scale.
- **Vertical adjustment (40):** 3 `u16` type (3 GeoidModel, 5
  GeoidModelAndInclinedPlane), origin N, origin E, slope N, slope E, constant,
  geoid file name (`g18us`), `i32` EPSG.
- **Coordinate system (87):** system, zone and datum names.
- **Corrections (41):** byte 16 is the Cogo distance setting (0 grid, 2 ground).
- **Units (51):** `u16`s from offset 1; distance and height 6 = US survey feet.
- **Kinematic transformations (216):** `u8` 0, `u32` count, then each: `u32`
  system ID, `u32` type (1 = 14 parameters), name, source, target, epoch, 16
  bytes, rotations X Y Z, translations X Y Z, scale, then their rates in the
  same order, 2 bytes.

## What the JOB doesn't have

Trimble Access computes these when it exports JobXML, and the JOB doesn't
store them:

- **Grid coordinates of measured points.** `src/job.ts` projects them with the
  job's projection and site calibration; they match JobXML to 0.1 mm.
- **Elevations of measured points.** These need the geoid model (GEOID18),
  which isn't in the job. They are left empty for now.
- **The combined scale factor.** Computed at the centre of the job's points
  and the project height. Trimble's location for it is somewhere else, so it
  differs by up to about 1 ppm.

## Still to work out

- Total station setups, backsights, observations and targets.
- What's in the 7 bytes after description 1, using a point with description 2.
- Enum values not in the samples: other projections, units, methods.
- How a deleted point that's been re-measured with the same name behaves.
