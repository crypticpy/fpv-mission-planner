// render/terrain.js — the ground under the outbound leg, on screen (Phase 4
// items 5 and 6): when to go fetch a profile, the elevation/clearance chart with
// the radio line of sight over it, the sentences under it, and the warnings the
// verdict rail carries on both tabs.
//
// All the arithmetic lives in src/terrain.js and src/rf.js; this module owns the
// wording, the chart, and the one piece of policy a render module is the right
// place for — deciding that a profile on screen is now describing the wrong
// bearing.
import {
  PROFILE_SAMPLES, CLEARANCE_WARN_M,
  plannedCourseDeg, profileSpanKm, profileCoords, fetchElevationProfile, buildProfile,
  terrainStats, setProfile, activeProfile, profileMatches, usingTerrainElev, elevAtKm,
} from '../terrain.js';
import {
  FRESNEL_CLEAR_FRAC, ANTENNA_HEIGHT_M, linkBand, linkProfile, bandReaches,
} from '../rf.js';
import { launchPoint } from '../weather.js';
import { state, beginner, units } from '../state.js';
import { lineChart, legend } from '../charts.js';
import { f0, f1, compass } from './format.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update, revision, accept }
export function setupTerrain(d) { deps = d; }

/* ---------- fetching ---------- */

let seq = 0;
let timer = 0;
let fetching = false;
let errMsg = null;
let failedSig = null; // the ask that failed; retried only once the ask changes
let lastRadiusKm = 0; // what the last render asked to profile, so a dropped fetch can re-ask

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
  lastRadiusKm = radiusKm;
  const ask = currentAsk(radiusKm);
  if (profileMatches(activeProfile(), ask)) { errMsg = null; return; }
  const sig = sigOf(ask);
  if (fetching || sig === failedSig) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void runFetch(ask, sig); }, 500);
}

/**
 * Fetch one profile and hand it over — unless the mission moved on first.
 *
 * Two guards, not one, because they answer different questions. `seq` is local:
 * did *this module* start a newer fetch? `deps.accept` is the analysis host's:
 * is the mission this was asked about still the mission on screen? A profile
 * drawn for a launch point the pilot has already left is not evidence about
 * anything, so it is dropped rather than rendered — and re-asked immediately,
 * because a drop with no re-ask would leave the app waiting on an answer that
 * had already come and gone.
 */
async function runFetch(ask, sig) {
  const mine = ++seq;
  const asked = deps.revision();
  fetching = true;
  errMsg = null;
  let stale = false;
  try {
    const coords = profileCoords(ask.launch, ask.bearingDeg, ask.spanKm, PROFILE_SAMPLES);
    const elevsM = await fetchElevationProfile(coords);
    if (mine !== seq) return; // a later ask superseded this one
    stale = !deps.accept(asked, 'terrain profile');
    if (stale) return;
    setProfile(buildProfile({ launch: ask.launch, bearingDeg: ask.bearingDeg, coords, elevsM }));
    failedSig = null;
  } catch (err) {
    if (mine !== seq) return;
    stale = !deps.accept(asked, 'terrain profile');
    if (stale) return;
    errMsg = err.message;
    failedSig = sig;
  } finally {
    if (mine === seq) {
      fetching = false;
      // A dropped result renders nothing — that is the point — so it has to put
      // the question back on the wire itself.
      if (stale) refreshTerrain(lastRadiusKm);
      else deps.update();
    }
  }
}

/* ---------- the numbers, read against the current plan ---------- */

/**
 * The ground read against the current plan, or null when no profile describes
 * this leg. Exported for the mission brief (Phase 4 item 8), which prints the
 * same climb and clearance figures this module's card and warnings are written
 * from — one profile, one set of numbers.
 */
export function terrainStatsFor(r) {
  const p = activeProfile();
  if (!p) return null;
  const ask = currentAsk(r.radiusKm);
  // A profile drawn on a bearing the plan no longer flies is not evidence about
  // this mission: hold the figures back until the refetch lands.
  if (!profileMatches(p, ask)) return null;
  return terrainStats(p, { cruiseAltM: state.cruiseAltM, radiusKm: r.radiusKm });
}

