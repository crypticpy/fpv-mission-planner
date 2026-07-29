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
modules ([js/physics.js](js/physics.js), [js/data.js](js/data.js),
[js/charts.js](js/charts.js), [js/app.js](js/app.js)).

## The model

1. **Air density** — ISA barometric pressure at field elevation, Magnus vapor
   pressure from temp + humidity → humid-air density and density altitude.
2. **Rotor power** — momentum theory on total disc area (4 props): induced
   velocity solved by fixed-point iteration, parasite drag `½ρ·CdA·V²` tilts the
   thrust vector, plus a constant avionics draw. A single per-airframe
   efficiency `etaProp` folds figure of merit, motor/ESC losses, and profile
   drag.
3. **Battery** — per-chemistry OCV curve (Li-Ion / LiPo / LiHV), constant-power
   discharge sim with internal-resistance sag (quadratic current solve), cold
   temperature capacity/IR derating, low-voltage cutoff under load. Sag can end
   the flight before the energy does — the tool warns when that happens.
4. **Mission** — planning wind = average + 35% of the gust spread. **Weather**
   (place + season presets) is separate from the **scenario** (how you fly):
   each scenario sets a realistic cruise speed as a fraction of the airframe's
   calibrated hands-on cruise (MOZ7 ~40 mph, Cinelog ~20 mph) and a maneuvering
   burn multiplier (+5% steady cruise up to +40% cliff dives) on top of
   steady-flight power. Cruise speed modes: *Realistic* (default — the speed
   you'd actually fly), *Theoretical best range* (per-leg Wh-per-ground-km
   optimum — the ceiling, not a prediction), or *Manual*. Radius solves
   `usable energy = radius × (Wh/km out + Wh/km back)` after the landing
   reserve.

### Calibration anchors (real flights, not datasheets)

| Anchor | Source | Model check |
|---|---|---|
| MOZ7 V2: 843 g dry (measured, claim is 750 g) | Oscar Liang review | used as dry mass |
| MOZ7 V2: ~16 min / 15+ km, 6S 6000 Li-Ion, 15–20 mph wind | Oscar Liang review | `etaProp 0.55` reproduces it |
| MOZ7 V2: hover ~26–30% throttle, cruise 60–70 km/h, top ~110 km/h | Oscar Liang review | hover A and speed cap |
| Cinelog30 V3: 192 g dry (measured) | Oscar Liang review | used as dry mass |
| Cinelog30 V3: 8:10 claimed on 4S 720; 7–7.5 min real on 850 | GEPRC / Oscar Liang | `etaProp 0.37` reproduces both |
| NAV packs: 499 g / 975 g, cell DCIR 19.6 mΩ @25 °C → 76 mΩ @−20 °C, cold capacity curve | Lumenier INR21700-50SE factory test report | pack IR & Li-Ion temp tables |
| GNB 6S 5500/7000 70C XT60: 656/797 g | GNB product pages | capacity, mass, connector, and price |
| DIY500AMP 6S2P: EVE 40PL/50PL, Ampace JP40/JP50P1, Tenpower 50XG, Reliance RS50, LinkData 55P/65P | DIY500AMP pack and cell pages | cell capacity, weight, current limits, and IR bounds |
| GNB packs: 88 / 73 / 72 g confirmed; C-ratings optimistic brand-wide | Pyrodrone, WREKD, Oscar Liang | masses; derated `maxContA` |

Fields marked `estimated:` in [js/data.js](js/data.js) had no published source
(mostly pack IR and true continuous current) — weigh your packs and measure IR
to tighten them. DIY500AMP does not publish finished weight or variant pricing,
so its recipes use the published weight of twelve cells plus a 55 g construction
allowance and the currently displayed $195 base price. Storefront Wh figures for
the NAV packs are typos (72/36 Wh); the real numbers are 108/216 Wh and that's
what the model uses.

## Adding batteries

Two ways:

- **In the app** — first choose an existing manufacturer or add a custom battery
  manufacturer, then use "Add a battery to compare." Custom manufacturers and
  batteries persist in browser localStorage. Packs can record the cell maker,
  cell model, S/P configuration, connector, price, IR, and current limit.
- **Permanently** — add an entry to `BATTERIES` in [js/data.js](js/data.js):
  builder (`manufacturerId`), cell identity, chemistry, S/P count, capacity,
  weight, pack IR (mΩ), continuous amps, and which drones it `fits`. Add a
  corresponding entry to `MANUFACTURERS` for a new built-in builder.

## Honest limitations

- One `etaProp` per airframe: profile drag actually grows with speed, so the
  model is most accurate near hover and best-range cruise, slightly optimistic
  at full tilt.
- Climb/descent energy, rain, and prop wear aren't modeled. The scenario burn
  multiplier is a flat average for the pattern — a single sustained dive-and-punch
  sequence can transiently pull far beyond it, which is what the landing reserve
  is for.
- Wind is treated as uniform along the route; mountain rotor and valley
  acceleration are very much not uniform.
- It's a planning estimate, not an RTH guarantee. Fly with margin.
