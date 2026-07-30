# R-WX — Open-Meteo API research for `ForecastSnapshot`

Research task, not an implementation. No app code touched. Retrieved
2026-07-30 against the live public API (`api.open-meteo.com`,
`previous-runs-api.open-meteo.com`, `single-runs-api.open-meteo.com`) plus
`open-meteo.com/en/docs`, `/en/docs/gfs-api`, `/en/docs/previous-runs-api`,
`/en/docs/single-runs-api`, `/en/docs/historical-weather-api`, `/en/pricing`,
`/en/licence`. Test point: Austin, TX (30.27, -97.74), matching the app's
`DEFAULT_LAUNCH` in `js/weather.js`. Fixtures (curl output + exact request
URLs) are under `docs/research/fixtures/R-WX/`, described in that directory's
`README.md`.

Current app usage for reference: `js/weather.js` calls `/v1/forecast` with no
`&models=` param (implicit auto/seamless model selection) for `current` +
`hourly` + `daily`, at `wind_speed_10m,80m,120m,180m` (`CRUISE_ALTS_M` in
`js/windprofile.js`) plus `wind_gusts_10m`. It separately calls
`archive-api.open-meteo.com/v1/archive` (ERA5) for past-hour prefill, reading
`wind_speed_100m`/`wind_direction_100m` there (a different height than the
forecast endpoint's 80 m, noted in that file's own comments).

## 1. Height-level wind — variables, sources, US models

- Confirmed live at Austin: `wind_speed_{10,80,120,180}m` and
  `wind_direction_{10,80,120,180}m`, plus (new to the app)
  `temperature_{80,120,180}m` — all real, non-null values in
  `fixtures/R-WX/hourly_height_levels.json`. Same endpoint/host the app
  already calls — no new integration needed to add height-level temperature.
