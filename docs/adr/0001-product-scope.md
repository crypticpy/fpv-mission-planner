# 0001 — Product scope: mission confidence layer, not a GCS

**Status**: Accepted (2026-07-30)

## Decision

The product is a **mission confidence and validation layer for custom FPV
aircraft**: plan a specific cinematic mission with the exact aircraft, battery,
payload, route, terrain, forecast, radio assumptions, and reserve policy — then
explain whether the aircraft can complete it and return with margin.

One versioned mission model must answer five connected questions:

1. Can this exact loadout fly the proposed path?
2. Can it return under the selected reserve and wind policy?
3. Where do terrain, clearance, radio, density altitude, or wind make the
   mission fragile?
4. How does the route look in three dimensions, including cinematic intent?
5. What transfers to another planning or flight tool without losing meaning?

## Non-goals (hard boundaries)

- No arming, disarming, live vehicle command, telemetry ownership, or failsafe
  control. Ever.
- Not a replacement for QGroundControl, Mission Planner, INAV Configurator, or
  Betaflight Configurator — we export to them instead.
- No claim of exact mountain rotor or turbulence location from coarse forecast
  data; advisories only, with uncertainty stated.
- No UI surface ever calls a map cell, route, or condition "safe". The best we
  say is "low modeled forcing" or "no constraint violated by the model".
- No UI-framework rewrite to support these features.
- No cloud accounts, collaboration, or social features before the local mission
  model is complete.

## Why

The physics/route/RF/brief core (310 passing tests) is the differentiator;
generic GCS features are a crowded, safety-critical space we do not want to own.
The confidence-layer framing keeps every milestone pointed at the same output:
one trusted analysis of one saved mission.

## Consequences

- The saved mission, route corridor, and analysis snapshot — not the map — are
  the center of the application (ADRs 0002–0004).
- Feature proposals that require live vehicle connectivity are rejected on
  scope, not on effort.
