# inav-schema-sequential.mission

**Source**: INAV's published mission schema documentation, first sample file —
[`https://github.com/iNavFlight/inav/blob/master/docs/development/wp_mission_schema/README.md`](https://github.com/iNavFlight/inav/blob/master/docs/development/wp_mission_schema/README.md),
which sits beside the XSD it documents
([`mw-mission.xsd`](https://github.com/iNavFlight/inav/blob/master/docs/development/wp_mission_schema/mw-mission.xsd)).
Copied verbatim from the fenced block, including its indentation and its
`</missionitem>` closing tags. The file was written by `impload`.

**Retrieved**: 2026-07-31.

**What it demonstrates**:

- The document shape: a `<mission>` root with no attributes of its own, a
  `<version value="2.3-pre8">` **child element**, an optional `<mwp>` carrying
  the planner's map state, then `<missionitem>` elements.
- `<mwp>`'s `home-x="0" home-y="0"` — this format's way of saying no home was
  set. It is why this adapter treats a zero home as absent and falls back to the
  first waypoint, and why an import always reports the launch point as
  approximate.
- `alt="50"` as **whole metres**: the Configurator divides its internal
  centimetres by 100 on save and `parseInt`s them back on load, so 50 here is
  50 m and not 0.5 m.
- `parameter3="0"` on every item — bit 0 clear, so these altitudes are relative
  to home rather than above sea level.
- **Three missions in one file**, delimited by `flag="165"` on items 3, 9 and
  10, with `no` numbered sequentially 1–10 across the whole file. This is the
  multi-mission form the documentation describes, and importing it exercises
  this adapter's rule: take the first mission, warn that the others were left.
- A `JUMP` item (no 9) at `lat="0" lon="0"` — an action with no position, and
  one this planner does not model.
