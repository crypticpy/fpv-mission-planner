# R-EXPORT — interoperability format research (GPX, KML, QGC .plan, MAVLink/ArduPilot WPL, INAV)

Research pass for the mission planner's interoperability milestone: exporters/importers
for GPX, KML, QGroundControl `.plan`, ArduPilot/MAVLink waypoint (WPL), and INAV.
Every adapter must report semantic loss instead of silently dropping meaning, so this
doc's job is to pin down, per format, exactly what is exact, what degrades, and what
is simply not expressible — against official docs and repositories only.

**Retrieved:** 2026-07-30, except where a fixed commit/version is cited (each format
section states the exact commit SHA or doc version pulled). No secondary sources
(blogs, forums, Wikipedia) were used for normative claims; forum links that turned up
in searches were used only to find the right official page, never quoted.

## Our mission semantics (the row headings)

Per the task brief, this is what the compiler's internal representation carries and
what every adapter is graded against:

1. **Waypoint altitude value** — stored MSL-normalized (AMSL), regardless of how it
   was authored.
2. **Authored altitude reference** — which frame the pilot actually typed the number
   in: launch-relative, AGL (terrain-relative), or MSL directly.
3. **Per-segment (leg) speed** — a speed that applies to one leg of the route, not
   the whole mission.
4. **Hold duration** — an authored "stay here for N seconds" instruction.
5. **Intent** — transit / reveal / orbit / hold / pass / return.
6. **Return policy** — what happens at the end of the mission or on failsafe (direct
   RTL, retrace, landing pattern, rally-point choice).
