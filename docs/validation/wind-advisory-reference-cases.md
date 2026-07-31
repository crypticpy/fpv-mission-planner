# Wind-advisory reference-case validation record

**Date:** 2026-07-31
**Gate:** Milestone 5 exit gate — "comparisons against open WindNinja or
published reference cases are recorded."
**Scope:** Baseline 1 (`w* = V · ∇h`, `src/domain/wind/terrain-forcing.js`)
only. Baseline 2 (`Fr = U/(N h)`, `src/domain/wind/regime.js`) is not a
terrain-shape classifier and has no comparable per-cell structure to check
against these sites; it is out of scope for this record.

## Why this is desk validation, not a WindNinja run

`docs/research/R-WINDNINJA.md` recorded a **DEFER** on WindNinja integration:
there is no hosted WindNinja API to call, so "backend provider" would mean
FPV building, hosting, and operating its own containerized WindNinja service
— disproportionate infrastructure for an optional third baseline sitting
alongside two in-app physics baselines that need none. That record also
concluded the exit gate does not require the integration to be satisfied:
run baselines 1/2 offline against the same published inputs used in
Wagenbrenner et al. (2019), and record how the classification compares to
the literature's qualitative findings. That is what this record and its
companion test file (`tests/wind-reference-cases.test.mjs`) do.

## What was compared, and how

Wagenbrenner, N.S., Forthofer, J.M., Page, W.G., Butler, B.W. (2019),
*Development and Evaluation of a Reynolds-Averaged Navier–Stokes Solver in
WindNinja for Operational Wildland Fire Applications*, Atmosphere 10(11):672
— the paper R-WINDNINJA.md §4 identifies as WindNinja's own official,
peer-reviewed validation — reran WindNinja's mass-conserving and CFD solvers
against field observations at three sites of increasing terrain complexity:
Askervein Hill, Bolund, and Big Southern Butte. R-WINDNINJA.md did not fetch
or read the field-campaign papers directly (Taylor & Teunissen (1987) for
Askervein; Berg et al. (2011) for Bolund); those are cited below only to
identify which real sites the idealized geometry approximates, not as a
source for numeric findings. The one general downscaling-performance claim
below (mixed performance in non-neutral slope-flow) comes from the
feasibility artifact's own source list (`src_windninja_eval`,
`acp.copernicus.org/articles/16/5229/2016/` — the Wagenbrenner et al. (2016)
WindNinja downscaling evaluation), not from memory.

For each site, `tests/wind-reference-cases.test.mjs` builds a synthetic DEM
grid shaped like the site's published geometry (an idealized Gaussian hill,
an idealized escarpment-plus-plateau, a synthetic saddle/pass — never a real
DEM extract), runs `computeForcingField` over it with a plausible background
wind, and asserts the *qualitative* structure the literature reports: which
slope classifies uplift, which classifies lee, where the sign of the forcing
crosses zero, and whether confinement is detected where the geometry
confines. No test asserts a magnitude, a speedup ratio, or a turbulence
level — `w*` is a kinematic proxy with no mass or momentum conservation
behind it, so a magnitude match would not mean anything and a magnitude
mismatch would not either. This is a proxy comparison against the shape of
the published results, not a CFD replication of them.

### Case 1 — Askervein-like isolated hill

- **Published source:** Askervein Hill (Outer Hebrides, Scotland),
  Taylor & Teunissen (1987); rerun through WindNinja in Wagenbrenner et al.
  (2019) at 10 m AGL output height.
- **What the literature reports (qualitatively):** flow over an isolated,
  smoothly-rounded hill accelerates (speeds up) approaching and crossing the
  crest, and decelerates on the lee side — the canonical windward-speedup /
  lee-deficit signature that makes Askervein the standard "simple" case in
  this literature.
