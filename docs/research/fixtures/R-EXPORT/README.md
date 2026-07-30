# R-EXPORT fixtures — QGroundControl `.plan` samples

Two small, real `.plan` files pulled from official MAVLink-ecosystem repositories
(not hand-written), used to ground the QGC section of `docs/research/R-EXPORT.md`
against actual on-disk JSON rather than only the prose docs.

## `mavsdk-example-mission.plan`

- **Source repo:** [`mavlink/MAVSDK-Python`](https://github.com/mavlink/MAVSDK-Python)
  (BSD-3-Clause), path `examples/example-mission.plan`
- **Retrieved from:** `https://raw.githubusercontent.com/mavlink/MAVSDK-Python/main/examples/example-mission.plan`
- **Commit:** `a254e5bbfdde2a1161acb2163b98290124d251c8` (2024-05-23)
- **Retrieved:** 2026-07-30
- **Why this one:** matches the *current* documented schema exactly —
  per-item `Altitude` / `AltitudeMode` / `AMSLAltAboveTerrain` fields (not the
  older `coordinate`-array encoding), plus `globalPlanAltitudeMode` at the
  mission level. Contents: takeoff → 3 waypoints → RTL, with 2 rally points
  and no geofence. All items use `frame: 3` (`MAV_FRAME_GLOBAL_RELATIVE_ALT`)
  and `AltitudeMode: 1` (`AltitudeFrameRelative`).

## `qgc-SectionTest.plan`

- **Source repo:** [`mavlink/qgroundcontrol`](https://github.com/mavlink/qgroundcontrol)
  (Apache-2.0), path `test/MissionManager/SectionTest.plan`
- **Retrieved from:** `https://raw.githubusercontent.com/mavlink/qgroundcontrol/master/test/MissionManager/SectionTest.plan`
- **Commit:** `760b6d968d7df711329597c296986c01a017cae` (2024-02-17)
- **Retrieved:** 2026-07-30
- **Why this one:** a real unit-test fixture from QGC's own `MissionManager`
  test suite, useful specifically because it is an **older/alternate
  encoding** — each `SimpleItem` carries a single `coordinate: [lat, lon,
  alt]` array instead of the current `Altitude`/`AltitudeMode`/
  `AMSLAltAboveTerrain`/`params[…z]` split, and it has no
  `globalPlanAltitudeMode` at all. It demonstrates schema drift across QGC
  versions: an adapter reading arbitrary "QGC .plan" files in the wild must
  tolerate both encodings. It also contains a `command: 205`
  (`MAV_CMD_DO_MOUNT_CONTROL`, `frame: 2`) item — a legacy gimbal/camera
  mount-pointing command (superseded by `MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW`
  / `MAV_CMD_DO_SET_ROI_*` in current MAVLink), useful evidence that camera
  aim has always ridden along in the mission item list as a `DO_*` command,
  not as a first-class "subject geometry" concept.

Both files are unmodified except for whitespace exactly as fetched; no
content was authored by hand. Both repos' licenses (BSD-3-Clause,
Apache-2.0) permit redistribution of these small test/example files with
attribution, which this README provides.
