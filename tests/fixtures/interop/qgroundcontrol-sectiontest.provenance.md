# qgroundcontrol-sectiontest.plan

**Source**:
[`https://github.com/mavlink/qgroundcontrol/blob/master/test/MissionManager/SectionTest.plan`](https://github.com/mavlink/qgroundcontrol/blob/master/test/MissionManager/SectionTest.plan),
fetched byte-for-byte through the GitHub contents API. It is the only `.plan`
file in QGroundControl's repository, and it is a real one: QGC's mission
manager tests load it.

**Retrieved**: 2026-07-31.

**What it demonstrates**: a plan written against the *older* item schema, kept
here as the file this adapter must refuse rather than misread.

- The envelope passes every check the current format asks for — `fileType`
  `"Plan"`, `version` 1, `groundStation`, `mission`, `geoFence`, `rallyPoints`
  — so nothing at the top level warns a reader that the items beneath are of a
  different generation.
- `geoFence` is `{ "polygon": [], "version": 1 }`, not the current
  `{ circles, polygons, version: 2 }`.
- Each item carries a `coordinate` array and only **four** `params`, where the
  current schema puts latitude, longitude and altitude into `params[4..6]` of
  seven. A reader that trusted `params[4]` here would read a plan's coordinates
  out of fields that do not exist.
- So the import of this file fails on the item schema, with the parameter count
  named in the error. That refusal is the behaviour under test: a mission
  planner that half-reads an obsolete file is worse than one that declines it.
