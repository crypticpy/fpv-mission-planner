// render/terrain.js — the ground under the outbound leg, on screen (Phase 4
// item 5): when to go fetch a profile, the elevation/clearance chart, the
// sentence under it, and the warnings the verdict rail carries on both tabs.
//
// All the arithmetic lives in js/terrain.js; this module owns the wording, the
// chart, and the one piece of policy a render module is the right place for —
// deciding that a profile on screen is now describing the wrong bearing.
import {
  PROFILE_SAMPLES, CLEARANCE_WARN_M,
  plannedCourseDeg, profileSpanKm, profileCoords, fetchElevationProfile, buildProfile,
  terrainStats, setProfile, activeProfile, profileMatches, usingTerrainElev,
} from '../terrain.js';
import { launchPoint } from '../weather.js';
import { state, beginner, units } from '../state.js';
import { lineChart, legend } from '../charts.js';
import { f0, f1, compass } from './format.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update }
export function setupTerrain(d) { deps = d; }

/* ---------- fetching ---------- */

let seq = 0;
let timer = 0;
let fetching = false;
let errMsg = null;
let failedSig = null; // the ask that failed; retried only once the ask changes

const sigOf = ({ launch, bearingDeg, spanKm }) =>
  `${launch.lat.toFixed(4)},${launch.lng.toFixed(4)}@${Math.round(bearingDeg)}/${spanKm.toFixed(1)}`;

/** What the current plan wants profiled: from here, along there, this far. */
function currentAsk(radiusKm) {
  return {
    launch: launchPoint(),
    bearingDeg: plannedCourseDeg(state.env.windFromDeg, state.env.windMode),
    spanKm: profileSpanKm(radiusKm),
  };
}

/**
 * Bring the terrain profile in step with the plan, fetching one if the profile on
 * hand doesn't answer the question being asked (the pin moved, the wind swung the
 * outbound leg around, or the mission now reaches past the end of the data).
 *
 * Debounced, because update() runs on every keystroke, and idempotent, because
 * the fetch landing triggers another update(). A failure is remembered so a dead
 * connection is asked once per question rather than once per render — the planner
 * carries on at the launch elevation, which is exactly what it did before this
 * feature existed.
 */
export function refreshTerrain(radiusKm) {
  const ask = currentAsk(radiusKm);
  if (profileMatches(activeProfile(), ask)) { errMsg = null; return; }
  const sig = sigOf(ask);
  if (fetching || sig === failedSig) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void runFetch(ask, sig); }, 500);
}

async function runFetch(ask, sig) {
  const mine = ++seq;
  fetching = true;
  errMsg = null;
  try {
    const coords = profileCoords(ask.launch, ask.bearingDeg, ask.spanKm, PROFILE_SAMPLES);
    const elevsM = await fetchElevationProfile(coords);
    if (mine !== seq) return; // a later ask superseded this one
    setProfile(buildProfile({ launch: ask.launch, bearingDeg: ask.bearingDeg, coords, elevsM }));
    failedSig = null;
  } catch (err) {
    if (mine !== seq) return;
    errMsg = err.message;
    failedSig = sig;
  } finally {
    if (mine === seq) {
      fetching = false;
      deps.update();
    }
  }
}

/* ---------- the numbers, read against the current plan ---------- */

function statsFor(r) {
  const p = activeProfile();
  if (!p) return null;
  const ask = currentAsk(r.radiusKm);
  // A profile drawn on a bearing the plan no longer flies is not evidence about
  // this mission: hold the figures back until the refetch lands.
  if (!profileMatches(p, ask)) return null;
  return terrainStats(p, { cruiseAltM: state.cruiseAltM, radiusKm: r.radiusKm });
}

const MODE_WORDS = {
  headOut: 'into the wind',
  tailOut: 'downwind out',
  cross: 'crosswind',
};

function bearingPhrase() {
  const deg = plannedCourseDeg(state.env.windFromDeg, state.env.windMode);
  return `${deg}° (${compass(deg)}) — ${MODE_WORDS[state.env.windMode] || 'outbound'}`;
}

/**
 * The terrain callouts for the verdict rail, on both tabs. Kept out of
 * physics.js: the model is handed an elevation and knows nothing about ground.
 */
export function terrainWarnings(r) {
  const s = statsFor(r);
  if (!s || !(r.radiusKm > 0)) return [];
  const u = units();
  const alt = (m) => `${f0(u.altFromM(m))} ${u.altUnit}`;
  const at = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const out = [];
  if (s.minClearanceM <= 0) {
    out.push({
      level: 'critical',
      text: `Terrain above your cruise altitude: the ground ${at(s.minClearanceAtKm)} out on the `
        + `${bearingPhrase()} leg rises ${alt(-s.minClearanceM)} higher than a cruise held `
        + `${s.cruiseAltM} m above the launch point. Climb over it, or pick another bearing — the `
        + 'footprint ring is energy only and knows nothing about the hill.',
    });
  } else if (s.minClearanceM < CLEARANCE_WARN_M) {
    out.push({
      level: 'serious',
      text: `Only ${alt(s.minClearanceM)} of clearance ${at(s.minClearanceAtKm)} out on the `
        + `${bearingPhrase()} leg, cruising ${s.cruiseAltM} m above the launch point. `
        + 'Trees and towers live in that gap.',
    });
  }
  return out;
}