- **What B1 produces:** on an idealized elongated-Gaussian hill (116 m
  relief, ~1 km minor axis, per the task's geometry), the windward flank
  classifies `uplift` (`w* > 0`) at every probed distance, the lee flank
  classifies `lee` (`w* < 0`), and the crest — the single cell whose local
  curvature clears the shape-detector's threshold — classifies `ridge` with
  `w*` at (within floating-point noise of) exactly zero, the sign-crossing
  point between the two flanks. Forcing magnitude is not monotonic from foot
  to crest: it rises through the mid-slope, peaks, and fades again both
  toward the (zero-forcing) crest and on the gentler outer flank — the
  proxy's version of "forcing is where the surface is steepest," which for a
  Gaussian hill sits mid-slope, not at the top.
- **Agreement:** sign and placement agree with the qualitative shape of the
  published result — windward-positive, lee-negative, crest as the
  transition. **Disagreement / what's not tested:** the proxy cannot and
  does not claim a speedup *ratio* at the crest, a stagnation point, or any
  boundary-layer detail; it only orders slope, not speed.

### Case 2 — Bolund-like escarpment

- **Published source:** Bolund (Roskilde Fjord, Denmark), Berg et al.
  (2011); rerun through WindNinja in Wagenbrenner et al. (2019) at 5 m AGL
  output height, and named there as the deliberately harder of the two
  simple-terrain cases (a sharp step rather than a smooth hill).
- **What the literature reports (qualitatively):** R-WINDNINJA.md's summary
  of Wagenbrenner et al. (2019) states CFD beats the mass-conserving solver
  specifically at windward/lee locations — i.e., this is exactly the terrain
  shape (a sharp escarpment) where separated, non-kinematic flow behavior
  matters most and a simple proxy is expected to struggle with the
  *lee-side* detail (recirculation at the foot of the cliff), even though
  the *sign* of forcing on the escarpment face itself is unambiguous.
- **What B1 produces:** on an idealized ~12 m escarpment with a narrow
  (15 m) transition and flat ground/plateau either side, the escarpment face
  classifies `uplift` under onshore wind and flips to `lee` with the exact
  opposite sign under reversal; the flat low ground and flat plateau both
  classify `low` (low modeled forcing) under either direction.
- **Agreement:** the face's sign and its reversal-flip match the
  unambiguous part of the published expectation. **Disagreement / what's not
  tested:** B1 has no separation physics, so it cannot place — and this
  record makes no claim about — the recirculation zone at the foot of the
  escarpment that is precisely the feature the literature calls out as hard
  for a mass-conserving (let alone kinematic) model to get right.

### Case 3 — Gap/pass

- **Published source:** none directly. Big Southern Butte is the third site
  in the Wagenbrenner et al. (2019) trio, but its geometry — an isolated
  butte — is closer to case 1's archetype at higher relief, not to a
  two-summit gap; mapping this case onto it would misrepresent the
  geometry. Instead, this case is the feasibility artifact's own
  recommended synthetic fixture, named directly in its validation section:
  "synthetic terrain fixtures ... a saddle, and pass — where windward/lee
  sign and ridge-normal geometry are known." It exists because neither
  Askervein's isolated hill nor Bolund's one-sided escarpment exercises B1's
  confinement (`gap`) class, which needs ground rising on both sides of the
  flow.
- **What the geometry implies:** two summits flank a saddle, wind blows
  along the through-axis of the pass. The saddle is the one place the
  ground rises on both sides of the flow; each flank, away from its own
  local summit, is a plain climb into the pass or descent out of it.
- **What B1 produces:** the saddle cell classifies `gap` (caution severity);
  both flanks, north and south of the saddle, classify `uplift` approaching
  their summit and `lee` departing it, matching the slope-sign logic of
  case 1.
- **Agreement:** the classifier places confinement exactly where the
  geometry confines, and slope sign on the flanks is correct. There is no
  published field comparison for this case — it validates the classifier
  against known geometry, not against a field campaign.

## What this does and does not establish

**Establishes:** on three idealized geometries built to match the published
shape of two of WindNinja's own official validation sites (plus one
synthetic case the feasibility artifact itself calls for), B1's `w*`
classifier places `uplift`, `lee`, `ridge`, and `gap` where the terrain
shape and the literature's qualitative flow description say they belong,
and the sign of the forcing reverses correctly under wind reversal and
crosses zero at the crest.

**Does not establish:**

- Any quantitative agreement with measured or modeled wind speed, speedup
  ratio, turbulence intensity, or vertical velocity. `w* = V · ∇h` is a
  terrain-forcing proxy at the surface, not a forecast or measured vertical
  velocity — this is stated in `terrain-forcing.js`'s own module header and
  nothing here changes that.
- Anything about stagnation points, flow separation, recirculation, or
  rotors. B1 has no mass or momentum conservation and cannot place any of
  these; Bolund's case above is precisely the terrain feature the published
  literature says a non-CFD model gets wrong, and this record does not
  paper over that.
- Any claim about performance at FPV flight altitude. All three published
  comparisons in Wagenbrenner et al. (2019) are near-surface AGL (10 m / 5 m
  / 3 m per R-WINDNINJA.md §4); this record inherits that same near-surface
  scope and makes no claim beyond it.
- A substitute for a real WindNinja run. This record compares idealized
  synthetic geometry, not the actual DEM tiles or field observations used in
  the cited papers. `docs/research/R-WINDNINJA.md` §4 notes that
  `data/big_butte.tif` is already available in-repo (upstream, not fetched
  here) if a closer numeric comparison is ever wanted; that remains future
  work, not something this record claims to have done.

## WindNinja integration status

Unchanged from `docs/research/R-WINDNINJA.md`: **DEFER**. No hosted API
exists to integrate against, and self-hosting a WindNinja service is not
justified for an optional third baseline. This record satisfies the
milestone's reference-case exit-gate language without that integration, per
R-WINDNINJA.md's own closing recommendation. Revisit only under the DEFER
conditions that record names (FPV grows a server-side component for an
unrelated reason, or field feedback shows baselines 1/2 diverge badly at
windward/lee/recirculation zones specifically).

## Executable form

`tests/wind-reference-cases.test.mjs` is the executable form of this record.
Each case above corresponds to one `node:test` block there; the test
comments carry the same source attribution and the same qualitative-only
scope stated here. Run with `node --test tests/wind-reference-cases.test.mjs`.
