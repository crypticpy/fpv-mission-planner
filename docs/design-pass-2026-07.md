# Design pass — July 2026

Simulated-pilot feedback review targeting the cinematic FPV community flying
aftermarket/self-built quads (GEPRC, iFlight, custom builds — not the DJI
drone ecosystem, though DJI O4 air units are assumed). Four independent
reviews: a beginner cinewhoop pilot (~4 months, phone-at-the-park), an
intermediate multi-rig pilot (~2.5 years, plans weekend shoots at named
spots), an advanced long-range pilot (6+ years, self-welded Li-Ion, mountain
lines, reads blackbox logs), and a principal-architect pass over the codebase
for modularity, portability, and the planned add-your-own-drone feature.

Everything below is synthesized from those four reports, deduplicated, and
ordered by consensus and dependency.

---

## 1. What already earns trust — do not lose these

Every reviewer independently called these out as strengths. They are the
product's voice; new features must inherit them.

- **Terminal-energy discharge integration.** `dischargeSim()` integrates
  delivered energy at the pack terminals with IR loss excluded — the
  difference between a real model and an eCalc-style `mAh × Vnom` toy.
- **Sag-limited vs energy-limited as an explicit outcome**, with warnings
  written in pilot language ("the pack is the limiter, not the energy").
- **Honest uncertainty labeling**: `estimated:` arrays on packs,
  `confidence` on propulsion, derated C-ratings ("label claim is 385 A" →
  `maxContA: 80`), measured-not-claimed dry masses, the README's
  calibration-anchors table and "Honest limitations" section. The advanced
  reviewer: *"a calculator that volunteers its own limitations has earned
  enough credit to be worth auditing."*
- **80 m wind instead of 10 m surface wind** — the single most
  pilot-correct data decision in the app (currently under-explained in UI).
- **The map footprint on real imagery** — all three pilots rated it the
  best screen in the app and the first thing that made sense.
- **Weather/scenario decomposition** (where vs how-you-fly), with
  well-judged burn multipliers.

---

## 2. Defects found (fix before any new features)

Concrete bugs, all small, several found independently by multiple reviewers:

1. **`app.js:432` — wind-sensitivity chart uses `compatibleBatteries().slice(0, 4)`.**
   Catalog order, so the *selected* pack may be silently absent from the
   chart. Always include the selected pack, pinned first. (Found by 2
   reviewers independently.)
2. **Warnings are unreachable on the Map tab.** `update()` early-returns
   after `renderMapView()`; `#warnings` lives inside hidden `#view-dash`.
   Sag/cold-pack/gust warnings vanish on exactly the view a pilot has open
   at the field. Render warnings into a host visible from both views.