/* ---------- the card ---------- */

/**
 * Elevation and clearance along the leg. Map tab, expert only — the warning above
 * is the part a beginner needs, and it rides the verdict rail on both tabs.
 */
export function renderTerrainCard(r) {
  const card = $('terrain-card');
  if (beginner()) { card.hidden = true; return; }
  card.hidden = false;
  const u = units();
  const p = activeProfile();
  const s = statsFor(r);
  const note = $('terrain-note');
  const empty = $('terrain-empty');
  const chart = $('chart-terrain');

  if (!s) {
    chart.replaceChildren();
    legend($('legend-terrain'), []);
    empty.hidden = false;
    empty.textContent = errMsg
      ? `No elevation data for this spot (${errMsg}) — planning at the launch elevation, `
        + 'the same as every offline flight. Everything else on this page is unaffected.'
      : p
        ? 'Reading the ground along the new outbound leg…'
        : 'Fetching the ground along the outbound leg…';
    note.textContent = '';
    return;
  }
  empty.hidden = true;

  const alt = (m) => `${f0(u.altFromM(m))} ${u.altUnit}`;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const ground = {
    name: 'Ground', color: 'var(--series-2)',
    pts: p.points.filter(pt => pt.distKm <= s.legKm + 1e-9)
      .map(pt => ({ x: u.distanceFromKm(pt.distKm), y: u.altFromM(pt.elevM) })),
  };
  // The turnaround is where the plan actually stops, so the ground line stops
  // there too — with the interpolated point on the end when it lands mid-sample.
  const lastX = u.distanceFromKm(s.legKm);
  if (ground.pts[ground.pts.length - 1].x < lastX - 1e-9) {
    ground.pts.push({ x: lastX, y: u.altFromM(s.turnaroundElevM) });
  }
  const planned = {
    name: `Planned altitude · ${s.cruiseAltM} m above launch`, color: 'var(--series-4)', dash: '6 5',
    pts: [{ x: 0, y: u.altFromM(s.planAltM) }, { x: lastX, y: u.altFromM(s.planAltM) }],
  };
  const series = [ground, planned];
  legend($('legend-terrain'), series);
  lineChart(chart, {
    series, height: 220,
    markers: [
      { x: lastX, y: u.altFromM(s.turnaroundElevM), color: 'var(--series-4)', label: 'turnaround' },
      ...(s.minClearanceAtKm > 0 && s.minClearanceM < s.turnClearanceM
        ? [{
          x: u.distanceFromKm(s.minClearanceAtKm), y: u.altFromM(s.maxElevM),
          color: 'var(--status-serious)', label: 'least clearance', labelBelow: true,
        }]
        : []),
    ],
    // Sea level is never the interesting part of an elevation chart; the ground
    // line would be a flat scratch at the top of the panel.
    yMin: Math.floor(u.altFromM(Math.min(s.launchElevM, s.maxElevM)) / 50) * 50 - 50,
    yFmt: v => `${f0(v)} ${u.altUnit}`,
    xFmt: v => `${f1(v)}`,
    xLabel: `distance out (${u.distanceUnit})`,
    yLabel: u.altUnit,
    tipTitle: 'Out',
  });

  const climb = s.climbM;
  const climbWord = Math.abs(climb) < 3 ? 'The ground is level out to the turnaround'
    : climb > 0 ? `The ground climbs ${alt(climb)} from launch to the turnaround`
    : `The ground drops ${alt(-climb)} from launch to the turnaround`;
  note.textContent =
    `Profiled along ${bearingPhrase()}, ${PROFILE_SAMPLES} samples out to ${dist(s.legKm)}. `
    + `${climbWord}. `
    + (usingTerrainElev(state.env.elevFt)
      ? `The plan runs the turnaround's air, ${alt(s.turnaroundElevM)} elevation and `
        + `${alt(r.densityAltM)} density altitude — not the launch point's. `
      : `Launch elevation ${f0(state.env.elevFt)} ft doesn't match this ground, so the plan is still `
        + 'running the elevation on the rail — a preset sky over a real map. ')
    + `Least clearance ${alt(s.minClearanceM)} at ${dist(s.minClearanceAtKm)} out, holding `
    + `${s.cruiseAltM} m above the launch point. Elevation data: Open-Meteo (Copernicus DEM), `
    + 'terrain only — it knows nothing about trees, towers or wires.';
}