/**
 * The radio read against the current plan (Phase 4 item 6), or null when there is
 * no profile describing this leg. Computed once per render pass in app.js and
 * handed to everything that draws it — the warnings, the chart, and the map's
 * outbound leg — so the three cannot disagree about where the link quits.
 *
 * The band the pilot selected is the analysis; every band comes back alongside it,
 * because "5.8 GHz is blocked at 1.4 km" is only half the field answer.
 */
export function linkStats(r) {
  const p = activeProfile();
  if (!p || !(r.radiusKm > 0)) return null;
  if (!profileMatches(p, currentAsk(r.radiusKm))) return null;
  const opts = { cruiseAltM: state.cruiseAltM, radiusKm: r.radiusKm };
  const band = linkBand(state.linkBand);
  const link = linkProfile(p, { ...opts, ghz: band.ghz });
  if (!link) return null;
  return { ...link, band, bands: bandReaches(p, opts) };
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
  const s = terrainStatsFor(r);
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

/**
 * The link callouts for the verdict rail (Phase 4 item 6) — the "energy OK, link
 * blocked" case: the ring says you can get there and the ground says you will be
 * flying blind before you do.
 *
 * Two levels, because a cut ray and a clipped Fresnel zone are different flights.
 * Both carry the same caveat: one bearing is profiled, and the ring around it is
 * still energy only.
 */
export function linkWarnings(r, link) {
  if (!link || !link.blocked) return [];
  const u = units();
  const at = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const reach = at(r.radiusKm);
  const others = link.bands.filter(b => b.id !== link.band.id)
    .map(b => `${b.label} ${b.blocked ? `to ${at(b.clearKm)}` : 'clear to the turnaround'}`)
    .join(', ');
  const tail = ` The other bands on the same ground: ${others} — a fatter, lower-band zone flags first, `
    + 'but a 900 MHz control link also punches through an intrusion that has already killed the video. '
    + 'Only this bearing is profiled; the footprint ring is still energy only.';
  if (link.losBlockKm != null) {
    return [{
      level: 'critical',
      // One actionable distance — link.clearKm, the same number the chart marks
      // and the map clips the leg at. Where the ray itself dies is in the card's
      // note; here it would just be a second, nearly identical mile figure.
      text: `Energy OK, link blocked: the pack reaches ${reach} out on the ${bearingPhrase()} leg, but a `
        + `rise ${at(link.losRidgeKm)} out cuts the link to the ${link.cruiseAltM} m cruise `
        + `${at(link.clearKm)} from launch. Past that you are flying an aircraft you cannot see.${tail}`,
    }];
  }
  return [{
    level: 'serious',
    text: `Energy OK, link degrading: the ${link.band.label} first Fresnel zone is more than `
      + `${Math.round((1 - FRESNEL_CLEAR_FRAC) * 100)}% obstructed by the ground at `
      + `${at(link.fresnelRidgeKm)} from ${at(link.fresnelBlockKm)} out, though the ray itself still clears `
      + `it. Expect breakup and dropouts over the last ${at(Math.max(0, r.radiusKm - link.fresnelBlockKm))} `
      + `of the ${reach} the pack can do.${tail}`,
  }];
}

/* ---------- the card ---------- */

/**
 * Elevation and clearance along the leg. Map tab, expert only — the warning above
 * is the part a beginner needs, and it rides the verdict rail on both tabs.
 */
export function renderTerrainCard(r, link) {
  const card = $('terrain-card');
  if (beginner()) { card.hidden = true; return; }
  card.hidden = false;
  const u = units();
  const p = activeProfile();
  const s = terrainStatsFor(r);
  const note = $('terrain-note');
  const linkNote = $('link-note');
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
    // No profile, no claim about the radio either: an empty link line is the app
    // saying nothing, which is the only honest thing it can say offline.
    linkNote.textContent = '';
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
  // The radio, over the same ground (Phase 4 item 6): the ray from the pilot's
  // antenna to the aircraft at the turnaround, and the floor under it — the
  // highest the ground may be at each point and still leave the link 60% of its
  // first Fresnel zone. Where the ground line crosses above that floor, the link
  // is being eaten; where it crosses the ray itself, the link is gone.
  const los = link && {
    name: `${link.band.label} line of sight · antenna ${ANTENNA_HEIGHT_M} m`, color: 'var(--series-1)',
    pts: link.ray.map(pt => ({ x: u.distanceFromKm(pt.distKm), y: u.altFromM(pt.losM) })),
  };
  const floor = link && {
    name: `${Math.round(FRESNEL_CLEAR_FRAC * 100)}% Fresnel floor — ground below this`,
    color: 'var(--series-3)', dash: '3 4',
    pts: link.ray.map(pt => ({ x: u.distanceFromKm(pt.distKm), y: u.altFromM(pt.floorM) })),
  };
  const series = link ? [ground, planned, los, floor] : [ground, planned];
  legend($('legend-terrain'), series);
  lineChart(chart, {
    series, height: 220,
    bands: link ? [{ upper: los.pts, lower: floor.pts, color: 'var(--series-1)', opacity: 0.16 }] : [],
    markers: [
      { x: lastX, y: u.altFromM(s.turnaroundElevM), color: 'var(--series-4)', label: 'turnaround' },
      ...(s.minClearanceAtKm > 0 && s.minClearanceM < s.turnClearanceM
        ? [{
          x: u.distanceFromKm(s.minClearanceAtKm), y: u.altFromM(s.maxElevM),
          color: 'var(--status-serious)', label: 'least clearance', labelBelow: true,
        }]
        : []),
      ...(link && link.blocked
        ? [{
          x: u.distanceFromKm(link.clearKm),
          y: u.altFromM(elevAtKm(p, link.clearKm)),
          color: link.losBlockKm != null ? 'var(--status-critical)' : 'var(--status-serious)',
          label: link.losBlockKm != null ? 'link blocked' : 'link degrades',
        }]
        : []),
    ],
    // Sea level is never the interesting part of an elevation chart; the ground
    // line would be a flat scratch at the top of the panel.
    yMin: Math.floor(u.altFromM(Math.min(
      s.launchElevM, s.maxElevM,
      ...(link ? link.ray.map(pt => pt.floorM) : []),
    )) / 50) * 50 - 50,
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

  if (!link) { linkNote.textContent = ''; return; }
  // How much of the first Fresnel zone survives at the tightest point. Above 100%
  // there is nothing in the zone at all, and a percentage there would be noise.
  const tight = link.worstFrac == null ? ''
    : link.worstFrac >= 1
      ? `The tightest point, ${dist(link.worstAtKm)} out, still clears the whole zone. `
      // worstFrac <= 0 only happens on a leg that is already reported as blocked
      // above, so this says where the worst of it is and not that it is blocked.
      : link.worstFrac <= 0
        ? `The worst of it is ${dist(link.worstAtKm)} out. `
        : `At its tightest, ${dist(link.worstAtKm)} out, ${f0(link.worstFrac * 100)}% of the zone is clear `
          + `— under ${Math.round(FRESNEL_CLEAR_FRAC * 100)}% is where a link starts to break up. `;
  const short = Math.max(0, r.radiusKm - link.clearKm);
  linkNote.textContent =
    `Radio: ${link.band.label} (${link.band.use}) from a ${ANTENNA_HEIGHT_M} m standing antenna to the `
    + `${link.cruiseAltM} m cruise, over a 4/3-earth curve. `
    + (link.losBlockKm != null
      // clearKm is where the link actually stops being usable (the zone closes
      // before the ray is cut, always), so it leads; the bare-ray distance
      // follows as the second, worse-case fact.
      ? `The link ends ${dist(link.clearKm)} out, ${dist(short)} short of the ${dist(r.radiusKm)} the pack `
        + `can fly — the zone closes there, and the ground is across the ray itself by `
        + `${dist(link.losBlockKm)}. `
      : link.blocked
        ? `The ray clears, but the Fresnel zone closes up at ${dist(link.fresnelBlockKm)}, `
          + `${dist(short)} short of the ${dist(r.radiusKm)} the pack can fly. `
        : `Clear the whole way out to the turnaround at ${dist(link.legKm)}. `)
    + tight
    + `Same ground, other bands: ${link.bands.map(b =>
      `${b.label} ${b.blocked ? dist(b.clearKm) : 'clear'}`).join(', ')} — lower bands have wider Fresnel `
    + 'zones and flag first, while also being the links that survive an intrusion best. This is '
    + 'first-Fresnel geometry over bare DEM ground: no trees, towers or wires, no antenna pattern, no '
    + 'transmit power, and only along this one bearing.';
}