3. **The "Burn" column averages out/back Wh/km** (`(out + back) / 2`,
   app.js:417). The home leg into wind is the only one that can strand you;
   averaging it away is actively misleading. Show the out / back split and
   headline the worse leg. (Advanced reviewer: "the worst single thing in
   the UI.")
4. **`liftEnvelope()` mislabels the limiting component when sag binds.**
   `sagCurrentA` participates in `min(...)` but the classification never
   tests it, so a cold high-IR pack reads "motor limited." ~10-line fix,
   and it's wrong precisely in the cold-weather case where the label
   matters most.
5. **Battery footnote leaks variable names** — renders
   `irPackMilliOhm, maxContA are estimated` verbatim. Map keys to English
   before display.
6. **Silent battery swap on drone change.** Changing drones silently
   replaces an incompatible pack with `batts[0]` (the smallest). Announce
   it: "NAV 5000 doesn't fit the Cinelog — switched to GNB 550."
7. **The zero-radius state looks like a crash.** A slow scenario + wind
   above that scenario's airspeed zeroes the mission ("—" everywhere) while
   Lift margin still says VIABLE. Say which lever to move: *"At 11 mph you
   can't get home against a 14.5 mph headwind — fly faster or plan a
   shorter hop."* One string turns "the app is broken" into "oh, I see."
8. **Bare `setItem` in `saveCustomBattery`/`saveCustomManufacturer`**
   throws uncaught on quota/Safari-private (unlike `saveMapState` directly
   above them). Two-line fix.
9. **`node --test tests/` fails on Node 24** — the documented invocation is
   broken; the glob form works. Add `package.json` with
   `"test": "node --test tests/*.test.mjs"` and a 3-line CI workflow (there
   is no CI at all today).
10. **Dashboard render cost: ~130+ full `planMission` calls per input
    event** (wind-sensitivity 64, speed-tradeoff ~54, shoot-out 1/pack) —
    none pass `lite: true` or `_pCache`, the fast paths that already exist
    and are pinned bit-identical by tests. Measured: 20.7 ms → 3.9 ms per
    update. Four lines. Do this **before** user-added packs multiply the
    loop.

---

## 3. The convergent big three

All three pilot personas, independently, ranked the same three gaps at or
near the top:

### 3.1 No go/no-go verdict

The question every pilot opens the app with — *"can I fly this, here,
now?"* — is never answered. The pieces all exist in the `planMission`
result (`flight.code`, warnings, gust-vs-vMax, radius, time). Add a verdict
card above everything: **GO / CAUTION / NO-GO**, one sentence of why, one
sentence of what to change. Beginner phrasing: "CAUTION — 12 gusting 19 at
flying height is a lot for a 300 g cinewhoop. Stay low, cut a minute off
your timer." Advanced variant: a margin number ("you're at 78% of the
envelope").

### 3.2 Nothing persists

Only theme, map viewport, and custom batteries survive a reload. Drone,
battery, payload, scenario, reserve, units — the entire control surface —
resets every session, which costs ~6 of the ~12 taps in the field flow.
Persist the whole `state` (all-or-nothing; half-restored state is worse
than none).

### 3.3 The location lie

On first load the app shows a green **Live** dot and confident wind numbers
— for downtown Austin, without ever saying so (`DEFAULT_LAUNCH`,
weather.js:5). A pilot anywhere else reads someone else's wind as their
own. The beginner reviewer called it "the most dangerous thing in the first
session." Fix: print the place ("Live weather for Austin, TX — default
location"), put a one-tap "use my location" in the Weather rail (not
buried on the Map tab), and consider prompting for geolocation on boot.

---

## 4. Information architecture — the right things up front

### 4.1 Reorder around the pilot's actual decision order

Current rail: Aircraft → Weather → Mission. Actual planning order:
**Where → When → Which rig → Which pack → How I'm flying.** The launch
point — the input that drives weather, elevation, wind direction, and the
footprint — currently lives only as a click target on the other tab. Spot
selection belongs at the top of the flow.

### 4.2 Progressive disclosure (Beginner / Full toggle)

One switch that hides: disc loading, density altitude (auto-promote when
the model flags it), power-vs-airspeed, cruise trade-off, mission profile
voltage chart, the 16-column table, parallel packs, manual airspeed,
theoretical-best cruise mode. The physics stays; the wall of it goes. The
beginner reviewer could read 4 of 8 tiles; the advanced reviewer's
would-never-use list was nearly identical — the difference is beginners
bounce and experts skim.

### 4.3 Vocabulary pass

Every UI term got a hide / rename / explain verdict from the beginner
review (full table in that report; highlights):

- "Landing reserve" → "Battery left when you land," with the LiPo-care
  rationale.
- "Scenario" → "How are you flying?" — and show the resulting speed
  *before* selection, since this dropdown can zero the plan.
- Show mAh alongside Wh everywhere pilot-facing ("580 of 720 mAh usable").
- "(80 m)" → explain: "wind at flying height — roughly double what you
  feel on the ground." Two-number tile: surface / aloft.
