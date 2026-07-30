// brief.js — the exportable mission brief (Phase 4 item 8).
//
// One page a pilot saves, prints, or hands to a spotter before walking out to
// the launch point: where it is, how far the footprint reaches on each bearing,
// what the pack budget is, when to turn around, and the handful of warnings that
// actually change the flight. Everything on it is already on screen somewhere —
// the brief's whole job is to be the one artifact that survives losing signal, a
// dead phone, or being handed to somebody who isn't holding the goggles.
//
// This module is the data: plan + route + link + footprint in, a fully formatted
// brief structure out. Pure — no DOM, no state, no Leaflet — so the arithmetic
// and the wording are node-testable and js/render/brief.js is left with nothing
// but elements and an SVG. It imports render/format.js the way app.js does: that
// module is the display vocabulary, not a renderer, and a brief whose numbers are
// formatted differently from the cards they came off would read as a second,
// disagreeing answer.
//
// Two decisions worth stating out loud:
//
//   the clock is elapsed, not wall time. "Turn around at 4:10" is a number a
//     pilot can set on the OSD timer and check without looking away from the
//     goggles, and it stays true whatever time they actually launch — the whole
//     point of a brief written the night before. Wall time rides along as a
//     second line, and only when the forecast scrubber already knows which hour
//     is being planned for; the moment that is a guess, it is worse than nothing.
//
//   `times` is passed in rather than recomputed. The out/back clock split has one
//     implementation (render/dashboard.js's legTimes) and the brief has to print
//     the same seconds the hero card and the flight timer do, not its own
//     rounding of the same division.

import { f0, f1, mmss, compass, article } from './render/format.js';
import { plannedCourseDeg } from './terrain.js';
import { U } from './physics.js';

/** How many checklist lines the footer may carry. A list nobody reads is not a check. */
export const MAX_CHECKLIST = 6;

/** How many warnings print verbatim. The rest stay in the app, where they scroll. */
export const MAX_WARNINGS = 4;

/** The eight bearings the numbers table quotes reach on. */
export const CARDINALS = Object.freeze([
  { label: 'N', deg: 0 }, { label: 'NE', deg: 45 }, { label: 'E', deg: 90 }, { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 }, { label: 'SW', deg: 225 }, { label: 'W', deg: 270 }, { label: 'NW', deg: 315 },
]);

const MODE_WORDS = {
  headOut: 'out into the wind',
  tailOut: 'out downwind',
  cross: 'out crosswind',
};

/** Decimal degrees, five places — about a metre, and what a phone map takes back. */
export function formatDecimal(lat, lng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Degrees and decimal minutes: the form read out over a radio, and what most
 * handhelds and marine/air units want typed in. Zero-padded so the two halves
 * line up in a monospace column and a dropped digit is visible.
 */
export function formatDegMin(lat, lng) {
  const one = (v, neg, pos, pad) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${v < 0 ? neg : pos}${String(d).padStart(pad, '0')}°${m.toFixed(3).padStart(6, '0')}'`;
  };
  return `${one(lat, 'S', 'N', 2)} ${one(lng, 'W', 'E', 3)}`;
}

/** Radius on each of the eight cardinal bearings, off the map's own sweep. */
function cardinalReach(footprint, u) {
  const by = footprint && footprint.byCourse;
  if (!Array.isArray(by) || by.length < 360) return [];
  return CARDINALS.map(c => {
    const km = by[c.deg] || 0;
    return {
      ...c,
      km,
      text: km > 0 ? `${f1(u.distanceFromKm(km))} ${u.distanceUnit}` : '—',
    };
  });
}

function clockOf(plan, times, launchAt) {
  const ok = !!times && plan.radiusKm > 0 && isFinite(plan.timeMin);
  if (!ok) {
    return {
      ok: false,
      headline: 'No turnaround — nothing closes an out-and-back in this wind.',
      turn: '—', land: '—', outMin: null, backMin: null, totalMin: null, wall: null,
    };
  }
  const turn = mmss(times.outMin);
  const land = mmss(plan.timeMin);
  // toLocaleTimeString on a Date built from the forecast's own wall-clock tokens
  // round-trips the launch point's clock — see render/forecast.js for why that
  // holds, and for the one case (planning another timezone) where it doesn't.
  const at = (min) => new Date(launchAt.getTime() + min * 60000)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    ok: true,
    outMin: times.outMin, backMin: times.backMin, totalMin: plan.timeMin,
    turn, land,
    headline: `If you are not turned around by ${turn} on the timer, you are not coming home with reserve.`,
    wall: launchAt
      ? { launch: at(0), turn: at(times.outMin), land: at(plan.timeMin) }
      : null,
  };
}

