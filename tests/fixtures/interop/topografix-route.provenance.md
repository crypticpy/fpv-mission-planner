# topografix-route.gpx

**Source**: [`https://www.topografix.com/GPX/1/1/gpx.xsd`](https://www.topografix.com/GPX/1/1/gpx.xsd),
the `rteType` `complexType` (child order `name?, cmt?, desc?, src?, link*,
number?, type?, extensions?, rtept*`, `rtept` reusing `wptType`).

**Retrieved**: 2026-07-31.

**What it demonstrates**: the `rte`/`rtept` fallback path — what
`importMission` reads when a file has no `trk` at all, which is how some
route-planning tools (as opposed to track-logging ones) write GPX. `rtept`
elements are `wptType`, identical in shape to a `wpt` or `trkpt`, so this
fixture exercises the adapter's second-priority branch with the same
`lat`/`lon`/`ele` reading logic as the track path.
