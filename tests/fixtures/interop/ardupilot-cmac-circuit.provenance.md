# ardupilot-cmac-circuit.waypoints

**Source**:
[`https://github.com/ArduPilot/ardupilot/blob/master/Tools/autotest/Generic_Missions/CMAC-copter-circuit.txt`](https://github.com/ArduPilot/ardupilot/blob/master/Tools/autotest/Generic_Missions/CMAC-copter-circuit.txt),
fetched byte-for-byte through the GitHub contents API. ArduPilot flies this
mission in its own SITL autotest suite, so it is a file the firmware's authors
maintain rather than one a ground station happened to write.

**Retrieved**: 2026-07-31.

**What it demonstrates**: the whole `QGC WPL 110` shape at once.

- Row 0 is home, in `COORD FRAME` 0 (`MAV_FRAME_GLOBAL`, above sea level) with
  `COMMAND` 16 and an altitude of 584.08 m — the launch elevation of Canberra
  Model Aircraft Club field, and the reason this adapter reads row 0's altitude
  as AMSL and refuses to fabricate one on export.
- Rows 1–5 are in frame 3 (`MAV_FRAME_GLOBAL_RELATIVE_ALT`) at 20 m, which is
  what ArduPilot Copter uses for waypoint altitude.
- Row 1 is `MAV_CMD_NAV_TAKEOFF` (22) and row 6 is `MAV_CMD_DO_JUMP` (177) —
  two commands this planner does not model, so importing this file exercises
  the aggregate "dropped rows" loss rather than the happy path.
- Every row carries `CURRENT WP` = 0, including row 0. Mission Planner writes 1
  there (see `qgroundcontrol-missionplanner.waypoints`), so the two fixtures
  together are the evidence that the column is a display flag and not a mission
  semantic — this adapter ignores it on import.
- Single tab separators, six decimal places on every float, and exactly one
  trailing newline, matching pymavlink's `"%u\t%u\t…\t%u\n"` writer.