function energyRows(plan, u, packLabel) {
  const e = plan.energy;
  const out = plan.legs.out, back = plan.legs.back;
  const closes = plan.radiusKm > 0 && out && back;
  const outWh = closes ? plan.radiusKm * out.whPerKm : null;
  const backWh = closes ? plan.radiusKm * back.whPerKm : null;
  const floorWh = e.deliveredWh * e.landFloorPct / 100;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const rows = [
    { label: 'In the pack', value: `${f1(e.packWh)} Wh`, note: `${packLabel} · nominal` },
    {
      label: 'Delivered',
      value: `${f1(e.deliveredWh)} Wh`,
      note: 'what this pack actually gives at this power and temperature',
    },
    {
      label: 'Out leg',
      value: outWh == null ? '—' : `${f1(outWh)} Wh`,
      note: closes ? `${dist(plan.radiusKm)} out at ${f1(u.burnFromWhPerKm(out.whPerKm))} ${u.burnUnit}` : 'no leg closes',
    },
    {
      label: 'Home leg',
      value: backWh == null ? '—' : `${f1(backWh)} Wh`,
      note: closes ? `${dist(plan.radiusKm)} home at ${f1(u.burnFromWhPerKm(back.whPerKm))} ${u.burnUnit}` : 'no leg closes',
    },
    {
      label: 'Held back',
      value: `${f1(e.reserveWh)} Wh`,
      note: `lands on about ${f0(e.reservePct)}% of what the pack delivers`,
    },
    {
      label: `Land floor · ${f0(e.landFloorPct)}%`,
      value: `${f1(floorWh)} Wh`,
      note: 'the charge you told the planner not to land below',
    },
  ];
  if (e.getHomeWh > 0) {
    const hunt = e.huntLandWh > 0 ? `, plus ${f1(e.huntLandWh)} Wh to find a spot and land` : '';
    const holds = e.holdsHeadwindMs == null ? null : f0(u.speedFromMs(e.holdsHeadwindMs));
    rows.push({
      label: 'Get home',
      value: `${f1(e.getHomeWh)} Wh`,
      note: `flying home from the turnaround into the planning wind${hunt}`
        + (holds ? ` — reserve holds to ${article(holds)} ${holds} ${u.speedUnit} headwind` : ''),
    });
  }
  return {
    rows,
    outWh, backWh, floorWh,
    binds: e.reserveBinds === 'getHome'
      ? 'Getting home caps the radius here, not the landing floor.'
      : 'The landing floor caps the radius here, not the flight home.',
    // The identity the numbers table has to satisfy on paper: what the pack
    // delivers is what the mission spends plus what it lands on.
    checkWh: closes ? outWh + backWh + e.reserveWh : null,
  };
}

function terrainLine(terrain, u) {
  if (!terrain) return null;
  const alt = (m) => `${f0(u.altFromM(m))} ${u.altUnit}`;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const climb = terrain.climbM;
  const climbWord = Math.abs(climb) < 3 ? 'level ground to the turnaround'
    : climb > 0 ? `ground climbs ${alt(climb)} to the turnaround`
    : `ground drops ${alt(-climb)} to the turnaround`;
  return `Terrain: ${climbWord}, high point ${alt(terrain.maxElevM)} at ${dist(terrain.maxElevAtKm)} out. `
    + `Least clearance ${alt(terrain.minClearanceM)} at ${dist(terrain.minClearanceAtKm)}, holding `
    + `${terrain.cruiseAltM} m above the launch point.`;
}

function linkLine(link, plan, u) {
  if (!link) return null;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  if (!link.blocked) {
    return `Radio: ${link.band.label} clear the whole way out to ${dist(link.legKm)} on this bearing.`;
  }
  return `Radio: ${link.band.label} usable to ${dist(link.clearKm)}, `
    + `${dist(Math.max(0, plan.radiusKm - link.clearKm))} short of the ${dist(plan.radiusKm)} the pack can fly`
    + (link.losBlockKm != null ? ` — the ground is across the ray itself by ${dist(link.losBlockKm)}.` : '.');
}

