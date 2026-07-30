# R-WINDNINJA — go/no-go feasibility record

**Task:** Milestone 5 (mountain-flow advisory system) names an optional third
baseline: WindNinja as a comparison reference or backend provider, alongside
the in-app terrain-forcing baseline (`w* = V·∇h`) and the Froude-like regime
baseline (`Fr = U/(N·h)`). This record answers whether to pursue it, using
only official sources: `github.com/firelab/windninja`, the firelab-hosted
Doxygen API docs, and firelab.org/ninjastorm.firelab.org documentation.

All sources checked 2026-07-30. Repo state: default branch `master`,
HEAD commit `c87fd11` (2026-07-29), latest tagged release `3.12.2`
(2026-03-17). Project is actively maintained (commits the day before this
check).

---

## 1. License

Source: [github.com/firelab/windninja LICENSE](https://raw.githubusercontent.com/firelab/windninja/master/LICENSE), [LICENSE-3RD-PARTY](https://raw.githubusercontent.com/firelab/windninja/master/LICENSE-3RD-PARTY), [CITATION](https://raw.githubusercontent.com/firelab/windninja/master/CITATION)

- **Core code**: developed by US federal employees (USDA Forest Service,
  Rocky Mountain Research Station, Missoula Fire Sciences Lab) in the course
  of official duties → **public domain** under 17 U.S.C. §105. No copyright,
  no attribution requirement, no copyleft. GitHub's license detector reports
  this as license type `Other` because public-domain-by-statute isn't one of
  its templates — this is expected, not a red flag.
- **External contributions** (2016–2026, "The WindNinja Authors") are
  **BSD-3-Clause**: permissive, requires only notice/disclaimer retention in
  source or binary redistribution. No obligation on outputs.
- **Third-party dependencies** (per `LICENSE-3RD-PARTY`), relevant to a
  CLI-only build: Boost (Boost 1.0), GDAL/PROJ (MIT-style), Poppler (GPL-2.0+,
  only used for optional PDF raster support). **Qt (LGPL-2.1, GUI only)** is
  not needed if building CLI-only (`NINJA_GUI=OFF`). **OpenFOAM (GPL-3.0)** is
  a separate program invoked by the optional momentum solver (NinjaFOAM) —
  it is not linked into WindNinja's own code, so running it as an external
  process does not put WindNinja itself under GPL, but **redistributing a
  container/binary that bundles OpenFOAM inherits GPL-3.0 obligations for
  that bundle**. This only matters if FPV redistributes a built image; it
  does not affect consuming WindNinja's numeric outputs.
- **Outputs are not covered by any of these licenses** — wind-grid results
  (.asc/.shp/.kmz) are data, not code, and are public-domain government-model
  output with no reuse restriction the FAQ or LICENSE files impose.
- **Citation obligation**: no citation is legally required, but the project
  asks (`CITATION` file) that publications cite Forthofer, Butler &
  Wagenbrenner (2014), *Int. J. Wildland Fire* 23:969–981, doi:10.1071/WF12089,
  plus the Zenodo software DOI (10.5281/zenodo.14157304) if practical.

**Conclusion**: license is not a blocker for either (a) building/running our
own WindNinja instance and consuming its output, or (b) displaying its
numbers as a comparison reference in-app.

---

## 2. "Hosted WindNinja API" — does one actually exist?

Sources: [ninjastorm.firelab.org/windninjaapi/](https://ninjastorm.firelab.org/windninjaapi/) (fetched via curl, WebFetch TLS-chain-verify failed on this host but curl succeeded — cert is valid, just an intermediate the WebFetch tool didn't like), [ninjastorm.firelab.org/windninja/](https://ninjastorm.firelab.org/windninja/), [ninjastorm.firelab.org/windninja/faq.html](https://ninjastorm.firelab.org/windninja/faq.html), repo `src/` directory listing.

**Finding: there is no public hosted REST/HTTP API for running WindNinja
simulations.** This corrects the task's framing. What actually exists at
`ninjastorm.firelab.org/windninjaapi/` is **Doxygen-generated reference
documentation for the C/C++ library API** (`windninja.h` / `windninja.cpp`)
— functions like `NinjaCreateArmy`, `NinjaFetchDEMBBox`,
`NinjaGetRunKmzFilenames` — meant for developers embedding libwindninja
into their own program (as the desktop GUI and CLI both do), not a network
service with endpoints, bounding-box parameters over HTTP, or auth tokens.

Evidence for this conclusion:
- The main project site (`ninjastorm.firelab.org/windninja/`) offers only a
  Windows installer download and a link to the GitHub source — no "run
  online" or API-key signup flow.
- The FAQ describes installation (Windows installer or Linux build-from-source)
  and has no endpoint/rate-limit/registration section.
- The repo's `src/` directory contains `cli/`, `gui/`, `fetch_dem/`,
  `fetch_station/`, `examples/`, `ninjafoam/`, etc. — no `server/`, `api/`, or
  web-service module. WindNinja is a library + two front-ends (GUI, CLI), full
  stop.
- A legacy 2016 page (`firelab.github.io/windninja/howdoes/`, archived,
  banner reads "WindNinja has moved") references a "live WindNinja Simulation
  Online" link; it could not be verified as still functional and is not
  linked from any current, maintained page. Treat it as dead, not as evidence
  of a hosted service.
- The only genuine third-party network calls WindNinja itself makes are
  **outbound fetches it performs on your behalf** during a local run: DEM
  tiles (SRTM/LANDFIRE via `NinjaFetchDEMBBox`), weather forecast grids
  (NOMADS/UCAR THREDDS for NCEP models, or archived HRRR from GCP), and
  station observations (MesoWest/Synoptic Mesonet API, hard-limited to
  **100,000 station-hours per request** per [firelab's MesoNet API devdoc](https://firelab.github.io/windninja/internal/devdoc/mesonet.html)).
  These are inputs into a local simulation, not a "run the model in the
  cloud" endpoint.

Because there is no hosted simulation API, questions 2's sub-parts (CORS,
browser-callability, uptime SLA) don't have literal answers — **there's
nothing to call from a browser without a proxy, because there's no service
to proxy to.** A proxy would have to front our own self-hosted WindNinja
instance, not a firelab-operated one.

---

## 3. CLI / desktop path

Sources: repo `README.md`, `Dockerfile`, `data/*.cfg`, `doc/CLI_instructions.tex`, `config_options.csv`.

**Build requirements** (from `README.md` and the in-repo `Dockerfile`):
Boost (date-time, program-options, test), NetCDF ≥4.1.1, GDAL ≥2.2.2 (with
NetCDF/PROJ.4/GEOS/CURL support), CMake, and — only for the GUI — Qt 4.8.5.
The optional momentum solver (NinjaFOAM) additionally needs **OpenFOAM
2.2.x/8/9** (repo has `data/ninjafoam/{2.2.0,8,9}` version-specific case
templates).

**Docker path exists in-repo** — `Dockerfile` (Ubuntu 20.04 base) and a
`Singularity` recipe are first-party, checked into the repo root:
```
FROM ubuntu:20.04
...
cmake -D SUPRESS_WARNINGS=ON -D NINJAFOAM=ON -D BUILD_FETCH_DEM=ON \
      -D BUILD_SLOPE_ASPECT_GRID=ON -D BUILD_FLOW_SEPARATION_GRID=ON \
      -D NINJA_GUI=OFF ..
make -j12 && make install
# + a second stage builds OpenFOAM 8 bindings for the momentum solver
```
`NINJA_GUI=OFF` builds CLI-only, dropping the Qt dependency entirely. The
Dockerfile as written unconditionally builds the OpenFOAM/NinjaFOAM stage;
a mass-conserving-only image would need that stage commented out (small,
low-risk edit) if the slower solver isn't wanted. CI (`.github/workflows/`)
builds and runs `autotest/` on every push, so the build path is exercised
continuously by upstream.

**Input formats**: elevation as `.asc` (Arc/Info ASCII), `.lcp` (FARSITE
landscape), `.tif` (GeoTIFF), or `.img` (ERDAS IMAGINE). Hard requirements
(FAQ Q6–Q9): no NO_DATA cells, both horizontal and vertical units in meters,
and — since v2.3.0 — a **"north-up" projected CRS** (UTM recommended) so the
standard meteorological wind-direction convention (0° = wind from north)
holds. Domain-size guidance: **keep the DEM under ~50×50 km**; WindNinja
resamples to a computational mesh (100–300 m is "usually adequate"), and RAM/
mesh-cell-count is the real limiting factor, not raw DEM resolution. A 10–20%
buffer beyond the area of interest is recommended to reduce domain-edge error.

**Three initialization methods** (confirmed via `data/cli_*.cfg` examples and
`doc/CLI_instructions.tex`):
1. `domainAverageInitialization` — single input speed/direction/height, no
   network fetch needed.
2. `pointInitialization` — one or more weather-station observations
   (`wx_station_filename`, or live fetch by station ID/bbox/lat-lon-radius
   against the MesoWest API), optionally `match_points` to force the output
   field to reproduce the station reading(s) exactly.
3. `wxModelInitialization` — a downloaded NCEP forecast grid (NOMADS/UCAR
   THREDDS: NAM, HRRR, RAP, GFS/NBM variants) or an archived/pastcast HRRR
   grid, with optional `diurnal_winds` slope-flow parameterization.

**Output formats**: ASCII grid (`.asc`, for FlamMap fire-behavior chaining),
Esri shapefile (`.shp`/`.shx`/`.dbf`), Google Earth KMZ, and (since v3.0)
GeoPDF. Each run writes a wind field at **one user-chosen `output_wind_height`**
(e.g., 20 ft or 10 m AGL in the example configs) — WindNinja does not emit a
multi-level vertical profile in a single run; a profile would mean re-running
per height.

**Mass-conserving (COM) vs momentum (NinjaFOAM/CFD) solver**, per the FAQ and
the official validation paper (§4 below):
- COM: fast (officially benchmarked at **~0.16–0.17 min**, i.e. ~10 s, on a
  20K-cell mesh on a 2011-era desktop), can't represent lee-side recirculation
  (produces low-speed, not reversed-flow, in eddy zones), supports the
  `match_points` station-forcing feature.
- NinjaFOAM (OpenFOAM-backed RANS CFD): **~4.2–7.3 min** on a 100K-cell mesh (4
  cores, same benchmark hardware), materially better at windward/lee
  locations, can capture recirculation, no `match_points` support, 10s-of-
  minutes runtime per the FAQ's general guidance.
- **No official runtime number exists for a ~10 km domain specifically** —
  the only published benchmarks are for the small (roughly 1 km-scale)
  Askervein/Bolund/Big-Southern-Butte validation sites. Extrapolating (cell
  count scales ~with area at fixed resolution): COM should still land under a
  minute for a 10 km domain at 100–300 m mesh resolution (consistent with the
  FAQ's blanket "less than a minute" claim); NinjaFOAM should be expected in
  the **tens of minutes**, not single minutes, once cell count rises by
  ~1–2 orders of magnitude. Treat this as an engineering estimate to be
  confirmed by an actual run, not a documented figure.

---

## 4. In-repo test/reference cases and published validation

Sources: repo `data/`, `data/tutorial/`, `autotest/`, and the official
validation paper hosted at firelab.org.

**In-repo fixtures usable for our own regression tests** (all paths relative
to repo root, `master` branch):
- `data/big_butte.tif`, `data/big_butte_small.tif` — Big Southern Butte DEM,
  directly corresponding to one of the three sites in the official validation
  study below. `data/bigbutte_test_nodust.cfg`, `data/bigbutte_wrf_initialization.cfg`,
  `data/cli_bigbutte_stability.cfg` are ready-to-run configs against it.
- `data/mackay.tif`, `data/missoula_valley.tif`, `data/denali.tif`,
  `data/example_lcp.tif` — other real-world DEMs with matching `.cfg` files
  (`cli_domainAverage.cfg`, `cli_pointInitialization*.cfg`,
  `cli_wxModelInitialization*.cfg`, `cli_momentumSolver_diurnal.cfg`).
- `data/dem/idealized_dems/` — synthetic bell-curve hills
  (`bell.tif`, `bell_steep.tif`) and a flat control (`flat_test.tif`), plus
  `v2_{30,100,200,400,600}m.tif` resolution-sensitivity fixtures — useful for
  our own "resolution/forecast perturbation → bounded sensitivity" exit-gate
  test named in the milestone.
- `data/dem/edge_case_dems/` — `nodata.tif`, `no_srs.tif`, `tiny.tif`,
  `mackay_skinny_x/y.tif` — malformed-input fixtures for negative testing.
- `data/tutorial/{Domain_Average_Cases, Point_Initialization_Cases,
  Wx_Model_Initialization_Cases}/` — full runnable tutorial cases with Python
  drivers (Python ≥3 required).
- `autotest/api/{test_capi_domain_average_wind.c, test_capi_point_initialization_wind.c,
  test_capi_weather_model_initialization_wind.c, test_capi_output.c,
  test_capi_fetching.c}` — first-party C-API integration tests with their own
  `autotest/api/data/`, exercised in CI on every push.
- Weather-station fixtures: `data/WXSTATIONS-2018-06-25-1237-missoula_valley/`,
  `data/WXSTATIONS-MDT-2018-06-20-2128-2018-06-21-2128-missoula_valley/`.

**Published validation** (official, hosted at `ninjastorm.firelab.org`):
Wagenbrenner, N.S., Forthofer, J.M., Page, W.G., Butler, B.W. (2019),
["Development and Evaluation of a Reynolds-Averaged Navier–Stokes Solver in
WindNinja for Operational Wildland Fire Applications"](https://ninjastorm.firelab.org/windninja/publications/windninja_cfd.pdf),
*Atmosphere* 10(11):672, doi:10.3390/atmos10110672. This paper compares the
COM solver, the NinjaFOAM/CFD solver, and previously-published large-eddy
simulations against **field observations at three sites of increasing terrain
complexity: Askervein Hill, Bolund Hill, and Big Southern Butte** — exactly
the community-standard complex-terrain benchmark trio, run through
WindNinja itself. Headline findings directly relevant to our own baselines:
CFD beats COM at windward/lee locations but the two solvers don't differ at
ridgetop speed-up; output heights compared were 10 m AGL (Askervein), 5 m AGL
(Bolund), 3 m AGL (Big Southern Butte) — i.e. validation is against
near-surface AGL winds, not any particular cruise altitude. The earlier
Forthofer et al. (2014) paper (cited in §1) is the original COM-solver
validation against measurements.

**Conclusion**: yes — both in-repo fixtures (esp. `data/big_butte.tif`
against the published Big Southern Butte results) and an official,
peer-reviewed validation corpus (Askervein/Bolund/Big Southern Butte) exist
and are usable without any human-subjects or licensing concern.

---

## 5. Elevation / coordinate conventions of outputs

- **Vertical**: output wind speed/direction is reported at a single
  user-specified **height above ground level (AGL)** per run (not MSL, not
  pressure-level) — e.g. `output_wind_height = 20.0` / `units_output_wind_height = ft`
  in the example configs, or 10 m / 5 m / 3 m AGL in the validation paper's
  figures. To compare against our in-app baselines (which key off Open-Meteo
  height/pressure levels — see R-WX) we'd need to either run WindNinja at a
  matching AGL height or interpolate one side to the other; there's no
  native multi-level output in one run.
- **Horizontal/CRS**: outputs inherit the **input DEM's projected CRS**,
  which since v2.3.0 must be a **north-up projected system** (UTM
  recommended) — this is what lets WindNinja use the standard "wind direction
  = compass bearing wind is coming from" convention without extra rotation
  math. KMZ output is the one exception: it's reprojected to geographic
  WGS84 lat/lon for Google Earth, since KML requires that. ASCII-grid and
  shapefile outputs stay in the DEM's native projected CRS, so ingesting them
  into a Web-Mercator/WGS84 map stack (as FPV's MapLibre terrain-grid
  contract does — see R-3D/R-DEM) requires a reprojection step.

---

## Reproducible runbook sketch (COM-solver-only path, if pursued later)

```bash
# 1. Pin a release and build a CLI-only, COM-solver-only image
git clone --branch 3.12.2 https://github.com/firelab/windninja.git
cd windninja
# Edit Dockerfile: drop the OpenFOAM RUN stage, set -D NINJAFOAM=OFF
docker build -t windninja-com:3.12.2 .

# 2. Run a validation case against the official fixture
mkdir -p ~/wn-runs && cp data/big_butte.tif ~/wn-runs/
cp data/cli_bigbutte_stability.cfg ~/wn-runs/run.cfg
# edit run.cfg's elevation_file path to /data/big_butte.tif, set
# output_wind_height to 3.0 m / units m to match the paper's AGL height
docker run --rm -v ~/wn-runs:/data windninja-com:3.12.2 \
  WindNinja_cli /data/run.cfg

# 3. Compare the resulting .asc grid's speed/direction at the paper's
#    published Big Southern Butte observation points against
#    Wagenbrenner et al. (2019) Figure 13 / Table values — this is the
#    regression fixture for "comparisons against open WindNinja or
#    published reference cases are recorded" in the milestone's exit gate.

# 4. If ever integrating: wrap step 2 behind a small internal HTTP service
#    FPV owns and operates (there is no firelab-hosted equivalent to call
#    instead), taking a bbox + wind obs/forecast snapshot in, returning a
#    reprojected (Web Mercator/WGS84) grid out.
```

---

## Recommendation: **DEFER**

**Not GO** — there is no hosted API to integrate against, so "backend
provider" would mean FPV standing up and operating its own containerized
WindNinja service (build, host, patch, and pay for compute), which is
disproportionate infrastructure for an *optional* third baseline sitting
alongside two in-app physics baselines that need zero extra infrastructure.

**Not NO-GO** — nothing here rules it out. License is fully permissive for
our use (public domain + BSD-3, output data unencumbered), an official Docker
build path exists and is exercised in upstream CI, the mass-conserving
solver is fast enough (sub-minute, even extrapolated to a 10 km domain) to
run synchronously in a request/response cycle, and there's a directly
reusable, peer-reviewed validation corpus (Askervein/Bolund/Big Southern
Butte, `data/big_butte.tif` in-repo) that would make "comparisons against
open WindNinja or published reference cases are recorded" a straightforward
exit-gate item to satisfy later.

**DEFER conditions** — revisit this if either becomes true:
1. FPV grows a server-side component for an unrelated reason (e.g., the
   Milestone 6 mission-compiler backend, or a shared-fixture service), so the
   marginal cost of also hosting a small Dockerized COM-solver endpoint drops
   to near-zero.
   Do not build server infrastructure solely to acquire baseline 3.
2. Field feedback or the R-VALIDATION corpus shows baselines 1/2 diverge
   badly from reality specifically at windward/lee/recirculation zones — the
   one place the validation paper shows COM (and by extension, our simpler
   `w*`/Froude baselines) measurably underperforms a momentum-aware solver.
   That would justify the added NinjaFOAM/OpenFOAM build complexity
   specifically, not just the COM path.

If pursued, scope it to the **mass-conserving solver only** (COM,
`NINJAFOAM=OFF`) first: it avoids the OpenFOAM GPL-3.0 build/bundle question,
avoids the minutes-scale runtime and OpenFOAM ops burden, and is what the
`w*`/`Fr` baselines are conceptually closest to anyway (both are inviscid/
mass-conserving approximations, not full RANS). Treat NinjaFOAM as a
separate, later decision gated on condition 2 above.

## Decision impact

- Milestone 5 ships with **baselines 1 and 2 only** for the foreseeable
  future; the map/warning-system spec, exit gates, and mission-brief copy
  should not assume or reference a WindNinja-backed number.
- The milestone's exit-gate bullet "comparisons against open WindNinja or
  published reference cases are recorded" **can and should still be
  satisfied without building an integration**: run baselines 1/2 offline
  against the same Askervein/Bolund/Big-Southern-Butte inputs used in
  Wagenbrenner et al. (2019) (terrain + wind conditions are in the paper and,
  for Big Southern Butte, the DEM is already in-repo at
  `data/big_butte.tif`), and record how `w*`/`Fr` classifications compare to
  the paper's published COM/CFD/LES results. That is a desk validation task,
  not a WindNinja integration, and can be dispatched as its own R-VALIDATION
  fixture item now.
- No backlog item, ADR, or contract should be opened for a "WindNinja
  adapter" at this time. This record itself is the closure artifact for
  R-WINDNINJA — no code changes follow from it.
