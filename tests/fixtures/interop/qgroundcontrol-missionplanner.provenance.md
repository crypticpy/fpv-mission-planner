# qgroundcontrol-missionplanner.waypoints

**Source**:
[`https://github.com/mavlink/qgroundcontrol/blob/master/test/MissionManager/MissionPlanner.waypoints`](https://github.com/mavlink/qgroundcontrol/blob/master/test/MissionManager/MissionPlanner.waypoints),
fetched byte-for-byte through the GitHub contents API. It is the file
QGroundControl's own unit tests load to prove it can read what Mission Planner
writes, so it is Mission Planner's output as accepted by a second implementation.

**Retrieved**: 2026-07-31.

**What it demonstrates**: the conventions this adapter writes on export.

- `CURRENT WP` = 1 on row 0 and 0 on every row beneath it. ArduPilot's own
  autotest missions carry 0 everywhere (see `ardupilot-cmac-circuit.waypoints`),
  which is the disagreement behind this adapter's decision to write Mission
  Planner's shape and ignore the column when reading.
- Row 0 in frame 0 at 5.21 m AMSL — a home elevation near sea level, and a
  number no ground station could have invented.
- Rows 1–5 in frame 3 at 100 m, all `MAV_CMD_NAV_WAYPOINT`, with no takeoff and
  no jump: the plainest possible mission, and the closest thing in the wild to
  what this adapter emits.
- Row 0's parameters are written as bare `0` while later rows use `0.000000`,
  which is why the reader parses each column as a number rather than matching a
  fixed decimal shape.
