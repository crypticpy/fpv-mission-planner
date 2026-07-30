# FPV Mission Planner

A physics-based mission planner for our two quads — the **GEPRC MOZ7 V2 O4 Pro**
(7.5″ long range, 6S) and the **GEPRC Cinelog30 V3 O4 Pro** (3″ ducted cinewhoop,
4S). Pick a drone, battery, camera payload, and weather scenario; it computes
hover power from disc loading and air density, optimizes cruise speed per leg
against the wind, simulates the battery discharge with sag, and charts how far
out you can push before you have to turn around.

## Run it

```bash
python3 -m http.server 8321
```

Then open <http://localhost:8321>. No build step, no dependencies — plain ES
modules ([src/domain/physics.js](src/domain/physics.js), [src/data.js](src/data.js),
[src/charts.js](src/charts.js), [src/state.js](src/state.js), `src/render/*`,
[src/map.js](src/map.js), and [src/app.js](src/app.js) wiring them together).
The only third-party code is Leaflet 1.9.4, vendored
as an ES module in `vendor/leaflet/` so the app still needs no CDN or bundler.

### Tests

```bash
npm test
```

Or run the suite directly: `node --test 'tests/*.test.mjs'` — note the quoted
glob; the bare directory form fails on Node 24.

Use the single **Units** selector in the header to switch every displayed
distance, speed, wind, and distance-normalized burn rate between imperial
(`mi`, `mph`, `Wh/mi`) and metric (`km`, `km/h`, `Wh/km`). The physics model
keeps its native SI values; all display labels, conversions, and unit-specific
input ranges are centralized in [src/domain/units.js](src/domain/units.js).

### On a phone or tablet

The layout switches automatically below tablet-landscape width: the view tabs
become a bottom dock (Planner · Map · Loadout), and the control rail opens as a
bottom sheet from the Loadout button. Touch devices get bigger tap targets and
tap-to-inspect chart tooltips regardless of size — an iPad in landscape keeps
the desktop layout with touch-sized controls. No user-agent sniffing; it's all
CSS media queries (width for layout, `pointer: coarse` for ergonomics).

## Install it

