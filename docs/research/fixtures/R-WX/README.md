# R-WX fixtures — Open-Meteo raw responses

All retrieved 2026-07-30 (UTC) against the live public API for the Austin, TX
area (30.27, -97.74 — the app's `DEFAULT_LAUNCH`, see `js/weather.js`). No API
key used (free/non-commercial tier). Saved verbatim (`curl -s <url>`), no
post-processing.

## hourly_height_levels.json

Height-level wind + temperature at the four AGL heights the app's
`CRUISE_ALTS_M` already reads, plus 2 m temperature and 10 m gust.

Request URL:
```
https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74&hourly=wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m,wind_speed_180m,wind_direction_180m,temperature_80m,temperature_120m,temperature_180m,wind_gusts_10m,temperature_2m&forecast_days=2&timezone=auto&wind_speed_unit=mph&temperature_unit=fahrenheit
```

Confirms: `temperature_80m`/`120m`/`180m` are real published variables (not
silently dropped/null) alongside the wind pair at each height — useful for a
lapse-rate estimate without a pressure-level call.

## hourly_pressure_levels.json

Pressure-level wind, temperature, and geopotential height at 1000, 925, 850,
700, and 500 hPa — the mountain-flow-relevant slice of Open-Meteo's full
19-level stack (1000 down to 30 hPa).

Request URL:
```
https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74&hourly=temperature_1000hPa,temperature_925hPa,temperature_850hPa,temperature_700hPa,temperature_500hPa,wind_speed_1000hPa,wind_direction_1000hPa,wind_speed_925hPa,wind_direction_925hPa,wind_speed_850hPa,wind_direction_850hPa,wind_speed_700hPa,wind_direction_700hPa,wind_speed_500hPa,wind_direction_500hPa,geopotential_height_1000hPa,geopotential_height_925hPa,geopotential_height_850hPa,geopotential_height_700hPa,geopotential_height_500hPa&forecast_days=2&timezone=auto&wind_speed_unit=mph&temperature_unit=fahrenheit
```

Confirms: pressure-level variables are on the same `/v1/forecast` endpoint the
app already calls (no separate host), same units system as `wind_speed_unit`/
`temperature_unit`, geopotential height in meters. Sanity-checked the values:
1000 hPa geopotential height ~108 m (site elevation is 164 m — 1000 hPa is
below-ground here, expected), 850 hPa ~1540 m, 500 hPa ~5948 m — all physically
reasonable.

## hrrr_horizon_nulls.json

Demonstrates missing-value behavior at a regional model's forecast horizon,
not just a spatial edge.

Request URL:
```
https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74&hourly=wind_speed_80m&models=ncep_hrrr_conus&forecast_days=3&timezone=auto
```

Confirms: forcing HRRR-only (`models=ncep_hrrr_conus`) and asking for 3 days
(72 hourly points) returns real values through the model's actual horizon and
then `null` for every hour past it (16 of 72 points null, starting at index 56
≈ hour 56) — the array is not truncated, and the per-field null pattern from
`js/weather.js`'s `Number.isFinite` handling is the correct way to detect this.
Separately (not saved as a fixture, see R-WX.md): requesting `ncep_hrrr_conus`
for a location outside CONUS (Paris, 48.85/2.35) does not return per-field
nulls at all — it returns an HTTP-level error
`{"error":true,"reason":"No data is available for this location"}`. Two
different failure shapes for two different kinds of "missing."