function routeSection(route, u) {
  if (!route || route.empty) return null;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const legs = route.legs.map((l, i) => ({
    name: route.legs.length === 1 ? 'Launch → home'
      : i === 0 ? 'Launch → 1'
      : i === route.legs.length - 1 ? `${i} → home`
      : `${i} → ${i + 1}`,
    dist: dist(l.distKm),
    course: `${f0(l.courseDeg)}° ${compass(l.courseDeg)}`,
    time: l.timeMin == null ? '—' : mmss(l.timeMin),
    wh: l.whLeg == null ? '—' : `${f1(l.whLeg)} Wh`,
  }));
  const verdict = route.unflyable
    ? 'This route cannot be flown as drawn — on at least one heading the wind beats every airspeed this rig holds.'
    : route.fits
      ? `Fits: ${dist(route.totalKm)} in ${mmss(route.totalMin)} for ${f1(route.totalWh)} Wh, `
        + `${f1(route.marginWh)} Wh of slack.`
      : `Does not fit: ${dist(route.totalKm)} costs ${f1(route.totalWh)} Wh, `
        + `${f1(-route.marginWh)} Wh past the budget.`;
  const loiter = route.fits && route.loiter
    ? `Loiter at the last waypoint: ${mmss(route.loiter.min)} on the ${f1(route.loiter.wh)} Wh spare.`
    : null;
  return {
    legs, verdict, loiter,
    totalKm: route.totalKm, totalMin: route.totalMin, totalWh: route.totalWh,
    note: 'The line home is direct from the last waypoint — what a failsafe flies — not back down the route.',
  };
}

/**
 * The footer checks, derived from this plan rather than printed from a template.
 * A generic list is a list nobody reads; every line here is either true of this
 * flight or absent from it. Capped at MAX_CHECKLIST, worst-first.
 */
function checklist({ plan, clock, link, terrain, route, env, u, expert }) {
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  // The raw gust peak against the usable top speed — the same ratio the verdict
  // card's "gusts are a big slice of top speed" caution is drawn on, so the
  // printed check and the card on screen turn on together.
  const gustMs = U.mphToMs(env.gustMph ?? 0);
  const items = [];
  if (clock.ok) {
    items.push(`Timer set and started at the launch — turn at ${clock.turn}, land at ${clock.land}.`);
  }
  if (plan.temps.cold) {
    items.push(plan.temps.packOverride
      ? `Packs warmer than the ${f0(U.cToF(plan.temps.packC))}°F you planned — cold packs sag hard on the first pull.`
      : 'Packs warm — kept in a pocket or a heated bag until the moment they go on the rig.');
  }
  items.push(terrain && terrain.maxElevM > terrain.launchElevM + 15
    ? `Failsafe RTH set, and RTH altitude above the ${f0(u.altFromM(terrain.maxElevM - terrain.launchElevM))} `
      + `${u.altUnit} of high ground on this leg.`
    : 'Failsafe set to RTH, and the RTH altitude is above everything between here and the turnaround.');
  if (expert && link && link.blocked) {
    items.push(`Video quits around ${dist(link.clearKm)} on this bearing — do not push past it.`);
  }
  if (plan.energy.sagLimited) {
    items.push('Land on the timer, not the low-voltage beep — this pack runs out of push before it runs out of energy.');
  }
  if (plan.speedLimitMs > 0 && gustMs / plan.speedLimitMs > 0.45) {
    items.push(`Gusts are a big share of this rig's ${f0(u.speedFromMs(plan.speedLimitMs))} ${u.speedUnit} `
      + 'top speed — stay low, behind cover, and keep the long lines for a calmer day.');
  }
  if (route && !route.empty) {
    items.push('Waypoints flown in numbered order; the leg home is the direct line from the last one.');
  }
  items.push('Spotter has these coordinates, the turnaround bearing, and the landing time.');
  return items.slice(0, MAX_CHECKLIST);
}

/**
 * Build the whole brief.
 *
 * Required: `plan` (a planMission result), `units` (a js/units.js system) and
 * `now`. Everything else is optional and simply drops its section — a brief
 * generated offline with no terrain profile, no route and no forecast hour is
 * still the artifact the pilot walks out with, which is the point of the feature.
 *
 * `expert` gates the figures the rail only offers in full-detail mode (the link
 * band, the terrain profile, the cruise level): in beginner mode they are pinned
 * to defaults the pilot never chose and sit behind full-only cards they cannot
 * see, and printing them would put numbers on paper that are nowhere on screen.
 * What survives the gate is everything a beginner can act on — the footprint,
 * the clock, the budget, the warnings, the checks.
 */
