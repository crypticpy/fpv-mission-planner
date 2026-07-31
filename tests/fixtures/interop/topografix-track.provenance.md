# topografix-track.gpx

**Source**: [`https://www.topografix.com/GPX/1/1/gpx.xsd`](https://www.topografix.com/GPX/1/1/gpx.xsd)
(the normative GPX 1.1 schema) plus the format overview at
[`https://www.topografix.com/GPX/1/1/`](https://www.topografix.com/GPX/1/1/).

**Retrieved**: 2026-07-31.

**What it demonstrates**: the `trk`/`trkseg`/`trkpt` import path — this
adapter's first-priority geometry source, per `gpxType`'s child sequence
(`metadata?, wpt*, rte*, trk*`) and `wptType`'s own element order (`ele`
before `name`, both optional). The file is hand-authored against the schema
rather than downloaded, since the schema does not ship a bundled sample; every
element, attribute name, and ordering here is taken directly from the XSD
`complexType` definitions for `gpxType`, `metadataType`, `trkType`,
`trksegType`, and `wptType`. Used by `importMission`'s "accept trk/trkseg/trkpt"
branch, and as the export round-trip fixture (this app's own writer produces
the same shape).
