# qgroundcontrol-plan-example.plan

**Source**: QGroundControl's own developer guide, the Plan File Format page —
[`https://github.com/mavlink/qgroundcontrol/blob/master/docs/en/qgc-dev-guide/file_formats/plan.md`](https://github.com/mavlink/qgroundcontrol/blob/master/docs/en/qgc-dev-guide/file_formats/plan.md)
(published as
[`https://docs.qgroundcontrol.com/master/en/qgc-dev-guide/file_formats/plan.html`](https://docs.qgroundcontrol.com/master/en/qgc-dev-guide/file_formats/plan.html)).

**Retrieved**: 2026-07-31.

**Assembled, not copied.** The page documents the file in two adjacent JSON
blocks — the envelope, whose `"mission"` is shown as `{}`, and then the mission
object on its own. This fixture is those two blocks joined, with the mission
object dropped into the envelope's `"mission"` slot and the whole re-serialised
at the four-space indent Qt writes. Every key and every value is the page's;
nothing was added, removed or renamed.

**What it demonstrates**:

- The envelope's required key set: `fileType` `"Plan"`, `version` 1,
  `groundStation`, and all three of `mission`, `geoFence` and `rallyPoints` —
  the last two present and empty at their own `version` 2. A plan carrying only
  a mission is rejected by QGC before its items are read, which is why this
  adapter always writes the empty fence and rally objects.
- The mission object's required `plannedHomePosition` as
  `[latitude, longitude, AMSL]`, `items`, and `firmwareType` (12 = PX4 here),
  alongside the optional `cruiseSpeed`, `hoverSpeed`, `vehicleType` and
  `globalPlanAltitudeMode`.
- A SimpleItem with all seven `params`, `params[3]` as `null` for "current
  heading mode", and the all-or-nothing altitude trio `AMSLAltAboveTerrain` /
  `Altitude` / `AltitudeMode`.
- **The inconsistency this adapter is built around.** The item carries
  `"AltitudeMode": 0` with `"frame": 3`. Frame 3 is
  `MAV_FRAME_GLOBAL_RELATIVE_ALT` — above home — while `AltitudeMode` 0 is
  QGC's `Mixed`, not its `Relative` (1), and the mission's own
  `globalPlanAltitudeMode` says 1. The two fields disagree inside the official
  example, so this adapter reads the MAVLink `frame` on import and treats
  `AltitudeMode` as display state: `frame` is the field the vehicle acts on.
- The single item is `MAV_CMD_NAV_TAKEOFF` (22), which this planner does not
  model — so importing this file is refused for having no waypoint this app can
  fly, rather than being silently read as an empty mission.
