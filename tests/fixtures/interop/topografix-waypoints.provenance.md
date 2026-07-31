# topografix-waypoints.gpx

**Source**: [`https://www.topografix.com/GPX/1/1/gpx.xsd`](https://www.topografix.com/GPX/1/1/gpx.xsd),
`gpxType`'s `wpt*` children (0 or more bare waypoints directly under the
root, per the schema's `metadata?, wpt*, rte*, trk*` sequence) and `wptType`'s
optional `ele`.

**Retrieved**: 2026-07-31.

**What it demonstrates**: the third-priority "bare wpt list" import path —
a file with no `trk` and no `rte`, just a sequence of `wpt` points at the
root, which some waypoint-only exports produce. It also demonstrates the
"one point never got an elevation logged" case (the second `wpt` has no
`<ele>`), which exercises `importMission`'s aggregate loss for waypoints that
default to 80 m above launch rather than a fabricated MSL figure.