export function buildBrief({
  plan, verdict, warnings = [], footprint = null, route = null, link = null, terrain = null,
  launch = null, drone = null, battery = null, packCount = 1, payloadLabel = null, extraG = 0,
  env = {}, scenarioLabel = null, cruiseAltM = null, times = null, launchAt = null,
  units: u, now = new Date(), expert = true,
} = {}) {
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const spd = (mph) => f0(u.speedFromMph(mph));
  const packLabel = (battery ? battery.name : 'no pack') + (packCount > 1 ? ` ×${packCount}` : '');
  const droneLabel = drone ? (drone.name || drone.short || 'drone') : 'drone';
  const course = plannedCourseDeg(env.windFromDeg ?? 0, env.windMode);
  // The terrain profile lives behind a full-only card, so in beginner mode it is
  // dropped here rather than downstream — that keeps the elevation figures out of
  // the checklist wording too, which would otherwise quote a chart the pilot has
  // never been shown.
  const terr = expert ? terrain : null;
  const clock = clockOf(plan, times, launchAt);
  const energy = energyRows(plan, u, packLabel);
  const noLift = plan.flight.code === 'no_lift';

  const loadoutBits = [];
  if (payloadLabel) loadoutBits.push(payloadLabel);
  if (extraG > 0) loadoutBits.push(`+${f0(extraG)} g`);
  if (scenarioLabel) loadoutBits.push(scenarioLabel);
  if (expert && cruiseAltM != null) loadoutBits.push(`${cruiseAltM} m cruise`);

  return {
    generatedAt: now,
    title: `${droneLabel} · ${packLabel}`,
    dateLabel: now.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }),
    loadout: loadoutBits.join(' · '),
    verdict: verdict ? { level: verdict.level, label: verdict.label, why: verdict.why, fix: verdict.fix } : null,
    launch: launch ? {
      lat: launch.lat, lng: launch.lng,
      decimal: formatDecimal(launch.lat, launch.lng),
      degMin: formatDegMin(launch.lat, launch.lng),
    } : null,
    wind: {
      fromDeg: env.windFromDeg ?? 0,
      line: `${spd(env.windMph ?? 0)} ${u.speedUnit}`
        + ((env.gustMph ?? 0) > (env.windMph ?? 0) ? ` gusting ${spd(env.gustMph)}` : '')
        + ` from ${f0(env.windFromDeg ?? 0)}° (${compass(env.windFromDeg ?? 0)})`,
      airLine: `${f0(env.tempF ?? 0)}°F · ${f0(env.rhPct ?? 0)}% RH · `
        + `${f0(U.mToFt(plan.densityAltM))} ft density altitude`,
    },
    reach: {
      ok: !noLift && plan.radiusKm > 0,
      radiusKm: plan.radiusKm,
      radiusText: noLift ? 'WILL NOT FLY' : plan.radiusKm > 0 ? dist(plan.radiusKm) : 'no radius',
      courseDeg: course,
      courseText: `${f0(course)}° (${compass(course)}) — ${MODE_WORDS[env.windMode] || 'outbound'}`,
      areaText: footprint && footprint.areaKm2 > 0
        ? `${f1(u.areaFromKm2(footprint.areaKm2))} ${u.areaUnit}` : null,
    },
    cardinals: cardinalReach(footprint, u),
    clock,
    energy,
    // Verbatim, worst first — the wording on paper has to be the wording that was
    // on screen, or the brief becomes a second opinion.
    warnings: [...warnings]
      .sort((a, b) => ({ critical: 0, serious: 1, warning: 2 }[a.level] - { critical: 0, serious: 1, warning: 2 }[b.level]))
      .slice(0, MAX_WARNINGS)
      .map(w => ({ level: w.level, text: w.text })),
    warningsHeld: Math.max(0, warnings.length - MAX_WARNINGS),
    terrainLine: terrainLine(terr, u),
    linkLine: expert ? linkLine(link, plan, u) : null,
    route: routeSection(route, u),
    checklist: checklist({ plan, clock, link, terrain: terr, route, env, u, expert }),
  };
}