The app is an installable PWA: on a phone or laptop, use the browser's "Add to
Home Screen" / "Install" prompt to get it as a standalone app icon, no app
store involved. A service worker ([sw.js](sw.js)) precaches the app shell —
HTML, CSS, JS, Leaflet, fonts, icons — so it still opens with no signal at the
trailhead, and it keeps the last fetched weather payload so a stale-but-real
forecast survives offline instead of nothing. Map tiles are never cached (the
providers' usage policies, and the footprint already renders without them);
they just won't load offline.

## The model

1. **Air density** — ISA barometric pressure at field elevation, Magnus vapor
   pressure from temp + humidity → humid-air density and density altitude.
2. **Rotor power** — momentum theory on total disc area (4 props): parasite drag
   `½ρ·CdA·V²` tilts the thrust vector, and the induced velocity is solved by
   fixed-point iteration against the *tilted* disc, so forward flight is split
   into the edgewise component that unloads the rotor and the perpendicular
   component that feeds it. On top of that sits a speed-dependent profile term
   `P₀·(1 + 4.65·µ²)`: blade drag rises with the square of edgewise advance
   ratio, so a nose-down dash costs real power that a flat efficiency hides. A
   single per-airframe efficiency `etaProp` folds figure of merit, motor/ESC
   losses, and *hover* profile drag; only the µ² excess above hover is modeled
   separately, from one constant fixed across all airframes (`PROFILE_MU2`,
   derived in `src/domain/physics.js` from typical quad solidity, blade Cd₀, and design
   lift coefficient — not a per-drone tuning knob). Both new terms are
   identically zero at hover, so hover power is unchanged and a hover-solved
   `etaProp` still means exactly what it always meant.
3. **Battery** — per-chemistry OCV curve (Li-Ion / LiPo / LiHV), constant-power
   discharge sim with internal-resistance sag (quadratic current solve), cold
   temperature capacity/IR derating, low-voltage cutoff under load. Sag can end
   the flight before the energy does — the tool warns when that happens. The
   temperature those curves read is the **pack's**, and that is not always the
   air's: by default they are the same number, because a pack that rode to the
   field in your bag is at air temperature, and ticking **Pack isn't at air
   temperature** in the Weather rail lets you say otherwise. Preheating packs is
   the one cold-weather move that really works and the model had no way to hear
   about it before; the same field says the opposite too, for packs still
   cold-soaked from a car left out overnight. Air temperature keeps setting air
   density either way, and the cold warning clears when the pack is warm — read
   the limitation below before you trust the size of the cold penalty.
4. **Lift envelope** — continuous battery current, pack sag, ESC limits, and
   published motor electrical limits cap the available rotor power. The model
   inverts hover momentum theory through the calibrated airframe efficiency to
   estimate static thrust at the current air density, then reports thrust-to-
   weight and rejects a mission below 1:1. Exact motor/prop thrust curves are
   not published for these aircraft, so lift limits are explicitly labeled
   **estimated** rather than presented as thrust-stand measurements.
5. **Mission** — planning wind = average + a share of the gust spread, set by
   **How much of the gusts to plan for** (default 35%, expert view only; the
   rail states the planning wind it produces). Be aware of what the blend
   mixes: Open-Meteo publishes gusts at 10 m only, while the sustained wind is
   read at your cruise altitude, so the spread is borrowed from lower air than
   the aircraft is in — the control's note says so, and the gust is floored at
   the sustained wind so it can never be reported below the air it rides on. **Weather** (place + season presets) is separate from the
   **scenario** (how you fly): each scenario sets a realistic cruise speed as a
   fraction of the airframe's calibrated hands-on cruise (MOZ7 ~40 mph,
   Cinelog ~20 mph) and a maneuvering burn multiplier (+5% steady cruise up to
   +40% cliff dives) on top of steady-flight power. Cruise speed modes:
   *Realistic* (default — the speed you'd actually fly), *Theoretical best
   range* (per-leg Wh-per-ground-km optimum — the ceiling, not a prediction),
   or *Manual*. Radius solves `usable energy = radius × (Wh/km out + Wh/km
   back)`, capped by whichever reserve binds first (below).
6. **Reserves** — two separate things, in the units that suit each.
   **Don't land below** (percent, your knob) is pack care: the state of charge
   you don't want to land under, because that is what wears cells.
   The **get-home reserve** is solved in Wh, not set: the energy to fly home
   from the turnaround on the return leg you might actually get — the planned
   return with the along-wind component turned adverse, at the planning wind —
   plus 90 seconds of hover power to find a spot and land. Because that
   allowance is a time, it scales with the aircraft instead of the pack: 4.5 Wh
   of a 108 Wh 6S Li-Ion, 0.95 Wh of a 12.6 Wh 4S 850, where a flat percentage
   gave the small pack the smaller cushion. The rail reports the result as a
   wind — "reserve holds to an 18 mph headwind" — and says which of the two
   reserves is the one shortening the mission.

## Parallel batteries

Enable **Run two identical packs in parallel** below the battery selector to
apply the loadout to the selected pack and every row in the battery shoot-out.
The electrical model keeps series voltage unchanged, doubles capacity and
continuous current capability, halves equivalent pack resistance, and doubles
the pack's effective parallel count. Weight includes both batteries plus an
airframe-specific harness/restraint allowance (20 g XT60 on MOZ7, 8 g XT30 on
Cinelog30); a conservative extra drag-area allowance is also applied.

Only parallel identical packs with the same chemistry, cell count, capacity,
age, condition, voltage, and state of charge. The checkbox models two copies of
the selected pack—it is not permission to connect mismatched batteries.

Lift status is carried through the hero, stat tiles, power and speed charts,
mission profile, battery comparison, wind sensitivity, and map footprint:

- **WILL NOT FLY** at or below 1.0:1 estimated continuous thrust-to-weight.
- **NO CONTROL MARGIN** below 1.3:1.
- **MARGINAL** below 2.0:1.
- **VIABLE** at 2.0:1 or better.

The 1:1 boundary is the estimated sustained-hover ceiling; it is not a safe
operating target. Gust recovery, climb, maneuvering, prop wash, pack aging, and
motor heating all require margin.

### Calibration anchors (real flights, not datasheets)

| Anchor | Source | Model check |
|---|---|---|
| MOZ7 V2: 843 g dry (measured, claim is 750 g) | Oscar Liang review | used as dry mass |
| MOZ7 V2: ~16 min / 15+ km, 6S 6000 Li-Ion, 15–20 mph wind | Oscar Liang review | `etaProp 0.55` / `cdA 0.042` reproduces it |
| MOZ7 V2: hover ~26–30% throttle, cruise 60–70 km/h, top ~110 km/h | Oscar Liang review | hover A and speed cap |
| Cinelog30 V3: 192 g dry (measured) | Oscar Liang review | used as dry mass |
| Cinelog30 V3: 8:10 claimed on 4S 720; 7–7.5 min real on 850 | GEPRC / Oscar Liang | `etaProp 0.37` / `cdA 0.020` reproduces both |
| NAV packs: 499 g / 975 g, cell DCIR 19.6 mΩ @25 °C → 76 mΩ @−20 °C, cold capacity curve | Lumenier INR21700-50SE factory test report | pack IR & Li-Ion temp tables |
| GNB 6S 5500/7000 70C XT60: 656/797 g | GNB product pages | capacity, mass, connector, and price |
| DIY500AMP 6S2P: EVE 40PL/50PL, Ampace JP40/JP50P1, Tenpower 50XG, Reliance RS50, LinkData 55P/65P | DIY500AMP pack and cell pages | cell capacity, weight, current limits, and IR bounds |
| GNB packs: 88 / 73 / 72 g confirmed; C-ratings optimistic brand-wide | Pyrodrone, WREKD, Oscar Liang | masses; derated `maxContA` |
| Cinelog30 packs: GNB 550, RDQ 650, GEPRC 720, Flywoo 750, Tattu 850 | manufacturer/dealer product pages | capacity, mass, chemistry, connector, and current price |

Fields marked `estimated:` in [src/catalog/batteries.js](src/catalog/batteries.js) had no published source
(mostly pack IR and true continuous current) — weigh your packs and measure IR
to tighten them. DIY500AMP does not publish finished weight or variant pricing,
so its recipes use the published weight of twelve cells plus a 55 g construction
allowance and the currently displayed $195 base price. Storefront Wh figures for
the NAV packs are typos (72/36 Wh); the real numbers are 108/216 Wh and that's
what the model uses.

## Map view

The **Map** tab draws the mission on real imagery. Click or drag to place the
launch point (persisted in localStorage), and the planner sweeps the wind model
across every outbound course to draw a **wind-shaped footprint**: the filled
polygon is the out-and-back turnaround envelope at your planned cruise, the
dashed ring is the theoretical best-range ceiling. Each weather preset carries a
`windFromDeg` (the meteorological "wind from" bearing, degrees clockwise from
true north) that orients the footprint; the dashboard's hero numbers still use
the relative wind-mode selector, and the "dashboard planning case" marker on the
range-vs-heading chart shows exactly where that case sits on the curve.

Read the footprint honestly: it is the **turnaround envelope** — fly out on a
course, turn around, come home — not general reachability. Because both legs
pay for the same wind, upwind and downwind reach are equal and the crosswind
axis is slightly longer; a dogleg route can beat the ring. Bearings the aircraft
can't make headway on collapse to the launch point.

The sweep samples every 5° off the wind axis and **refines itself where adjacent
rays disagree**, bisecting down to 0.625° across the edge of a collapsed sector
(up to 20 extra rays per ring, spent sharpest-first). Without it, the boundary
between "reachable" and "collapsed" is a 5° linear ramp that hands you reach on
headings the model says are dead. Smooth footprints — anything short of a
collapse — cost exactly the base 37 rays, so calm air pays nothing for this.

**Live weather is the default.** On load the planner fetches current conditions
at the launch point from [Open-Meteo](https://open-meteo.com/) (free, no key)
and shows what it's using in the weather rail; picking a preset (for future
planning) or editing any weather field drops out of live mode, and the Live
button — or the map's "Live weather here" — brings it back. Moving the launch
point while live refetches automatically. It uses **80 m wind** by default, not
the usual 10 m surface wind — FPV cruise happens at 30–120 m AGL, and surface
wind reads roughly half of what you'll actually fight up there. Gusts are only
published at 10 m, so treat the gust figure as a floor. Elevation comes from
Open-Meteo's 90 m digital elevation model. If the fetch fails you keep the last
values and can plan on presets.

The same request carries the whole **wind profile** — 10, 80, 120 and 180 m —
and the *Cruise altitude* selector (full detail mode) picks which level the plan
flies. Wind climbs with height, so the level you choose is a real difference in
range, not a caption: the rail names it, the forecast scrubber re-reads the hour
you're auditioning at that level, and the 10 m figure stays on screen beside it
because launch and landing happen in the surface wind whatever you cruise in.
Beginner mode pins it back to 80 m.

Animated **wind particles** drift across the map in the direction the air is
moving (the footprint's `windFromDeg` + 180°), faster in stronger wind. They're
a screen-space visualization, not a forecast field, and they disable themselves
under `prefers-reduced-motion`.

Base layers: Esri World Imagery (satellite — Source: Esri, Vantor, Earthstar
Geographics, and the GIS User Community) and OpenStreetMap streets
(© OpenStreetMap contributors). Tiles load from the providers' free endpoints;
the footprint still renders if tiles fail in the field.

**Routes** (full detail mode): the ring answers "how far out and straight
back", but real flights bend — out along a river, cut across to a ridge. The
*Route* button lets you drop waypoints into a polyline; each leg gets its own
wind decomposition, ground speed, time and Wh from the exact solver the
footprint uses, with the return flown direct from the last waypoint the way a
failsafe RTH would. The verdict checks the get-home reserve at **every**
waypoint and names the worst one — on a dogleg it's often not the farthest pin.
If the route fits, the panel says how long you can **loiter** at the end of it:
remaining energy over hover power, with the station-keeping-in-wind figure
beside it. The route and launch point live in the **mission document**, which
autosaves to the browser's own storage: both survive a reload, and moving the
launch keeps the waypoints where they are. The *Missions* fold on the planner
rail manages saved missions — rename, save a copy, reopen, delete, and export
or import as JSON files. The terrain chart and the link card still read the
plan's primary bearing, but every leg of the route is checked against its own
sampled ground — see *Ground under the whole route* below.

**Mission brief**: the button on the map card renders the whole plan as one
printable, phone-readable page — launch coordinates (decimal and
degrees-minutes for radio relay), a drawn north-up footprint plate with bearing
ticks, scale rings, wind arrow and the route if one exists, the Wh budget, the
cardinal-bearing reach table, the top warnings verbatim, a short checklist
derived from the plan's actual state, and the headline: the **turnaround
clock** — "if you're not turned around by this time on the timer, you're not
coming home with reserve." It forces black-on-white whatever theme you fly the
app in (sunlight is the enemy), and `Print / save PDF` is the browser's own
print dialog, so it works offline once the page is up.

## Terrain along the outbound leg

A mission over hill country climbs, and the model plans at one elevation. The
Map tab profiles the **ground under the outbound leg** — one batched Open-Meteo
elevation request, 28 samples along the course the plan actually flies (into the
wind, downwind, or the cross leg, whichever the relative wind mode says) — and
plans the air at the **turnaround**, not at the launch point. That is where the
thrust margin is thinnest and where a get-home has to start, so the density
altitude on the dashboard is the turnaround's.

The chart draws the ground against the altitude you said you'd cruise at, held
from the launch point (which is what an OSD altitude reading is), and a warning
fires when rising ground eats that clearance — *the ridge 4 km out is higher
than your cruise altitude*. A preset sky keeps its own elevation: if the rail
says 10,000 ft and the pin is in Austin, the profile is drawn but the plan stays
on the scenario you asked for. Offline, or anywhere the request fails, the
planner falls back to the launch elevation and everything else is unaffected.

## Ground under the whole route

The profile above looks along one bearing. A route that doglegs to a ridge and
back leaves the other legs unlooked-at, and "we didn't look" is not the same
answer as "it's clear". So the planner also samples a **corridor along every
segment** — stations down each leg plus a post 300 m either side of the track —
and runs four checks against what comes back:

- **Clearance.** How much air is under each leg, at that leg's own altitude.
  Rising ground that eats the margin is a warning; ground *above* the leg is a
  critical, and both name the segment and the sample where it happens.
- **Line of sight.** The same Fresnel geometry as the outbound card, per
  segment, so a leg the pilot cannot see is flagged even when the leg the ring
  was drawn on is clear.
- **Direct return.** From every waypoint, the flight home a failsafe would
  actually fly: the terrain on that straight line and the energy to cross it.
- **Air and wind at altitude.** Density is computed from each sample's own
  elevation and the temperature lapsed to it, and the wind is read at the height
  the leg flies rather than at whichever level the forecast happens to publish.

Anywhere the DEM has a hole — an unbuilt tile, a coastline — the affected
samples come back empty and the route carries a **stated unknown** for them.
That is deliberate and it is the rule the whole feature is built around: missing
ground is never quietly rendered as clear ground, and a leg over a data hole
reads as *nobody knows*, not as a pass.

Climb and descent are charged too, now that the legs have heights. A climb costs
the potential energy gained over drivetrain efficiency; a descent costs the
difference between a conservative descent-power policy and the cruise already
budgeted, and **never** returns energy to the pack. Both ends are deliberately
pessimistic — a planner that credits you for coming downhill is a planner that
sends you home short.

## Radio line of sight — "energy OK, link blocked"

The footprint ring is an *energy* answer: how far the pack can push and still
bring the aircraft home. It says nothing about whether you can still see through
the goggles when you get there, and over ground with a shape to it the link
quits first. On the same profile the planner now runs the radio: a ray from the
pilot's antenna (**1.5 m**, standing) to the aircraft holding its cruise
altitude, the **first Fresnel zone** around it, and the 4/3-earth curvature term.

Two thresholds, because they fail differently. The ray being cut by a ridge is
video gone. The ridge eating past ~40% of the first Fresnel radius — the
industry rule of thumb — is where the picture starts breaking up while the ray
still technically clears. The chart draws both: the line of sight, the *Fresnel
floor* (the highest the ground may be and still leave the zone clear), the
shaded wedge between them, and a marker at the range the link quits. The map
clips the outbound leg there — solid to the blockage, hairline past it — so the
"energy OK, link blocked" stretch is visible as the part of the leg you can fly
to but not see from.

A **Video / control link** select (expert) picks the band: 5.8 GHz (the O4's
high band, the default — it's the video you fly by), 2.4 GHz, or 900 MHz for US
ELRS control. Watch which way the physics runs: the Fresnel radius grows as √λ,
so the *lower* band has the *fatter* zone and flags first geometrically — which
is not the same as the control link failing first, since 900 MHz also has the
diffraction behaviour and the link budget to work through an intrusion that has
already killed the video. The card and the warning quote all three bands side by
side rather than let one number stand for "the link".

Only the profiled bearing gets a *chart* — 37 per-ray terrain profiles would be
37 elevation requests — so the ring on every other course is still energy only,
and the card says so. Route legs are checked against the corridor sample instead
of drawn, which is a warning rather than a picture.

## Planning ahead

The same free Open-Meteo request also carries a **3-day hourly forecast** and
sun times. In live mode a **"Plan for" scrubber** appears in the weather rail:
drag it to any hour in the next three days and the entire plan — physics,
verdict, timers, footprint — recomputes for that hour's forecast wind and
temperature, with a banner making clear you're planning on a forecast, not
current conditions. Each day shows **sunset and golden hour** (the last hour of
light), and a clock plan lays the flight against them: *launch 7:41 PM → turn
7:49 → land 7:56 · sunset 8:21*, with a warning when the landing runs out of
light.

**Saved spots** (Map tab) turn the single launch pin into a named list: each
spot keeps its location, cached elevation, notes, and a snapshot of the loadout
you saved it with. *Fly here* re-aims the pin, restores that rig, and refetches
live weather — so "which of my spots is flyable Saturday" is two clicks and a
scrub.

The **session planner** (Planner tab) totals airtime across the packs in your
bag — set a count next to each pack and it sums flight time plus swap overhead
into a realistic field-session length.

## Camera payloads

The camera selector includes published ready-to-record weights for the complete
DJI Osmo Action line (124, 56, 145, 145, 146, and 149 g for Action 1–6) and
GoPro HERO7–HERO13 Black (116, 126, 158, 153, 154, 154, and 159 g). It also
includes the FPV-focused HERO10 Black Bones with its lens cover (60 g), HERO11
Black Mini (133 g), HERO (86 g), LIT HERO (93 g), MAX (154 g), MAX2 (195 g),
and the currently shipping MISSION 1 and MISSION 1 PRO (207 g each).

Weights come from DJI product specifications and GoPro product/specification
pages and comparison charts. The modular DJI Action 2 entry is its self-contained
camera unit without an add-on battery/display module. MISSION 1 PRO ILS is not
included yet because GoPro lists it as coming September 2026 and its flight-ready
weight will depend on the selected Micro Four Thirds lens. Camera `cdA` values
are envelope-based planning estimates because neither manufacturer publishes
aerodynamic drag data.

## Adding your own drone

"Add a drone" in the Aircraft rail builds a rig with **no required physics
fields**. Name it, pick an airframe class — 3" duct, 5" freestyle, 7" long range,
10" cruiser — and every physics number arrives from that class's template wearing
a "class default" chip. Type in a field and it becomes yours; the chip goes away
and changing the class won't overwrite it.

- **Clone and edit** is the faster path when your rig is a variant of something
  already in the list: pick a source and the form fills with its numbers, motor
  and ESC limits included. Those limits are the only thing the form doesn't ask
  for, because nobody knows them for a rig they built themselves.
- **The line under the form** answers while you type: what this rig would hover
  and cruise like on the pack in the rail, its disc loading and W/kg, and a plain
  sentence when a value is unusual for its class. Nothing blocks a save — people
  build weird things, and the cross-checks are there to catch a typo, not to
  argue.
- **Paste a thrust table** (from a bench test or a manufacturer PDF) into the
  optional field and the planner takes the peak thrust per motor off it. That
  replaces the estimated lift ceiling with a measured one, and the lift tile says
  "from your thrust table" instead of naming a limiting component. Nothing else
  off the table is stored.
- **Where these numbers came from** is a three-way choice — estimated, datasheet,
  or measured — and the planner repeats your answer wherever those numbers show
  up, so a plan built on class defaults never reads like a calibrated one.

## Logging flights and calibration

"Log a flight" takes about thirty seconds off the OSD and the charger, and it is
how the model stops guessing about your rig.

- **What to log.** Flight time (the armed timer, `7:20`), which pack, and either
  what the charger put back in mAh or the state of charge you landed at. Then
  pick the kind of flight: a **hover test** pins propulsive efficiency, because
  with no airspeed the drag term drops out of the equation entirely. A **cruise
  leg** pins drag against that efficiency — for those, add the distance flown (or
  your average speed), the wind, and whether the leg was into it, downwind, or
  across. Fly the hover test first.
- **Conditions are prefilled.** Set the date and time and the planner looks up
  the archived weather at your launch point and fills in the temperature, wind
  and elevation. Correct anything you remember better. The archive runs about a
  day behind, so a flight from an hour ago wants those typed in.
- **What the fit does.** Each logged flight is solved back into the one number it
  isolates, clamped to a sane range for the airframe class, and averaged with the
  others. The status line under the drone selector shows the before and after —
  `η 0.55 (catalog) → 0.49 (yours, 6 flights, ±0.02)`.
- **The apply toggle is gated by how much you have logged.** One flight shows you
  the fit but won't offer it. Three offer it. Five, spread across more than one
  speed, and it's on by default — a fit from flights all flown at the same speed
  can't tell efficiency and drag apart, so it stays opt-in no matter how many
  there are. You can always switch it off, and the footnote under the plan says
  whose numbers are in play.
- **Model vs your flights** is the chart under the logbook: each logged flight as
  predicted-versus-actual average power, with the ideal diagonal behind it, so a
  model that is consistently 8% optimistic looks like exactly that. Toggle it to
  residual-versus-speed to see whether the error grows with airspeed — that shape
  is drag, and it's the honest limit of a single-`etaProp` model. Once a fit is
  applied, the headline range grows a **band**: "8.4 mi (7.9–8.8, from your 11
  flights)", the spread your own scatter supports rather than a single confident
  number.

## Adding batteries

Two ways:

- **In the app** — first choose an existing manufacturer or add a custom battery
  manufacturer, then use "Add a battery to compare." Custom manufacturers and
  batteries persist in browser localStorage. Packs can record the cell maker,
  cell model, S/P configuration, connector, price, IR, and current limit.
- **Permanently** — add an entry to `BATTERIES` in
  [src/catalog/batteries.js](src/catalog/batteries.js): builder
  (`manufacturerId`), cell identity, chemistry, S/P count, capacity, weight,
  pack IR (mΩ), continuous amps, and optionally which drones it `fits` — a
  pack without a `fits` pin matches any drone whose connector and cell count
  agree. Add a corresponding entry to `MANUFACTURERS` in
  [src/catalog/manufacturers.js](src/catalog/manufacturers.js) for a new
  built-in builder.

While you fill the form in, a line under it works out the pack's **Wh/g** and
what its current limit implies as a **C-rating**. Real packs run 0.08–0.33 Wh/g,
so a pack claiming 0.4 is a capacity or a weight typo, and 300C continuous is a
burst figure off the label. Both are soft warnings — the save still goes through.
If your charger reports resistance **per cell**, open "Internal resistance" and
switch the mode: enter one cell's mΩ and the pack figure is worked out as you
type (15 mΩ × 6S ÷ 1P = 90 mΩ), which is what gets stored, because that is what
the sag model reads. The temperature you measured at is recorded with the pack as
provenance; the model applies its own temperature curve regardless.

### Which pack is this?

A pack in the list is a *model*. If you own three of them and one has been
through 180 cycles, "Which pack is this?" under the battery selector is where you
say which one is strapped on. Add each physical pack with a name, its cycle
count, and its measured resistance if you have it (with the bench temperature you
read it at, which is provenance for that measurement — a different thing from the
takeoff pack temperature in the Weather rail); the plan then flies **that
pack** — a measured 34 mΩ replaces the 22 mΩ on record for the model, and the
footnote under the plan says so. Your selection is remembered per pack model, and
switching back to "Catalog spec" undoes it.

Cycle count is bookkeeping: it is how you know which pack to retire, and a high
count earns a sentence suggesting you re-measure. **Nothing derates capacity by
cycles** — that would be a curve nobody here has data to anchor, and inventing
one is worse than showing you the number. Physical packs are personal bench data
and are **never** part of a shared file.

## Sharing rigs, packs and flights

"Share drones, packs and flights" in the Aircraft rail writes a JSON file of
everything you authored — the drones and packs you added, the custom brands they
name, and (optionally) your flight logs:

```json
{ "version": 1, "manufacturers": [...], "drones": [...], "batteries": [...], "flightLogs": [...] }
```

Built-in catalog records are never in the file; the planner you send it to already
has them. Custom brands always ride along, so a shared pack never arrives naming a
builder the other planner has never heard of. **Coordinates are never exported**
(saved spots aren't shared at all) and flight dates are stripped unless you tick
the box.

Importing is deliberately paranoid: the file's schema version has to be 1, every
drone and pack is validated against the same field descriptors the forms are built
from, every flight goes through the logbook's own gate, and anything that fails is
skipped with the reason shown. **An import never overwrites.** A record whose id
collides with one you already have (yours or a built-in) comes in as
`<id>-imported`, and every reference to it inside the same file — a pack's `fits`
pins, its brand, a flight's drone and pack — is rewritten to match. You see the
whole diff, renames and skips included, and nothing is saved until you confirm.
Imported flights feed the calibration fit for the imported airframe, so a
stranger's `etaProp` backed by eleven logged flights is still visibly different
from one they typed in.

## Honest limitations

- One `etaProp` per airframe, plus one profile-drag growth constant shared by
  every airframe. The µ² term captures the shape of the loss, not each rig's
  exact blade geometry, so the model is most accurate near hover and best-range
  cruise and least certain at full tilt — where a real blade also starts
  stalling on the retreating side, which is not modeled at all.
- Lift ceilings are physics estimates constrained by published electrical
  limits, not exact thrust-stand curves for the installed motor/prop pairs.
  Replace them with measured thrust/current tables when those become available.
- The cold rows of the capacity and resistance tables come off gentle bench
  discharges of a pack held at temperature, and a flying pack does neither: it
  gets pulled hard in bursts, and the very resistance that costs you the energy
  heats the cells while they work. So the cold penalty is wrong in two opposite
  directions. It **under-states the sag on your first hard pull** — that one
  meets the pack at its full cold resistance — and **over-states what cold costs
  you across a whole flight**, because minutes in, the pack has warmed itself and
  is really living on a milder row of the table than the one we hold it at.
  Preheating is modeled; the pack cooling back down in the airstream is not, so a
  preheated plan is the optimistic end of what you'll get.
- Rain and prop wear aren't modeled. The scenario burn multiplier is a flat
  average for the pattern — a single sustained dive-and-punch sequence can
  transiently pull far beyond it, which is what the landing reserve is for.
- Climb and descent energy *are* modeled on a route, but as a bound rather than a
  simulation: the climb charge is the ceiling of the momentum-theory excess it
  stands in for, and the descent is a fixed power policy with no regeneration.
  Both err against you on purpose. The ring, which has no altitude profile to
  work from, is still level flight.
- Wind aloft is interpolated between the levels the forecast publishes. Where the
  forecast has only one level there is no gradient and none is invented; and
  either way it is a smooth field, so mountain rotor and valley acceleration are
  very much not in it.
- The terrain data is a bare-earth elevation model. It knows nothing about trees,
  towers, wires or buildings, and the density altitude on the dashboard is the
  turnaround's — a ridge higher than the turnaround is drawn and warned about,
  but the ring is not flown over it. Route legs do read their own sampled ground.
- The link check is **geometry, not a link budget**. It counts bare-earth terrain
  against the first Fresnel zone; it knows nothing about transmit power, antenna
  pattern and polarisation, noise floor, multipath, or the trees and buildings
  the DEM omits. A link can survive a flagged intrusion, and a clear profile can
  still fail on interference. It also declines to claim on ground no higher than
  the launch point: a 1.5 m antenna's Fresnel zone grazes flat ground within a
  few hundred metres of the pilot at every frequency, which is a ground
  reflection problem, not terrain in the way.
- It's a planning estimate, not an RTH guarantee. Fly with margin.