- Wind direction gets compass letters: "170° (S)".
- Tiles renamed in plain speech ("Hover endurance" → "If you just
  hovered"; AUW → "Total weight with battery").

### 4.4 Field mode

The 30-second parking-lot flow (all three personas described the same
one): open → it remembers the rig → it knows where you are → verdict card
→ three numbers (wind, flight time, stay-within radius) → one line of
advice → ring on the map → pocket. Concretely: a stripped mobile-first
view of verdict + timer + wind + ring + warnings, with everything else
below a "More detail" fold. The mobile shell shipped in July solves
layout; this solves scope.

### 4.5 Timers and clocks, not just distances

- Turnaround timer in mm:ss matched to the OSD ("Timer 5:30 — start home
  at 2:45"), land-voltage note.
- Time-to-home from the turnaround (`radiusKm / legBack.vg`) — computed
  today, never shown.
- Clock-driven plan: "launch 20:04 → turn 20:19 → land 20:34, sunset
  20:41." Cinematic flying is golden-hour flying; the app never mentions
  time of day.

---

## 5. Feature roadmap

Phased by dependency and consensus value. Phases 0–1 are UX payoff on the
existing architecture; Phase 2 is the enabling refactor; Phase 3 is the
headline feature; Phase 4 is depth.

### Phase 0 — defects + quick wins (all S effort)

Everything in §2, plus:
- Persist `state` (§3.2).
- Location honesty (§3.3).
- `package.json` + CI.

### Phase 1 — field workflow release

- Go/no-go verdict card (§3.1).
- Turnaround timer + time-to-home + clock plan (§4.5).
- **Hourly + daily forecast and sunset/golden hour.** The single biggest
  planning unlock and it is nearly free: `weather.js` already calls the
  keyless Open-Meteo endpoint with `current=`; `hourly=`, `daily=`,
  `sunrise,sunset` ride the same request. A time scrubber makes
  "Thursday-night planning for Saturday" possible at all — today the app
  can only describe a flight happening right now, and the preset dropdown
  is labeled "for future planning" as an apology.
- **Saved spots.** Named list (lat/lng, cached elevation, notes, per-spot
  default loadout), replacing today's single destructive pin. The
  intermediate reviewer's #1 missing feature; also enables "which of my
  spots is flyable Saturday."
- Surface/aloft wind pair, compass letters, vocabulary pass (§4.3).
- Beginner/Full toggle (§4.2).
- Session planner: "4 × GEPRC 720 → ~22 min total, plan 90 min with
  charging." Uses numbers already computed per pack.
- PWA: manifest + service worker (app shell + last weather payload) and
  **self-hosted fonts** (Google Fonts is currently a render-blocking
  third-party request on a tool used at trailheads with one bar of LTE).

### Phase 2 — extensibility core (the enabling refactor, §7)

Registry + versioned storage + schema-driven forms + app.js decomposition.
No user-visible features, but Phase 3 is impossible without it — a custom
drone today produces a verified `TypeError` crash (see §7.2).

### Phase 3 — add-your-own-drone + calibration (the headline)

Custom drone CRUD, class templates, computed pack compatibility,
export/import, and calibrate-from-a-real-flight (§6). Also per-pack
instances (cycle count, measured IR) and the predicted-vs-actual drift
view.

### Phase 4 — model and map depth (advanced wish list, ordered)

1. **Speed-dependent profile-power term** (`P0·(1 + k·μ²)`), refit against
   the same Oscar Liang anchors. The current flat `etaProp` biases the
   best-range speed fast and its Wh/km low — the direction that leaves a
   pilot short into a headwind. Fix together with the induced-velocity
   tilt term it currently masks.
2. **Get-home reserve in Wh, not percent.** Percent-of-pack scales
   backwards (43 Wh reserve on a 6S2P, 2.5 Wh on an 850). Reserve should
   be: Wh to fly home from the turnaround at worst-case wind + a fixed
   hunt-and-land allowance. All ingredients exist in `planMission`.
   Headline output: "reserve holds to an 18 mph headwind."
3. **Pack temperature separate from air temperature** (pilots preheat
   packs; the model currently can't represent the #1 cold-weather
   mitigation), and note the cold-Li-Ion table is a low-rate curve with no
   self-heating — the model under-predicts climb-out sag and over-predicts
   steady-state penalty.
4. **Expose the gust factor** (currently a hardcoded, invisible 0.35) and
   label the 10 m-gust-on-80 m-mean mismatch.
5. **Terrain elevation profile along the outbound bearing** (Open-Meteo
   elevation API takes coordinate arrays): feeds true density altitude at
   the turnaround, AGL sanity, and —
6. **RF/LOS footprint clipping**: Fresnel-zone clearance at 2.4 GHz /
   900 MHz over the terrain profile; draw "energy OK, link blocked"
   regions. The energy ring alone overstates reachability for exactly the
   pilots most likely to trust it.
7. **Waypoint/dogleg routes** — flip the solver from "solve radius" to
   "given a polyline, integrate Wh and report margin." The physics
   (`legVecsFromCourse`) already handles arbitrary bearings. Changes the
   tool's identity from calculator to planner; pairs with a shot-list /
   segment concept (orbits and loiter-at-range are currently
   inexpressible — "how long can I hold station 300 m out in this wind" is
   a top-three cinematic question).
8. **Exportable mission brief** (footprint image, coords, bearings, Wh
   budget, turnaround clock — the thing you send a spotter).
9. Multi-altitude wind profile (10/80/120/180 m, same API call).
10. Adaptive footprint sweep refinement near the collapse boundary
    (5° linear interp currently smooths over the cliff where wind becomes
    unbeatable).

---

## 6. Add-your-own-drone + calibration design

The consensus across all three pilot levels, in one sentence: **nobody can
type `etaProp` or `cdA`, everybody can fly a pack and report what
happened — so class templates make the form completable and flight
calibration makes it true.**

### 6.1 Form design principles

- **Zero required physics fields.** Required: name, class, dry mass
  (measured, "no pack no camera" — with a weigh-ready-to-fly helper that
  subtracts the named pack, because beginners will weigh with the battery
  in), prop diameter, rotor count, cell count. Everything else defaults
  from the class template with a visible "class default — log a flight to
  calibrate" badge.
- **Class templates**: 2" whoop / 3" cinewhoop / 3.5–4" / 5" freestyle /
  7" LR / 10"+ cinelifter, each carrying `etaProp`, `cdA`, `avionicsW`,
  speeds, S-range, and sanity ranges. The two calibrated built-ins
  (Cinelog30 0.37/0.018, MOZ7 0.55/0.042) anchor the table; the rest is
  labeled interpolation.
- **"Like a Cinelog30, but…"** — clone-and-edit from any existing drone.
  Covers most of the cinewhoop market (near-clones of each other).
- **Advanced entry honored**: direct `cdA`/`etaProp` fields behind an
  Advanced fold; optional pasted thrust table that overrides the
  momentum-theory lift ceiling (the model's shakiest inversion); per-cell
  IR at a stated temperature; a confidence dropdown per source
  (measured / datasheet / estimated) mirroring the existing `provenance`
  discipline.
- **Soft validation, hard cross-checks.** Warn-don't-block on class ranges
  (people build weird things), but compute and show derived cross-checks:
  implied hover throttle, disc loading, W/kg, pack Wh/g, implied C-rating.
  A pack claiming 0.4 Wh/g is a typo, and the README already documents
  catching exactly that class of error in a storefront listing.
- **Live effect while typing** ("296 g → 5:54; +30 g → 5:29") — teaches
  the physics with zero vocabulary.
- Battery form gains a **`fits` multi-select / computed compatibility**
  (today `fits: [state.droneId]` is hardcoded — a shared 6S 1300 must be
  entered twice), and drops the mandatory manufacturer-registration
  detour (free-text brand, dedupe behind the scenes).

### 6.2 Calibration — the feature all three personas ranked first

The math is tractable and mostly closed-form (verified against
physics.js): `etaProp` appears exactly once in `powerAtSpeed`, as a pure
divisor, so given average power it solves in one division; average power
from "flew X min, landed at Y%" needs one ~8-line `dischargeToSoc` sibling
of `dischargeSim` plus a monotone bisection. Two entry types keep it
honest:

1. **Hover test** (CdA drops out) → pins `etaProp`.
2. **Cruise leg** (with `etaProp` pinned) → solves effective `cdA`.
   With only one flight, hold `cdA` at the class default and say so; when
   two flights at different speeds exist, fit both and tell the pilot what
   flight to go fly next ("log a cruise above 45 mph to separate drag from
   efficiency").

Tier-1 entry is 30 seconds from the OSD and charger: pack, flight time,
mAh-back-in (better than the OSD's SoC guess), distance, scenario, wind
(prefill from Open-Meteo historical for the timestamp — don't make anyone
remember). Rules that keep trust:

- **Never silently apply a fit.** Show `etaProp 0.55 (catalog) → 0.51
  (yours, 7 flights, ±0.02)` with a toggle.
- **Confidence gating**: 1 flight — show, don't use; 3 — offer; 5+ across
  two speeds — default on, show the band.
- **Clamp to class ranges and refuse absurd solutions** with a physical
  reason ("this implies η = 0.91 — check pack capacity and landed %"): a
  worn pack or wrong mass otherwise silently poisons the airframe.
- **Drift chart** (actual vs predicted Wh/km per flight, residual-vs-speed
  view) — a tool that shows its own historical error wins the argument
  against a pilot's gut; a bare number never does. Once residuals exist,
  the hero becomes a band: "8.4 mi (7.9–8.8, from your 11 flights)."
- The masthead's "calibrated against logged flights" claim must become
  per-airframe — true for built-ins, earned per custom rig.

Free test: round-trip `planMission` output through `solveEtaProp` and
assert recovery of the known 0.55 / 0.37 to 1e-3 — the whole feature
verified against the model's own ground truth, no measured data needed.

### 6.3 Sharing

JSON export/import of `{drones, batteries, flightLogs?}` with a schema
version. Import never overwrites (collide → new id, show a diff, validate
everything as untrusted); provenance and flight-count survive the trip so
a stranger's hand-typed `etaProp 0.62` is distinguishable at a glance from
one backed by 11 logged flights. A shared library of *calibrated*
airframes is the thing no spec-sheet calculator can ever have — and the
likely growth loop in the LR/cinematic community. Strip coordinates and
timestamps from exports by default.

---

## 7. Architecture plan

### 7.1 Verdict: stay build-less

3,066 lines of first-party JS, one vendored dependency, tests running bare
`node --test` against production source. The no-build property is
load-bearing; a bundler buys nothing here. A `package.json` with only
`{"type":"module","scripts":{"test":"node --test tests/*.test.mjs"}}` is
not a build step and should exist today. If types beckon later: JSDoc +
`// @ts-check` + `tsc --noEmit` in CI.

### 7.2 The hard blocker

`compatibleBatteries()` filters on each battery's hardcoded
`fits: ['moz7v2' | 'cinelog30v3']` list. A user-defined drone matches
nothing → `battery()` is `undefined` → **`planMission` throws a raw
`TypeError`** (reproduced two ways in review). Custom drones cannot ship
before compatibility becomes a computed predicate:

```
explicit fits pin wins → else connector ∩ drone.power.connectors,
sMin ≤ s ≤ sMax, massG ≤ maxPackMassG
```

Critically, compatibility must **not** encode lift — `liftEnvelope`
already reports WILL NOT FLY honestly, and a too-heavy pack should appear
in the list wearing that label, not silently vanish. Secondary hardening:
`planMission` returns a handled `no_battery` code instead of throwing.

### 7.3 Target layout and refactor order

Current state: `app.js` (747 lines) is the everything-hub — state, 54 DOM
ids, 7 render functions, both forms; `data.js` (674) mixes catalogs with
localStorage persistence (which is why `weather.js` imports a catalog
module to learn the map pin — the one layering inversion). `physics.js`,
`units.js`, `charts.js`, `themes.js`, `shell.js` are already clean;
`themes.js` is the working proof of the registry pattern (add a preset
object, it appears in the UI).

Target: `catalog/*` (split literals), `store.js` (namespaced `fpv:v1:*`
keys, versioned, migrating the 4 legacy keys, every write try/caught),
`schema.js` + `registry.js`, `forms.js` (descriptor-driven; the battery
form regenerates from ~40 lines and the hand-written HTML/FormData
string-coupling is deleted), `calibrate.js`, `state.js`, `render/*`
(dashboard, comparison, controls, shared dom helpers), leaving `app.js`
≈ 200 lines of wiring.

Order (S/M = effort): **0.** package.json + CI + repo hygiene (S) →
**1.** store.js (S) → **2.** catalog split + dom dedupe (S) →
**3.** schema + registry + computed compatibility (M, *the unblocker*) →
**4.** forms.js proven on the existing battery form (M) → **5.** drone
CRUD (M) → **6.** export/import (S) → **7.** calibrate.js (M) →
**8.** carve app.js renders (M, interleave anytime after 2) →
**9.** lite/_pCache perf fix (S, do immediately) → **10.** persist state
(S, do immediately).

### 7.4 Anti-goals

No accounts, no backend, no database (sharing is a file, later a URL
fragment; a serverless KV endpoint only if strangers actually publish
rigs). No framework, no bundler. Don't generalize the physics to
non-multirotor airframes — refuse rather than emit fake numbers. No
background auto-tuning of `etaProp` — calibration is explicit,
inspectable, deletable. No per-field unit pickers (one conversion path).
Don't build a motor/prop thrust-curve database — the pasted thrust table
is the right escape hatch.

### 7.5 Test additions

`registry.test.mjs` (merge precedence, compatibility truth table, and a
pin that `compatible()` never hides a pack for lift reasons),
`schema.test.mjs` (descriptor completeness, template-filled drone
validates, parse∘serialize identity), `store.test.mjs` (Map-backed
localStorage stub, migration, corrupt JSON, quota), `calibrate.test.mjs`
(the round-trip recovery test), `import-export.test.mjs` (version
upgrade/rejection fixtures), plus a handled-error pin for the missing-
battery path.

---

## 8. Hosting: Pages now, Vercel at a named trigger

Migration cost is genuinely ~10 minutes and stays flat: every path is
relative, no server code, no env vars, vendored Leaflet is a plain ESM
import, Open-Meteo is CORS-open. Nothing couples to the host in either
direction.

**Move when the first of these fires:**
1. **Per-branch preview URLs** — the likeliest and nearest trigger given
   the parallel `codex/*` branch workflow; compare a physics change
   against production side-by-side on a phone.
2. A real endpoint is wanted (community rig short-links, keyed weather
   provider, tile proxy).
3. Response headers Pages can't set (CSP, cache-control).

Do regardless of host: **self-host the fonts** (removes the only
render-blocking third-party request). Note for a future CSP: inline styles
are currently unavoidable (themes, charts, Leaflet transforms), and the map
adapters (`leaflet-adapter.js`, `scene3d/scene.js`) hold the codebase's only
`innerHTML` uses.

---

## 9. De-emphasis list (consensus "would never use")

Not deletions — relocations and defaults:

- **Manufacturer admin form** → out of the rail, into a settings/manage
  view; free-text brand on the battery form ("I want to add a battery, not
  model a supply chain").
- **30-entry camera list** → a grams field + 4 presets + drag class
  (HERO11 vs HERO12 differ by 0 g; case/mount choices the list can't
  express differ by 30 g). Keep the catalog data; stop making it the
  primary path.
- **Theme picker** → out of the masthead's prime slot (it currently
  outranks every planning control).
- **Wind particles** → persistent toggle (they burn phone battery at a
  trailhead to convey one scalar).
- Disc loading, density altitude tiles → behind the detail fold;
  density altitude auto-promotes when the model flags it.
- "Theoretical best range" leaves the cruise selector (stays as the
  dashed map ring, where it's honest context).
- 16-column table → sortable, selected-pack-highlighted, with Wh/g and
  Wh/$ derived columns; beginner view collapses it to Pack / Minutes /
  Distance / Price.

---

## 10. Session/repo notes (July 29, 2026)

- Reviews conducted at `codex/color-system` = `85a35d7` (includes the
  parallel session's parallel-battery/lift-envelope work, pushed to the
  branch remote but **not yet deployed to main**). Tests 17/17.
- Local `main` is stale (8 behind origin) — reset it opportunistically.
- Deployed site as of this doc: `313c05c` (mobile/tablet shell).
