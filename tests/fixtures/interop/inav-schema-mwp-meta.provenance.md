# inav-schema-mwp-meta.mission

**Source**: INAV's published mission schema documentation, second sample file —
[`https://github.com/iNavFlight/inav/blob/master/docs/development/wp_mission_schema/README.md`](https://github.com/iNavFlight/inav/blob/master/docs/development/wp_mission_schema/README.md).
Copied verbatim from the fenced block. It was written by `mwp` (mwptools), a
second implementation of the same format.

**Retrieved**: 2026-07-31.

**What it demonstrates**: everything a tolerant reader has to survive.

- `<meta>` instead of `<mwp>`. The XSD declares `meta` in `mwp`'s substitution
  group, and the Configurator matches either name — so this adapter reads both.
- A **real** home in that element: `home-x="-3.2989342" home-y="54.5707123"`.
  `home-x` is longitude and `home-y` latitude, the same x/y sense as the
  `cx`/`cy` map centre, and this is the one place in the format a launch point
  can live. Importing this file takes its launch from there rather than from the
  first waypoint.
- A comment (`<!--mw planner 0.01-->`) inside the root element, and a nested
  `<details>` child of `<meta>` carrying `<distance>`, `<nav-speed>`,
  `<fly-time>` and `<loiter-time>` — vendor extensions no other tool writes.
  They are dropped, and named in one aggregate loss rather than silently.
- `version value="42"`, which is not a version any INAV release ships. The
  reader does not gate on it, because the element names and attributes are what
  carry the meaning here.
- The "reset numbering" multi-mission form: `no` restarts at 1 in each of the
  three segments, where `inav-schema-sequential.mission` numbers straight
  through. Both are documented as valid, which is why this adapter reads `no`
  as a label and takes its order from the document.
- `flag="0"` written explicitly on non-terminal items, where the first sample
  omits the attribute entirely.
