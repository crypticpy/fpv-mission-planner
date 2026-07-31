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
// and the wording are node-testable and src/render/brief.js is left with nothing
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
import { U } from './domain/physics.js';
import { SEVERITY_RANK } from './application/analysis/analysis-contracts.js';

/** @param {string} severity */
const rank = (severity) => SEVERITY_RANK[severity] ?? SEVERITY_RANK.unknown;

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

/** Human words for ADR 0010 §2's concept ids — the same vocabulary render/missions.js's export note uses. */
const CONCEPT_LABELS = {
  geometry: 'route geometry',
  'altitude-reference': 'altitude reference',
  speed: 'speed policy',
  hold: 'hold time',
  'camera-intent': 'camera intent',
  'return-policy': 'return policy',
  reserve: 'reserve policy',
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

/**
 * How long ago an ISO instant was, in the pilot's words rather than a
 * timestamp — the same bucketing render/missions.js's `ago()` reads a save
 * time with, but taking `now` as an argument instead of reading the clock
 * itself, so a test can pin the age without waiting on a real one.
 * @param {string|null|undefined} iso
 * @param {Date} now
 * @returns {string|null}
 */
function ageFrom(iso, now) {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.max(0, (now.getTime() - t) / 60000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The Evidence section (ADR 0012 §6): what the figures above are actually
 * standing on, stated in words rather than left for the pilot to infer from a
 * verdict alone — where the forecast came from and how stale it is, where the
 * ground came from and how stale that sample is, the flight-log calibration
 * behind the power model, and the analysis build that did the arithmetic.
 *
 * Every word here is already sitting on the analysis snapshot or the mission
 * document the caller read it off (ADR 0002) — this function formats, it does
 * not look anything up or recompute anything. `evidence` is null before a
 * mission has ever been analysed (nothing to attribute yet), and the section
 * drops entirely rather than printing a page of dashes.
 *
 * @param {{
 *   forecast: { source: string, retrievedAt: string|null }|null,
 *   terrainSource: string|null, samplingResolution: string|null,
 *   groundRetrievedAt: string|null,
 *   calibrationSource: string|null, modelVersion: string|null,
 * }|null} evidence
 * @param {Date} now
 * @returns {string[]|null}
 */
function evidenceSection(evidence, now) {
  if (!evidence) return null;
  const lines = [];
  const forecast = evidence.forecast;
  const forecastAge = forecast ? ageFrom(forecast.retrievedAt, now) : null;
  lines.push(forecast
    ? `Forecast: ${forecast.source}${forecastAge ? `, captured ${forecastAge}` : ''}.`
    : 'Forecast: manual — authored by the pilot.');
  if (evidence.terrainSource) {
    const groundAge = ageFrom(evidence.groundRetrievedAt, now);
    const detail = evidence.samplingResolution ? `, ${evidence.samplingResolution}` : '';
    lines.push(`Terrain: ${evidence.terrainSource}${detail}${groundAge ? `, sampled ${groundAge}` : ''}.`);
  }
  if (evidence.calibrationSource) lines.push(`Calibration: ${evidence.calibrationSource}.`);
  if (evidence.modelVersion) lines.push(`Analysis model: ${evidence.modelVersion}.`);
  return lines.length ? lines : null;
}

/**
 * How the subject crosses the frame, in words rather than in the pipeline's
 * token. Shared with the map inspector's wording in substance, shortened here
 * because it sits inside a table cell.
 */
const SCREEN_WORD = {
  'left-to-right': 'crossing left to right',
  'right-to-left': 'crossing right to left',
  toward: 'closing head-on',
  away: 'falling behind',
  held: 'held in frame',
};

/**
 * What one leg is filming, or '' where it films nothing.
 *
 * Every number in it is the analysis's own `shot` record (ADR 0011 §3) — this
 * function converts units and picks words, and computes no geometry. A segment
 * with no shot still names its intent, because "orbit" on a leg with no subject
 * attached is exactly the thing a pilot needs to notice on the page.
 *
 * @param {object|null} seg  the SegmentAnalysis for this leg, if there is one
 * @param {object} u  the unit system
 * @returns {string}
 */
function shotPhrase(seg, u) {
  if (!seg) return '';
  const shot = seg.shot;
  if (!shot) return seg.intent && seg.intent !== 'transit' ? seg.intent : '';

  const len = (m) => `${f0(u.altFromM(m))} ${u.altUnit}`;
  const bits = [`${seg.intent} ${shot.subjectName}`];

  if (shot.distanceStartM != null && shot.distanceEndM != null) {
    const a = Math.round(u.altFromM(shot.distanceStartM));
    const b = Math.round(u.altFromM(shot.distanceEndM));
    bits.push(a === b ? `at ${len(shot.distanceStartM)}` : `${len(shot.distanceStartM)} → ${len(shot.distanceEndM)}`);
  } else if (shot.distanceEndM != null) {
    bits.push(`at ${len(shot.distanceEndM)}`);
  }

  if (shot.framingStart != null && shot.framingEnd != null) {
    bits.push(`${f0(shot.framingStart * 100)}–${f0(shot.framingEnd * 100)}% of frame`);
  }

  const dir = shot.screenDirection ? SCREEN_WORD[shot.screenDirection] : null;
  if (dir) bits.push(dir);
  return bits.join(', ');
}

/**
 * The route table, one row per leg of the flown line.
 *
 * The rows are the *segments* now rather than the integrator's legs: an authored
 * leg is a shot with an intent and possibly a subject, and only the segment
 * knows that. The figures are unchanged and cannot change — a SegmentAnalysis
 * carries the integrator's own `distanceKm`, `courseDeg`, `timeMin` and
 * `flightWh` for its leg verbatim, and `flightWh` is specifically the
 * level-flight figure the route solved, not the dwell-inclusive `energyWh`. The
 * totals below the table were never per-leg sums in the first place; they come
 * off `route` as they always did.
 *
 * The flight home has no segment because nobody authored it, so it keeps
 * reading off the leg. That is the row the note at the foot is about.
 *
 * @param {object|null} route
 * @param {Record<string, object>|null|undefined} segments  keyed by segment id
 * @param {object} u
 */
function routeSection(route, segments, u) {
  if (!route || route.empty) return null;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;

  /* Segment k arrives at waypoint k, which is the integrator's leg k — the same
     mapping the map's own route spans are built on. */
  const byIndex = [];
  for (const seg of Object.values(segments ?? {})) {
    if (Number.isInteger(seg?.index) && seg.index >= 0) byIndex[seg.index] = seg;
  }

  const legs = route.legs.map((l, i) => {
    const seg = byIndex[i] ?? null;
    return {
      name: route.legs.length === 1 ? 'Launch → home'
        : i === 0 ? 'Launch → 1'
        : i === route.legs.length - 1 ? `${i} → home`
        : `${i} → ${i + 1}`,
      dist: dist(seg ? seg.distanceKm : l.distKm),
      course: seg
        ? `${f0(seg.courseDeg)}° ${compass(seg.courseDeg)}`
        : `${f0(l.courseDeg)}° ${compass(l.courseDeg)}`,
      time: (seg ? seg.timeMin : l.timeMin) == null ? '—' : mmss(seg ? seg.timeMin : l.timeMin),
      wh: (seg ? seg.flightWh : l.whLeg) == null ? '—' : `${f1(seg ? seg.flightWh : l.whLeg)} Wh`,
      shot: shotPhrase(seg, u),
    };
  });
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
 * Per exportable format, what would travel if this mission were handed to
 * another tool right now — or null when there is nothing to report (no
 * mission open, or the caller did not wire compatibility in). Every named loss
 * carries the disposition `deriveLosses` gave it, exactly as ADR 0010 §2 states
 * it: this prints what the exporter would actually do, not a guess at it.
 */
function exportCompatSection(compatibility) {
  if (!compatibility.length) return null;
  return compatibility.map((c) => ({
    label: c.label,
    text: c.losses.length
      ? c.losses.map(l => `${CONCEPT_LABELS[l.concept] ?? l.concept} (${l.disposition})`).join(', ')
      : 'everything this brief covers travels',
  }));
}

/**
 * Build the whole brief.
 *
 * Required: `plan` (a planMission result), `units` (a src/domain/units.js system) and
 * `now`. Everything else is optional and simply drops its section — a brief
 * generated offline with no terrain profile, no route and no forecast hour is
 * still the artifact the pilot walks out with, which is the point of the feature.
 *
 * `segments` is the analysis's own segment map, keyed by id. It rides beside
 * `route` rather than replacing it because the two answer different questions —
 * the route is the whole flown line including the failsafe home, the segments are
 * only what somebody authored — and a brief printed without it still prints every
 * figure it printed before, just with no shot wording.
 *
 * `expert` gates the figures the rail only offers in full-detail mode (the link
 * band, the terrain profile, the cruise level): in beginner mode they are pinned
 * to defaults the pilot never chose and sit behind full-only cards they cannot
 * see, and printing them would put numbers on paper that are nowhere on screen.
 * What survives the gate is everything a beginner can act on — the footprint,
 * the clock, the budget, the warnings, the checks.
 *
 * `evidence` (ADR 0012 §6) is the Evidence section's raw material — forecast
 * and terrain provenance plus the calibration and model version, bundled by
 * the caller from the analysis snapshot and the mission document, or null
 * where there is nothing yet to attribute.
 *
 * `redactCoordinates` (ADR 0012 §6) withholds the launch point's printed
 * lat/lng — the one place a bare coordinate string appears in this brief —
 * for a copy meant to leave the pilot's hands. It never touches the energy or
 * reserve figures; a shareable brief is the same flight, minus where it is.
 */
export function buildBrief({
  plan, verdict, warnings = [], footprint = null, route = null, segments = null,
  link = null, terrain = null,
  launch = null, drone = null, battery = null, packCount = 1, payloadLabel = null, extraG = 0,
  env = {}, scenarioLabel = null, cruiseAltM = null, times = null, launchAt = null,
  terrainAttribution = null, compatibility = [],
  units: u, now = new Date(), expert = true,
  evidence = null, redactCoordinates = false,
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
      decimal: redactCoordinates ? 'withheld' : formatDecimal(launch.lat, launch.lng),
      degMin: redactCoordinates ? 'withheld' : formatDegMin(launch.lat, launch.lng),
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
    // on screen, or the brief becomes a second opinion. Same array, same order and
    // the same ADR 0008 ranking the warning rail sorts by, so the codes that print
    // here are the first N codes on that rail (ADR 0008's cross-surface rule).
    warnings: [...warnings]
      .sort((a, b) => rank(a.severity) - rank(b.severity))
      .slice(0, MAX_WARNINGS)
      .map(w => ({ code: w.code, severity: w.severity, text: w.text })),
    warningsHeld: Math.max(0, warnings.length - MAX_WARNINGS),
    terrainLine: terrainLine(terr, u),
    linkLine: expert ? linkLine(link, plan, u) : null,
    // The licence the elevation data travels under (CC BY 4.0), printed whenever
    // the analysis read ground — which is not the same as whenever the terrain
    // *section* prints. Beginner mode drops the elevation figures but the
    // route's clearance findings still came off that DEM, and a credit that
    // disappeared with the chart would not be travelling with the work.
    dataLine: typeof terrainAttribution === 'string' && terrainAttribution ? terrainAttribution : null,
    evidence: evidenceSection(evidence, now),
    route: routeSection(route, segments, u),
    checklist: checklist({ plan, clock, link, terrain: terr, route, env, u, expert }),
    exportCompat: exportCompatSection(compatibility),
  };
}