- These four heights are Open-Meteo's fixed published set for the general
  `/v1/forecast` endpoint; there is no arbitrary-height query — the app (or
  the snapshot's interpolation policy) owns any value needed between them.
- `&models=` on the *general* `/v1/forecast` endpoint accepts (confirmed by
  probing, since error messages don't enumerate valid values):
  `gfs_seamless`, `gfs_global`, `gfs_hrrr`, `ncep_hrrr_conus`, `best_match`,
  `icon_seamless`, and others. `hrrr_conus` (no `ncep_` prefix) and bare
  `hrrr` both 400. Omitting `&models=` (the app's current behavior) uses
  Open-Meteo's own best-match/seamless blend and does not report which
  underlying model served any given hour (see §3).
- US coverage: GFS is global at 0.11°/~13 km (surface/height-level fields);
  HRRR (`ncep_hrrr_conus`) is CONUS-only at ~3 km, hourly-updating, requested
  either standalone or blended into `gfs_hrrr`/seamless. NAM
  (`ncep_nam_conus`) and NBM (`ncep_nbm_conus`) are additional CONUS-only
  options on the dedicated `/v1/gfs` "GFS & HRRR API" docs page; not
  independently curl-verified here beyond the models listed above.

## 2. Pressure-level variables — endpoint, naming, units

- Same endpoint the app already calls (`api.open-meteo.com/v1/forecast`),
  same host — confirmed live, see `fixtures/R-WX/hourly_pressure_levels.json`.
  No separate pressure-level API/host.
- Naming: `temperature_{level}hPa`, `wind_speed_{level}hPa`,
  `wind_direction_{level}hPa`, `geopotential_height_{level}hPa`, plus (not
  needed for this task's Froude/stability ask but present, confirmed via the
  dedicated `/v1/gfs` endpoint) `relative_humidity_{level}hPa`,
  `dew_point_{level}hPa`, `cloud_cover_{level}hPa`.
- Units follow the same request-level unit params the app already sets
  (`wind_speed_unit`, `temperature_unit`); geopotential height is always
  meters. Fixture sanity check at Austin (elevation 164 m): 1000 hPa
  geopotential height ≈ 108 m (below-ground here, expected), 850 hPa ≈
  1540 m, 700 hPa ≈ 3197 m, 500 hPa ≈ 5948 m — physically reasonable.
- **No u/v wind components.** Probed `wind_u_850hPa`/`u_wind_850hPa`/
  `wind_u_component_850hPa` — all reject with "Data corrupted... invalid
  String value." Only speed+direction are published at any level. Any vector
  math (shear across levels, Froude-regime deltas) needs u/v derived
  client-side via trig from speed+direction — a computed field, not a
  fetched one.
- Level granularity is finer than the docs page's stated "19 levels"
  (1000…30 hPa) suggests: `temperature_875hPa` (not in that list) returned
  200 with real data on the general endpoint, matching the dedicated
  `/v1/gfs` endpoint's finer level set. In practice the naming pattern
  `{var}_{level}hPa` should be treated as accepting any of GFS's native
  levels, not just the "19" the marketing docs enumerate.

## 3. Model run/issue time — what the API actually exposes

This is the weakest part of the contract. On the app's actual call shape
(`/v1/forecast`, no `&models=`, `current` + `hourly` + `daily`):

- The JSON body carries **no field naming the model run/issue time at all.**
  Confirmed by inspecting a full `current` response: only `time` (valid
  time of the returned snapshot), `interval` (900 s — Open-Meteo blends a
  15-minutely nowcast for `current`, itself another provenance wrinkle),
  plus top-level `generationtime_ms`, `utc_offset_seconds`, `timezone`,
  `elevation`. `generationtime_ms` is server *compute* latency for building
  the response, not data age — easy to misread as freshness and it is not.
- Forcing a single named model (`&models=gfs_seamless` etc.) does not add a
  run-time field either — same response shape, just one model instead of a
  blend.
- The only way to get an explicit run/issue time is
  **`single-runs-api.open-meteo.com/v1/forecast`** with a required
  `&run=2024-06-01T00:00`-style param (ISO 8601, no seconds) — but this
  requires the *caller* to already know/guess the run timestamp; the
  response still doesn't echo it back as a field, and `&run=` is rejected
  (400: `Parameter 'run' must not be set`) on both the general endpoint and
  `previous-runs-api`. Confirmed live for both rejection and acceptance
  cases.
- **`previous-runs-api.open-meteo.com/v1/forecast`** is a different tool: it
  adds `_previous_dayN` suffixed variables (e.g.
  `temperature_2m_previous_day1`) giving what a past run predicted for the
  *current* valid time, at fixed lead-time offsets (day1=24h stale,
  day2=48h, up to day7) — for backtesting forecast skill, not for learning
  what run issued today's numbers. Confirmed live, returns real diverging
  values for `_previous_day1` vs the live figure.
- Practical conclusion: **provenance (issue time, source model) is not
  observable from the endpoint the app already calls.** Getting it requires
  either accepting "unknown, best-effort blend" as the value, or adding a
  second, separate host + query (single-runs-api, guess-and-check on `run=`)
  purely to pin down what already-blended data came from.

## 4. Historical/archive and previous-runs APIs

- **Archive (`archive-api.open-meteo.com/v1/archive`, ERA5/ERA5-Land)** —
  what `fetchArchiveEnv` already uses. Per Open-Meteo's docs: ERA5/ERA5-Land
  update "daily with 5 days delay"; ERA5 is 0.25°/~25 km back to 1940,
  ERA5-Land 0.1°/~11 km back to 1950. Licensed the same CC BY 4.0 as the
  forecast data (see §5). Only publishes wind at 10 m and 100 m (matches
  the height mismatch already called out in `js/weather.js`'s comments), not
  the forecast endpoint's 80/120/180 m or any pressure level — a real gap if
  the snapshot ever needs a height/pressure-level *historical* record.
- **Previous-runs API** — described in §3; global models update every 6 h,
  regional models (HRRR, ICON-D2, AROME) every 1–3 h per the docs page.
  Coverage back to roughly January 2024 for most models (exceptions noted:
  GFS 2 m temperature from March 2021, JMA GSM/MSM from 2018).
- **Single-runs API** — described in §3; per its docs page, most of its 58
  archived models are available from "2nd of April 2026" (i.e. very recent
  as of this writing), with ECMWF IFS HRES (9 km) available further back, from
  March 2024.
- None of the three is needed for the live snapshot itself; previous-runs
  and single-runs are backtesting/model-skill tools, useful later for
  validating the snapshot's own accuracy, not for populating it in real time.

## 5. Update cadence, missing values, rate limits, commercial terms

**Cadence** (per `/en/docs/gfs-api` and `/en/docs/previous-runs-api`, not
independently re-verified beyond what's stated): GFS every 6 h, forecast to
16 days (`forecast_days` param, 0–16, default 7); HRRR every hour, 18 h
standard runs with 48 h on select (00/06/12/18Z) extended runs; NAM every 6 h
to 60 h; NBM hourly to 11 days.

**Missing-value behavior — two distinct shapes, both confirmed live:**
1. *Per-field null within a valid request*: forcing `models=ncep_hrrr_conus`
   and asking for 3 days (72 hourly points) returns real values through
   HRRR's actual horizon, then `null` for every remaining hour (16 of 72
   points null in the saved fixture, first null at index 56) — the array is
   never truncated. This matches `js/weather.js`'s existing
   `Number.isFinite`-based null handling, which should extend cleanly to
   pressure levels.
2. *Whole-request error when a model has no domain coverage at all*:
   `models=ncep_hrrr_conus` at Paris (48.85, 2.35) returns HTTP 200 with
   `{"error":true,"reason":"No data is available for this location"}` — not
   an array of nulls. A snapshot builder that ever pins a CONUS-only model
   must handle this as a request failure, not a per-field gap.
3. Separately, malformed/unsupported variable or model *names* (typos, not
   missing data) 400 with `{"error":true,"reason":"Data corrupted at path
   ''. Cannot initialize..."}` — a third, build-time-catchable failure mode,
   confirmed for both bad variable names and bad model names.

**Rate limits (free/non-commercial tier, per `/en/pricing`):** 600 calls/min,
5,000/hour, 10,000/day, 300,000/month. No API key, keyless, CORS-open —
matches how the app calls it today.

**Commercial terms (per `/en/pricing` and `/en/licence`):** free tier is
non-commercial only. Non-commercial examples given: private/non-profit sites
or apps with no subscriptions or ads, personal home-automation use, public
research, educational content. Commercial use requires a paid plan
(Standard/Professional/Enterprise) for a dedicated `customer-api.open-meteo.com`
endpoint and an API key. Data license is **CC BY 4.0** regardless of tier:
attribution required, with Open-Meteo's own example markup being a link
reading "Weather data by Open-Meteo.com" next to any place the data is
shown. Grepped the app for this — **not currently present** anywhere in
`index.html` or the `js/` tree (only a code comment mentioning Open-Meteo by
name, not a user-facing attribution link). Flagging, not fixing, per this
task's scope.

## 6. Elevation parameter behavior

Confirmed live: default response `elevation` (164.0 m at this point) comes
from Open-Meteo's own ~90 m DEM, used to statistically downscale
temperature-like variables by lapse rate to the site's true elevation rather
than the coarser model grid cell's elevation. Passing `&elevation=nan`
disables that downscaling and returns the raw model-grid elevation instead
(156.0 m at this point vs. the DEM's 164.0 m — an 8 m difference here, but
can be much larger in mountainous terrain, which is exactly where the
Froude-regime modeling this snapshot is for would care). Passing an explicit
`&elevation=500` overrides the site elevation used for downscaling entirely
(confirmed the response echoes back exactly what was sent). No behavior
change was tested for how this interacts with pressure-level variables
specifically (those are referenced to sea-level pressure surfaces, not site
elevation, so elevation-driven downscaling should only affect the
height-level/surface variables — inferred from field semantics, not
separately curl-verified).

---

## Proposed `ForecastSnapshot` field list, mapped to actual API fields

| Field | Source | Notes |
|---|---|---|
| `issueTimeUtc` | **Cannot be filled from `/v1/forecast`** | See below — not exposed by the endpoint the app calls. |
| `validTimeLocal` | `hourly.time[i]` (or `current.time`) | Offset-less wall-clock string per `timezone=auto`, same caveat already documented in `js/weather.js` about not comparing across zones. |
| `sourceModelId` | **Only reliable if `&models=` names one model explicitly** | See below — blended/seamless calls (the app's current default) don't report which model served a given hour. |
| `latitude`/`longitude`/`elevationM` | top-level `latitude`, `longitude`, `elevation` | `elevation` reflects 90 m DEM downscaling unless `&elevation=nan`/explicit override used (§6). |
| `surfaceWindMph`/`surfaceWindFromDeg` | `wind_speed_10m`/`wind_direction_10m` | Already read by the app at 80 m as its "surface-ish" default; true surface is the 10 m level. |
| `surfaceGustMph` | `wind_gusts_10m` | Only published at 10 m — app's existing gust-floor logic (`gustFloor` in `weather.js`) is the correct pattern to keep. |
| `heightLevelsM: {10,80,120,180}` → `{windMph, windFromDeg, tempF}` | `wind_speed_/wind_direction_/temperature_{h}m` | All four confirmed live and non-null in the same call (fixture 1). No arbitrary height — app owns interpolation between these four. |
| `pressureLevelsHpa: {1000,925,850,700,600,500}` → `{windMph, windFromDeg, tempF, geopotentialHeightM}` | `wind_speed_/wind_direction_/temperature_/geopotential_height_{p}hPa` | Confirmed live (fixture 2), same endpoint/host, same units system. |
| `pressureLevelWindUV` (derived) | **Not an API field — compute from speed+direction** | No u/v component variable exists at any level (§2); needed for shear/Froude vector math. |
| `interpolationPolicy` | **Not an API concept — app-defined** | Open-Meteo publishes discrete heights/pressure levels only; the snapshot must state its own between-level interpolation rule (e.g. log-linear by height or by pressure) since the API has none. |
| `missingValuePolicy` | **App-defined, informed by confirmed behavior** | Per-field `null` mid-array (extend existing `Number.isFinite` handling) vs. whole-request `{"error":true,...}` when a pinned regional model has no domain coverage (§5) — two different code paths needed, not one. |
| `stalenessFlag` | **Cannot be read from the response — must be computed** | No data-age field exists; `generationtime_ms` is compute time, not data age (§3). Staleness has to be inferred from wall-clock time since fetch vs. the model's documented cadence (GFS ~6 h, HRRR ~1 h), not from anything in the JSON. |
| `retrievedAtUtc` | client-side, not API | Timestamp the app's own fetch completed — needed precisely because the API won't say when its data was issued. |

### Fields we cannot fill, and why

1. **`issueTimeUtc` (model run/init time)** — not present in any field of
   the `/v1/forecast` response, blended or single-model. The only API that
   exposes it (`single-runs-api`) requires the caller to already supply the
   run timestamp via `&run=`, doesn't echo it back either, and is a
   different host/query the live snapshot path doesn't otherwise need.
2. **`sourceModelId` under the app's current call shape** — omitting
   `&models=` (today's behavior) invokes Open-Meteo's own seamless/
   best-match blend across models with no indication in the response of
   which model produced which hour or level. Reliable provenance requires
   switching to an explicit `&models=` value, which is a real design
   trade-off (see Decision impact).
3. **Raw u/v wind vector components at any level** — Open-Meteo only ever
   publishes speed + direction; confirmed no `wind_u_*`/`u_wind_*` naming
   exists at any level. Must be derived client-side.
4. **A true "data freshness"/"as of" field distinct from response-generation
   time** — `generationtime_ms` measures server compute latency for the
   HTTP response, not the age of the underlying model data; there is no
   substitute field. Staleness must be estimated, not read.
5. **Ensemble/confidence spread** — the endpoints tested here are all
   single deterministic runs (or a deterministic blend); no spread/ensemble
   member data was found in the response shapes exercised for this task.

## Decision impact

- **Extending the existing call is free.** Pressure-level wind/temperature/
  geopotential height at 1000–500 hPa ride on the exact same host and
  endpoint (`api.open-meteo.com/v1/forecast`) the app already calls with no
  new auth, no new CORS concern, and the same unit-conversion params
  already in use. This should be a parameter-list extension to the existing
  `fetchLiveEnv`/`shapeForecast` request, not a new integration.
- **Provenance (issue time + source model) forces a real trade-off.** If
  the snapshot contract requires those fields non-null and trustworthy, the
  app must stop omitting `&models=` and pin an explicit model (e.g.
  `gfs_seamless` or `gfs_hrrr`), giving up Open-Meteo's own best-match
  blending across models/regions. If the contract instead accepts
  `issueTimeUtc`/`sourceModelId` as legitimately unknown/best-effort for the
  live path, no extra call is needed — recommend this: pin `sourceModelId`
  to whatever `&models=` value was requested (a fact the app already knows,
  since it chose it) rather than trying to read it back from the API, and
  leave `issueTimeUtc` null/best-effort-estimated from documented cadence
  rather than paying for a second host round-trip against `single-runs-api`.
- **Missing-value handling needs a second code path, not just an extension
  of the existing one.** The existing `Number.isFinite` null-drop pattern
  in `weather.js`/`windprofile.js` correctly handles per-field nulls and
  should extend to pressure levels unchanged. But if any pinned regional
  model (HRRR/NAM/NBM) is ever used, the whole-request
  `{"error":true,"reason":"No data is available for this location"}` shape
  must be caught as a distinct failure — it will not show up as nulls.
- **No historical pressure-level or height-level (beyond 10/100 m) data
  exists in the archive API.** If the snapshot's contract ever needs a
  *historical* Froude/stability record (not just live), that's a genuine
  gap: ERA5 only has 10 m/100 m wind, no pressure levels, on a 5-day-delayed
  cadence. Out of scope to solve here, but worth flagging before anyone
  assumes `fetchArchiveEnv` could be extended the same trivial way as the
  live call.
- **Attribution is a live compliance gap, independent of this snapshot
  work.** The app is non-commercial (no subscriptions/ads visible) so the
  free CC BY 4.0 tier applies, but that license requires a visible
  attribution link the app does not currently have anywhere in `index.html`
  or the `js/` tree. Not part of this research task to fix; noting it since
  it surfaced while checking the license terms.
- **Rate limits are unlikely to bind.** 10,000 calls/day free-tier ceiling
  is far above what a per-pilot client-side planning app would generate;
  no action needed there.