7. **Reserve policy** — the energy/battery margin the mission is planned against
   (this app's `rHome` / pack-care floor logic in `js/route.js`).
8. **Camera/subject geometry** — gimbal aim, region-of-interest, or orbit-around-a-point
   framing.

Context: the app's current route model (`js/route.js`) is a flat lat/lng dogleg with
no altitude, no per-leg speed, and no intent field yet — this matrix is for the
interoperability milestone's *target* IR, not a description of what exists today.

---

## 1. QGroundControl `.plan` (JSON)

**Sources:**
- [Plan File Format — QGC Guide](https://docs.qgroundcontrol.com/master/en/qgc-dev-guide/file_formats/plan.html) (rendered docs, `master` branch of the docs site)
- [`qgc-dev-guide/en/file_formats/plan.md`](https://github.com/mavlink/qgc-dev-guide/blob/master/en/file_formats/plan.md) — same content, fetched as raw markdown for exact field tables
- [`src/QmlControls/QGroundControlQmlGlobal.h`](https://github.com/mavlink/qgroundcontrol/blob/master/src/QmlControls/QGroundControlQmlGlobal.h) — `mavlink/qgroundcontrol`, commit `003228b944d5` (2026-07-30), for the `AltitudeFrame` enum (not documented in prose anywhere)
- [MAVLink Common message set](https://mavlink.io/en/messages/common.html) for `MISSION_ITEM`/`MAV_CMD`/`MAV_FRAME`, cross-checked against `mavlink/mavlink` `message_definitions/v1.0/common.xml`, commit `92c81a5ff753` (2026-07-29), dialect version `3`

**Structure:** top-level JSON object `{fileType: "Plan", version: 1, groundStation, mission, geoFence, rallyPoints}`. `mission.version` is currently `2`; `mission.items` mixes `SimpleItem` (one `MISSION_ITEM`: `command`, `frame`, `params[7]`, `autoContinue`, `doJumpId`, plus display fields `Altitude`/`AltitudeMode`/`AMSLAltAboveTerrain`) and `ComplexItem` (`survey`, `CorridorScan`, `StructureScan`, each wrapping many `SimpleItem`s). `plannedHomePosition` is `[lat, lon, AMSL-altitude]` — home is always stored AMSL regardless of the plan's other altitude modes.

**Altitude reference — the actual enum (not in the prose docs):**
```
AltitudeFrameMixed            = 0  // "used by global altitude frame for mission planning" (no single mode)
AltitudeFrameRelative         = 1  // MAV_FRAME_GLOBAL_RELATIVE_ALT — relative to home/launch
AltitudeFrameAbsolute         = 2  // MAV_FRAME_GLOBAL — AMSL
AltitudeFrameCalcAboveTerrain = 3  // absolute altitude above terrain, calculated from terrain data
AltitudeFrameTerrain          = 4  // MAV_FRAME_GLOBAL_TERRAIN_ALT — AGL
AltitudeFrameNone             = 5  // distance unrelated to ground (e.g. distance-to-structure)
```
This is a genuinely 1:1 match to our three-way reference (launch-relative → `Relative`, AGL → `Terrain`, MSL → `Absolute`), set both per-item (`AltitudeMode`) and mission-wide as a default (`globalPlanAltitudeMode`).

**Speed:** no per-leg speed field on a waypoint item. Speed changes are `MAV_CMD_DO_CHANGE_SPEED` (id 178) `SimpleItem`s inserted into the sequence — persistent until overridden, per MAVLink's own description ("the value persists until it is overridden or there is a mode change"). Mission-wide defaults (`cruiseSpeed` for fixed-wing/VTOL, `hoverSpeed` for multirotor) exist but are single scalars, not per-leg.

**Camera/ROI:** the documented `ComplexItem` vocabulary is only `survey` / `CorridorScan` / `StructureScan` (photogrammetry footprint/overlap framing via `CameraCalc`) — no ROI or gimbal complex item type exists. The underlying MAVLink vocabulary does have real "look at a point" primitives (`MAV_CMD_DO_SET_ROI_LOCATION` id 195, `MAV_CMD_DO_SET_ROI_WPNEXT_OFFSET` id 196, `MAV_CMD_DO_SET_ROI_NONE` id 197, and the deprecated `MAV_CMD_DO_MOUNT_CONTROL` id 205 with `MAV_MOUNT_MODE` `GPS_POINT`/`SYSID_TARGET`/`WPNEXT_OFFSET`), and any of these are legal as a plain `SimpleItem` (see the `qgc-SectionTest.plan` fixture, which contains a `command: 205` mount-control item) — they're just not one of QGC's three named complex-item types.

**Documentation inconsistency worth flagging:** the dev-guide's own worked JSON examples disagree with its own prose about current version numbers — the `Survey` example shows `"version": 4` while the prose table says "current version is 3"; `CorridorScan`'s example shows `"version": 2` while the prose says "current version is 3"; the polygon-geofence item example shows `"version": 1` while its prose row says "the documented version is 2." An adapter should trust the JSON examples (they're presumably kept in sync with the actual QGC source) over the stale prose.

**Fixtures pulled** (see `docs/research/fixtures/R-EXPORT/README.md` for full provenance): `mavsdk-example-mission.plan` (current schema, from `mavlink/MAVSDK-Python`) and `qgc-SectionTest.plan` (an older `coordinate`-array encoding, a real `qgroundcontrol` unit-test fixture) — the two differ enough to demonstrate the schema has drifted across QGC versions, which any importer needs to tolerate.

---

## 2. MAVLink Mission (Plan) Protocol + ArduPilot `QGC WPL110` waypoint file

**Sources:**
- [Mission (Plan) Protocol — MAVLink Guide](https://mavlink.io/en/services/mission.html)
- [File Formats — MAVLink Guide](https://mavlink.io/en/file_formats/) (`QGC WPL110` text format spec)
- [MAVLink Common message set](https://mavlink.io/en/messages/common.html), cross-checked directly against `mavlink/mavlink` `message_definitions/v1.0/common.xml` (raw XML, dialect version `3`, commit `92c81a5ff753`, 2026-07-29) for exact `MAV_CMD` parameter tables — the rendered HTML page truncates before the command tables in a plain fetch, so the XML source was pulled directly.

**`QGC WPL110` file format** (plain text, tab-separated, used by ArduPilot- and PX4-compatible tools):
```
QGC WPL <VERSION>
<INDEX>\t<CURRENT WP>\t<COORD FRAME>\t<COMMAND>\t<PARAM1>\t<PARAM2>\t<PARAM3>\t<PARAM4>\t<X/LATITUDE>\t<Y/LONGITUDE>\t<Z/ALTITUDE>\t<AUTOCONTINUE>
```
One line per `MISSION_ITEM`; `<COORD FRAME>` is the `MAV_FRAME` value (see below), `<COMMAND>` the `MAV_CMD` id. This is a strictly poorer container than the QGC `.plan` JSON — no mission-level metadata (no default speed, no home-position altitude declared anywhere but line 0), no geofence/rally block, no complex items — it's the raw `MISSION_ITEM` list and nothing else.

**`MAV_FRAME` values relevant to altitude reference** (from `common.xml`, current — the plain `_GLOBAL*` variants without `_INT` are now canonical; the `_INT` variants were superseded 2024-03 and only remain for `COMMAND_INT`/`MISSION_ITEM_INT` wire encoding, not semantics):
| Value | Name | Altitude reference |
|---|---|---|
| 0 | `MAV_FRAME_GLOBAL` | AMSL |
| 3 | `MAV_FRAME_GLOBAL_RELATIVE_ALT` | relative to home position (launch-relative) |
| 10 | `MAV_FRAME_GLOBAL_TERRAIN_ALT` | AGL ("altitude at ground level") |

This is the same three-way split as QGC's `AltitudeFrame` enum (QGC's enum literally documents each value against the matching `MAV_FRAME`), so — same verdict as QGC: an exact match for our reference concept, at the wire-protocol level.

**Relevant `MAV_CMD` entries, exact param tables pulled from `common.xml`:**

| Command | id | Params (1–4, then lat/lon/alt) |
|---|---|---|
| `MAV_CMD_NAV_WAYPOINT` | 16 | P1 Hold time (s, "time to stay at waypoint for rotary wing"); P2 Accept radius (m); P3 Pass radius (m, 0=pass through, sign=CW/CCW orbit direction); P4 Yaw (deg) |
| `MAV_CMD_NAV_LOITER_UNLIM` | 17 | P3 Radius (m, sign=direction); P4 Yaw |
| `MAV_CMD_NAV_LOITER_TURNS` | 18 | P1 turns; P2 heading-required flag; P3 radius; P4 xtrack behavior |
| `MAV_CMD_NAV_LOITER_TIME` | 19 | P1 loiter time (s); P2 heading-required; P3 radius; P4 xtrack behavior |
| `MAV_CMD_NAV_RETURN_TO_LAUNCH` | 20 | all params empty |
| `MAV_CMD_NAV_LAND` | 21 | P1 abort altitude; P4 yaw |
| `MAV_CMD_NAV_TAKEOFF` | 22 | P1 min pitch; P4 yaw |
| `MAV_CMD_NAV_SPLINE_WAYPOINT` | 82 | P1 hold time |
| `MAV_CMD_NAV_DELAY` | 93 | P1 delay (s, -1 enables time-of-day fields); P2–4 hour/min/sec UTC |
| `MAV_CMD_DO_JUMP` | 177 | P1 target sequence number; P2 repeat count |
| `MAV_CMD_DO_CHANGE_SPEED` | 178 | P1 speed type (enum `SPEED_TYPE`: airspeed/groundspeed/climb/descent); P2 speed (m/s, -1=no change, -2=reset to default); P3 throttle % |
| `MAV_CMD_DO_LAND_START` | 189 | marks/selects a landing-pattern sequence; lat/lon/alt select which pattern if several exist |
| `MAV_CMD_DO_SET_ROI_LOCATION` | 195 | lat/lon/alt of a fixed camera/gimbal region-of-interest |
| `MAV_CMD_DO_SET_ROI_WPNEXT_OFFSET` | 196 | pitch/roll/yaw offset, ROI = next waypoint |
| `MAV_CMD_DO_SET_ROI_NONE` | 197 | cancel ROI |
| `MAV_CMD_NAV_RALLY_POINT` | 5100 | lat/lon/alt of an alternate RTL point |

`MAV_MISSION_TYPE` separates the mission proper (`MISSION`=0) from `FENCE`=1 and `RALLY`=2 — rally points are a distinct protocol-level list, not mission items, matching QGC's separate `rallyPoints` block.

**Verdicts, in brief (see matrix below for the full grid):** hold duration and intent-adjacent geometry (pass-radius, loiter radius+direction, loiter-turns) are native `MAV_CMD` parameters — this is the *richest* of the five formats for orbit/pass/hold geometry, because it's the protocol QGC's own vocabulary is built on. Speed is the same "insert a `DO_CHANGE_SPEED` item" pattern as QGC. Reserve policy is nowhere in the mission/WPL data — it lives in ArduPilot vehicle parameters (`FS_BATT_*`/`BATT_*`), entirely outside any mission file.

---

## 3. INAV (`inav-configurator` mission XML + MSP)

**Sources:**
- [INAV Missions — `iNavFlight/inav` wiki](https://github.com/iNavFlight/inav/wiki/INAV-Missions)
- [MSP Navigation Messages — `iNavFlight/inav` wiki](https://github.com/iNavFlight/inav/wiki/MSP-Navigation-Messages) — this page, not the Missions page, has the actual field-by-field parameter table and a full annotated XML example
- Source code, `iNavFlight/inav-configurator`, `master` branch:
  - [`tabs/mission_control.js`](https://github.com/iNavFlight/inav-configurator/blob/master/tabs/mission_control.js) `loadMissionFile`/`saveMissionFile` (commit `28a3f66f6607`, 2026-06-14) — ground truth for the XML shape, since no formal schema/XSD is published
  - [`js/mwnp.js`](https://github.com/iNavFlight/inav-configurator/blob/master/js/mwnp.js) (commit `74aa440074c5`, 2024-12-05) — the `WPTYPE` enum and the `P3` altitude-reference bit, with source comments
  - `package.json` at `master` reports app version `9.1.1`

**File format:** XML, root `<mission>`, produced with `xml2js` (`Builder({rootName: 'mission', ...})`). No public XSD; the shape is whatever `inav-configurator`'s save function emits, cross-checked against the wiki's own annotated example (both agree):
```xml
<?xml version="1.0" encoding="utf-8"?>
<mission>
  <version value="2.3-pre8"/>
  <missionitem no="1" action="WAYPOINT" lat="54.353319318038153" lon="-4.5179273723848077"
               alt="35" parameter1="0" parameter2="0" parameter3="0"></missionitem>
  ...
</mission>
```
(`version value` is `"4.0.0"` instead when the file holds a multi-mission set; a `<mwp cx=.. cy=.. home-x=.. home-y=.. zoom=..>` element carries map-view state, not mission semantics; `<fwapproach>` elements carry fixed-wing landing-approach geometry, out of scope here.)

**`WPTYPE` action enum** (`js/mwnp.js`): `WAYPOINT=1, POSHOLD_UNLIM=2, POSHOLD_TIME=3, RTH=4, SET_POI=5, JUMP=6, SET_HEAD=7, LAND=8`.

**Parameter semantics per action** (from `mission_control.js`'s own `dictOfLabelParameterPoint` comment block, corroborated by the wiki's table):

| Action | parameter1 | parameter2 | parameter3 |
|---|---|---|---|
| `WAYPOINT` | **Speed (cm/s)** — leg speed, an INAV extension for multirotors: "the speed on the leg terminated by the WP" | — | Altitude-mode & action bits |
| `POSHOLD_TIME` | **Wait time (s)** — hold duration | Speed (cm/s) | Altitude-mode & action bits |
| `RTH` | Force-land if non-zero | — | — |
| `JUMP` | Target WP # | Repeat count (-1 = infinite) | — |
| `SET_HEAD` | Heading (deg) | — | — |

**Altitude reference — only a binary flag, per `MWNP.P3`:**
```
P3 bit 0 = ALT_TYPE : 0 = relative to home altitude, 1 = absolute (AMSL)
P3 bits 1-4 (INAV 6.0+) = user Action 1-4 (logic-programming framework hooks)
```
No AGL/terrain-relative concept exists at the waypoint level (`waypointCollection.js`: `let useAbsoluteAlt = (waypoint.getP3() & (1 << 0))` — literally a single bit). The wiki is explicit that INAV navigates against **GPS AMSL, not WGS84-ellipsoid height** — a useful confirmation that "MSL" in INAV means the same thing our compiler means by MSL-normalized.

**Speed — the standout finding:** `WAYPOINT.parameter1` is a genuine first-class per-leg speed value (cm/s) — the *only* one of the five formats where per-segment speed is a declarative field on the waypoint itself rather than a separate stateful command inserted into the sequence.

**Camera/subject-lock:** `SET_HEAD` (nose/heading pointer) and `SET_POI` (orient toward a lat/lon point until cleared — "Once SET_HEAD or SET_POI is invoked, it remains active until cleared by SET_HEAD with a P1 value of -1") are INAV's subject-lock primitives, comparable in *intent* to MAVLink's `DO_SET_ROI_LOCATION`. But INAV's `SET_HEAD`/`SET_POI` steer aircraft yaw, not a decoupled gimbal — there's no separate gimbal-pitch channel, and (per the "Intent" analysis below) no per-waypoint orbit-radius parameter at all, so "orbit around subject at radius R" cannot be expressed even approximately.

**Other real findings from the wiki (MSP-Navigation-Messages page):**
- Mission max size: **60 waypoints** (validated against the download after upload).
- "FlyBy Home" waypoints (INAV 4.0+): a WP with lat/lon = 0 or `flag == 0x48` resolves to the *arming-time* home position at mission-execution time, not a fixed authored coordinate — relevant if our IR ever wants a "return-relative waypoint."
- `flag == 0xA5` marks the last waypoint of a (sub-)mission in multi-mission files.
- MSP transport exists (`MSP_WP`/`MSP_SET_WP` per the wiki, referenced generically as "MSP Navigation Messages") for uploading a parsed mission to the FC — confirmed to exist, not itself a file format.
- JUMP validation rules are enforced by INAV pre-arm (first item can't be JUMP, can't jump to adjacent WPs, can't jump beyond the list, can only jump to geo-referenced WP types) — useful constraints for our own JUMP-emitting adapter to respect if we ever emit loops.

---

## 4. GPX 1.1 (topografix.com)

**Sources:**
- [GPX 1.1 Schema Documentation](https://www.topografix.com/gpx/1/1/)
- [`gpx.xsd`](http://www.topografix.com/GPX/1/1/gpx.xsd) — the normative XSD, fetched directly

**Structure relevant to a mission:** `rteType` (`rte` → ordered `rtept*`, each `wptType`) is the closest analog to an authored flight plan; `trkType` (`trk` → `trkseg*` → `trkpt*`, also `wptType`) is a recorded/played-back path. Both point types are the *same* `wptType`: `lat`/`lon` attributes (required, `latitudeType`/`longitudeType`, decimal degrees, **WGS84 datum**, per the XSD's own documentation strings), then optional children `ele` (decimal, meters), `time` (`dateTime`), `magvar`, `geoidheight`, `name`, `cmt`, `desc`, `src`, `link`, `sym`, `type`, `fix`, `sat`, `hdop`/`vdop`/`pdop`, `ageofdgpsdata`, `dgpsid`, and a generic `extensions` element (`##other` namespace, `processContents="lax"`) as the schema's sanctioned escape hatch for anything non-core.

**`<ele>` — no declared vertical datum.** The XSD's documentation string for `ele` is only *"The elevation (in meters) of the point"* — no mention of MSL vs. WGS84-ellipsoid height anywhere in the 1.1 schema or its documentation. This is a real interoperability hazard for us specifically: our IR's altitude is MSL-normalized, but GPX gives no structural way to *declare* that, so a GPX consumer has no schema-level guarantee our numbers mean the same thing its own numbers mean (many real-world GPX producers write raw GPS ellipsoidal height into `<ele>`, others write MSL — the format is silent).

**No speed, no course, no per-point action.** The 1.1 `wptType` has no `speed`/`course` element (present informally in some GPX 1.0-era producers, dropped from the 1.1 core schema entirely) and no command/action vocabulary of any kind — `wptType` is pure geometry plus optional descriptive text. `rteType` itself has no time or ordering semantics beyond point order.

**`geoidheight`** does exist as an optional element ("Height of geoid ... above WGS84 ellipsoid, as measured along the gravity vector") — notable because it's evidence the GPX authors were aware of the MSL-vs-ellipsoid distinction, yet chose not to make `ele`'s own reference frame declared; `geoidheight` is just the correction *offset*, not a flag saying which one `ele` uses.

---

## 5. KML (OGC / Google for Developers)

**Sources:**
- [KML Reference — Google for Developers](https://developers.google.com/kml/documentation/kmlreference) (the de facto normative reference; KML itself is an OGC standard, OGC 12-007r2/KML 2.3, but Google's reference is the actively maintained document for the `gx:` extension namespace this analysis needs)
- [Altitude Modes — Google for Developers](https://developers.google.com/kml/documentation/altitudemode)

**Coordinates:** `<coordinates>` is `lon,lat[,alt]` (note the order — longitude first), decimal degrees, WGS84 implicit.

**`altitudeMode` / `gx:altitudeMode`** on `Placemark` geometries (`Point`, `LineString`, etc.):
| Mode | Meaning |
|---|---|
| `clampToGround` (default) | altitude value ignored |
| `relativeToGround` | meters above the ground *at that point* |
| `absolute` | meters above sea level, "regardless of the actual elevation of the terrain" |
| `gx:relativeToSeaFloor` | meters above the sea floor (or ground, if over land) |
| `gx:clampToSeaFloor` | ignored, clamps to sea floor |

This gives KML a real, declared reference-frame concept (unlike GPX) — `absolute` maps to MSL, `relativeToGround` maps to AGL. But `relativeToGround` is *per-point ground-relative*, not relative to a single fixed launch elevation — over sloped terrain this diverges from our "launch-relative" semantic at every waypoint after the first, so it's a degraded (not exact) match for that specific one of our three reference tags.

**`gx:Track`** (Google Earth 5.2+ extension) — the closest KML gets to an authored, ordered, timed path with per-point attributes:
```xml
<gx:Track id="ID">
  <altitudeMode>clampToGround</altitudeMode>  <!-- or gx:altitudeMode -->
  <when>...</when>            <!-- one per sample, kml:dateTime -->
  <gx:coord>...</gx:coord>    <!-- "lon lat alt", no commas, one per sample -->
  <gx:angles>...</gx:angles>  <!-- "heading tilt roll" in degrees, one per sample -->
  <Model>...</Model>
  <ExtendedData><SchemaData schemaUrl="...">
    <gx:SimpleArrayData kml:name="...">
      <gx:value>...</gx:value>  <!-- one per sample; custom per-point fields (e.g. a speed column) live here -->
    </gx:SimpleArrayData>
  </SchemaData></ExtendedData>
</gx:Track>
```
`<gx:angles>` is explicitly documented as heading/tilt/roll "for each time/position within the track" for the Model/icon being animated — a real per-point orientation vector, i.e. exactly the shape of "camera aim," but it orients *the tracked object itself* (a Model), not a decoupled gimbal, and it's a Google Earth visualization feature, not a value any GCS or flight controller consumes. Custom per-point data (e.g., a speed column) is possible only via the non-standard `ExtendedData`/`gx:SimpleArrayData` escape hatch, index-aligned to the `gx:coord`/`when` arrays — not a first-class field, and the docs note explicitly this exists so *Google Earth* "displays a graph of elevation and speed profiles" (i.e., speed is normally *derived* from position+time, not authored).

**`LookAt`** (an `AbstractView`, used for camera framing when *viewing* a KML file) has `longitude`/`latitude`/`altitude`/`heading`/`tilt`/`range` — structurally identical to "orbit around a subject point at a given range and camera angle." It is tempting to reuse this shape for our own orbit/subject-geometry concept, but it is inert to every one of our real targets: it tells a KML *viewer* (Google Earth) where to point its virtual camera when looking at the file, not a flight controller or GCS where to point a real gimbal or fly a real orbit. Any reuse of `LookAt`'s numeric shape in an export is cosmetic, not operational.

No hold-duration, no per-leg speed, no return/reserve concept anywhere in the spec.

---

## Field-by-field semantic matrix

| Our semantic | QGC `.plan` | MAVLink / WPL110 | INAV | GPX 1.1 | KML |
|---|---|---|---|---|---|
| **Altitude value** (MSL-normalized) | **Exact** — `AltitudeFrameAbsolute` stores true AMSL directly; other modes still resolve to AMSL via home position | **Exact** — `MAV_FRAME_GLOBAL` (0) is literal AMSL; `RELATIVE_ALT`/`TERRAIN_ALT` require home/terrain data to recover MSL but don't lose it | **Exact** if `P3` bit0=1 (absolute/AMSL); relative mode needs home altitude to recover MSL. Docs confirm INAV's AMSL = GPS AMSL, matching our definition | **Degraded** — `<ele>` is a bare meters value with **no declared vertical datum** in the schema at all; round-trips numerically but datum is a guess | **Degraded** — `absolute` altitudeMode is explicitly "relative to sea level," a real declared reference, but the geoid model used isn't specified by the spec |
| **Authored reference** (launch-rel / AGL / MSL) | **Exact** — `AltitudeFrame` enum has all three (`Relative`, `Terrain`, `Absolute`), per-item and mission-default | **Exact** — `MAV_FRAME_GLOBAL` / `_RELATIVE_ALT` / `_TERRAIN_ALT` is the same three-way split, per mission item | **Degraded** — only a 2-way flag (relative-to-home vs. absolute); no AGL/terrain concept at the waypoint level at all | **Lost** — no reference-frame field or attribute exists anywhere in the schema | **Degraded** — `relativeToGround`≈AGL and `absolute`≈MSL exist, but `relativeToGround` is per-point ground height, not a single fixed launch datum, so it drifts from "launch-relative" over sloped terrain |
| **Per-segment speed** | **Degraded** — via a `MAV_CMD_DO_CHANGE_SPEED` item inserted before the leg; persists until overridden, not a per-leg field | **Degraded** — identical mechanism (`DO_CHANGE_SPEED`, id 178); same persistence caveat | **Exact** — `WAYPOINT.parameter1` is literally "speed (cm/s) for the leg terminated by this WP," a first-class per-leg field | **Lost** — no `speed`/`course` in 1.1's core `wptType` (dropped from 1.0); only recoverable via non-standard `extensions` | **Lost** — no native speed field on `LineString`/`gx:Track`; only smuggleable via non-standard `gx:SimpleArrayData`, and even then it's per-point not per-leg |
| **Hold duration** | **Exact** — `MAV_CMD_NAV_WAYPOINT` P1 (hold time, rotary wing) or `NAV_LOITER_TIME` P1 (loiter time) | **Exact** — same commands/params, it's the same protocol | **Exact** — `POSHOLD_TIME.parameter1` = wait time in seconds | **Lost** — no dwell/duration concept; `<time>` is a recorded timestamp, not an authored instruction | **Lost** — `<when>`/`TimeSpan` describe when a feature is/was visible to a *viewer*, not "stay here N seconds" for an unflown mission |
| **Intent** (transit/reveal/orbit/hold/pass/return) | **Degraded** — several map to distinct `MAV_CMD`s (pass-radius on `NAV_WAYPOINT`, `LOITER_TURNS`/`TIME`≈orbit, `RETURN_TO_LAUNCH`≈return) but there is no authored intent *field*; "reveal" has no analog at all | **Degraded** — identical reasoning (same command vocabulary) | **Degraded**, and weaker than QGC/MAVLink — `WAYPOINT`≈transit/pass, `POSHOLD_*`≈hold, `RTH`≈return, but **no orbit-radius concept exists at all** at the waypoint level, and "reveal" has no analog | **Lost** — no command/action vocabulary whatsoever; only unstructured `name`/`desc` text as an escape hatch | **Lost** — same as GPX; `name`/`description` are free text only |
| **Return policy** | **Degraded** — `MAV_CMD_NAV_RETURN_TO_LAUNCH`/`DO_LAND_START` + a separate `rallyPoints` block place *where*, but the triggering policy/threshold lives in vehicle parameters, never in the plan file | **Degraded** — identical: RTL item + `MAV_MISSION_TYPE_RALLY` list exist in-protocol; policy is firmware config outside any mission file | **Degraded**, and more fragile — `RTH` action exists, but the wiki documents that multi-RTH continuation behavior itself changed across INAV versions, so even the in-file semantics aren't stable | **Lost** — no return/failsafe concept; a return-to-launch is just another indistinguishable waypoint if authored manually | **Lost** — same as GPX, no failsafe semantics in the spec |
| **Reserve policy** | **Lost** — battery/energy failsafe thresholds are vehicle parameters (e.g. `COM_LOW_BAT_ACT`), entirely outside the `.plan` file | **Lost** — same; ArduPilot's `FS_BATT_*`/`BATT_FS_*` params, not mission/WPL data | **Lost** — INAV's low-voltage failsafe is a CLI/Configurator setting (`vbat_*`), not part of the mission XML | **Lost** — not a GPX concept | **Lost** — not a KML concept |
| **Camera/subject geometry** | **Degraded** — real primitives exist at the protocol level (`DO_SET_ROI_LOCATION`/`_WPNEXT_OFFSET`/`_NONE`, deprecated `DO_MOUNT_CONTROL`) usable as plain `SimpleItem`s, but QGC's own 3 named complex-item types (survey/corridor/structure scan) don't include one — must be composed by hand from a loiter item (geometry) + an ROI item (aim) | **Degraded** — same primitives, slightly more flexible since raw MAVLink has no UI-vocabulary restriction; still requires composing geometry + aim from two separate items | **Degraded**, weaker still — `SET_HEAD`/`SET_POI` give yaw-level subject-lock (aircraft nose, not a decoupled gimbal), and (per Intent, above) no orbit-radius field exists to combine it with | **Lost** — no camera/gimbal/ROI concept anywhere in the schema | **Degraded**, unusually — `gx:angles` (heading/tilt/roll per point) and `LookAt` (lat/lon/alt/heading/tilt/**range**, i.e. orbit-around-a-point shape) both exist with the *right numeric shape*, but both are inert: they drive a KML *viewer's* virtual camera or an animated Model, not a real gimbal or flight path — reusing them is cosmetic only |

---

## Fixture provenance

Two real `.plan` files were pulled (full detail in `docs/research/fixtures/R-EXPORT/README.md`):

- `docs/research/fixtures/R-EXPORT/mavsdk-example-mission.plan` — `mavlink/MAVSDK-Python`, `examples/example-mission.plan`, commit `a254e5bbfdde2a` (2024-05-23). Current schema (`Altitude`/`AltitudeMode`/`AMSLAltAboveTerrain` split), takeoff → 3 waypoints → RTL, 2 rally points.
- `docs/research/fixtures/R-EXPORT/qgc-SectionTest.plan` — `mavlink/qgroundcontrol`, `test/MissionManager/SectionTest.plan`, commit `760b6d968d7df` (2024-02-17). Older `coordinate: [lat, lon, alt]` array encoding, no `globalPlanAltitudeMode`, includes a `MAV_CMD_DO_MOUNT_CONTROL` (id 205) item.

No INAV/GPX/KML fixtures were saved per the task's explicit fixture scope (QGC `.plan` only); the INAV wiki's own two annotated example missions (in `MSP-Navigation-Messages.md`) were read in full and are cited above by URL rather than copied, since they illustrate JUMP/POSHOLD_TIME/LAND behavior clearly in prose already.

---

## Decision impact — what the adapter-neutral IR must carry

1. **Altitude must be stored as (MSL value, authored-reference tag) as two separate fields, not one.** Every format that has *any* reference concept (QGC, MAVLink, INAV, KML) needs the tag on export to pick the right frame/mode constant; GPX needs neither but should still get the MSL number. Losing the tag (collapsing to "just a number") would make every export guess.
2. **Per-leg speed needs an explicit "how was this expressed" adapter contract**, because the mechanism differs by format in a way that affects *state*, not just syntax: INAV wants it as a field on the arriving waypoint; QGC/MAVLink want it as a separate stateful command inserted before the leg, which then persists forward until the next `DO_CHANGE_SPEED` or mission end — an adapter that doesn't model "persists until overridden" will silently apply the wrong speed to every leg after the one it meant to change.
3. **Intent should never be assumed round-trippable.** It's the least-supported semantic across every format: best case (QGC/MAVLink) it partially reconstructs from command *type* + params, but "reveal" has zero representation anywhere, and INAV can't even express "orbit" as geometry (no radius field). Any export of an "orbit"/"reveal" waypoint needs an explicit loss report, not a best-effort guess at a substitute command — and any *import* from these formats must never infer an intent tag it can't actually support (e.g., don't invent "orbit" from an INAV mission that has no orbit primitive to have produced one).
4. **Return policy and reserve policy are structurally different from every other row: they are not degraded, they are categorically absent from every mission-file format here.** All five formats keep failsafe/reserve behavior in vehicle-parameter space, never in the mission file. The IR should not try to force these into a per-format export field at all — the adapter's job for these two rows is entirely to *report the loss* (clearly, once, not per-waypoint) rather than attempt any encoding. This is a clean, confident finding, not a hedge: no further research will find a hidden field for these in any of the five formats.
5. **Camera/subject geometry needs a decomposed representation** (a location/point-of-interest + an optional orbit radius + an optional gimbal-vs-yaw distinction), because every format that supports it at all (QGC, MAVLink, INAV, KML) supports a *different subset* of that decomposition, and none of them has a single field matching our compound concept. Exporting it as one opaque blob would make every adapter's degradation unreportable at the necessary granularity (e.g., INAV can accept the point-of-interest but not the radius; QGC/MAVLink can accept both but only as two composed items, not one).
6. **QGC/MAVLink is the richest target for orbit/pass/hold geometry** (native pass-radius, loiter-radius+direction, loiter-turns, ROI location) — if the IR needs one format to validate its geometry model against first, this is it. **INAV is the richest target for per-leg speed** — the only format where it's a first-class field rather than a side-effecting command.
7. **Treat "current schema version" claims from any format's docs with one round of skepticism before hard-coding a version number.** Both QGC (survey/corridorScan version-number mismatches between prose and its own JSON examples) and INAV (no published XSD at all, version string embedded ad hoc as `"2.3-pre8"`/`"4.0.0"`) show the version identifier itself isn't fully reliable as a stable contract — validate against a real fixture, not just the stated version number.
