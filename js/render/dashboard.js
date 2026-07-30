// render/dashboard.js — the planner view: the verdict card, the warning stack,
// the stat tiles, and the three sweep charts behind them.
import { planMission, CHEMISTRY, U } from '../physics.js';
import { lineChart, missionProfile, legend } from '../charts.js';
import {
  state, units, beginner, drone, scenario, battery, compatibleBatteries, loadoutBattery, missionInputs,
} from '../state.js';
import { rangeBandKm } from '../drift.js';
import { SERIES, f0, f1, mmss, flightLabel, liftSource, confidenceWord, ratio, bandPhrase } from './format.js';
import { $, setTile } from './dom.js';

/* ---------- rendering ---------- */

// powerAtSpeed memo for the sweep renders, rebuilt every update pass. A cache
// is only valid while mass/air/drag are fixed, so it keys on the pack — the one
// thing the sweeps vary that moves all-up weight.
let packCaches = new Map();
export function packCache(b) {
  const key = b?.id ?? '';
  let c = packCaches.get(key);
  if (!c) { c = new Map(); packCaches.set(key, c); }
  return c;
}

/** Drop the memo. update() calls this at the top of every render pass. */
export function resetPackCaches() { packCaches = new Map(); }

export function renderWarnings(warnings) {
  const host = $('warnings');
  host.replaceChildren();
  const order = { critical: 0, serious: 1, warning: 2 };
  for (const w of warnings.sort((a, b) => order[a.level] - order[b.level])) {
    const el = document.createElement('div');
    el.className = `warn warn-${w.level}`;
    const icon = document.createElement('span');
    icon.className = 'warn-icon';
    icon.textContent = w.level === 'critical' ? '✕' : w.level === 'serious' ? '▲' : '●';
    const label = document.createElement('span');
    label.className = 'warn-level';
    label.textContent = w.level;
    const text = document.createElement('span');
    text.textContent = w.text;
    el.append(icon, label, text);
    host.appendChild(el);
  }
  host.hidden = warnings.length === 0;
}

/**
 * The zero-radius state reads as a broken app: dashes everywhere while Lift
 * still says VIABLE. Name the lever that actually moves, in the pilot's units.
 * Null unless the craft flies but no out-and-back closes.
 */
export function zeroRadiusNote(r) {
  if (!r.flight.viable || (r.legs.out && r.legs.back)) return null;
  const u = units();
  const spd = (ms) => f1(u.speedFromMs(ms));
  const ceiling = `${spd(r.speedLimitMs)} ${u.speedUnit}`;
  const wind = `${spd(r.wind.planningMs)} ${u.speedUnit} ${state.env.windMode === 'cross' ? 'crosswind' : 'headwind'}`;
  // Only worth suggesting a faster cruise while the wind is inside the envelope.
  const outrunnable = r.speedLimitMs > r.wind.planningMs;
  const noWayOut = `even this loadout’s ${ceiling} top speed can’t beat it — wait for calmer wind, or fly a lighter setup.`;
  if (state.cruiseMode === 'range') {
    return `A ${wind} is at or past this loadout’s ${ceiling} usable top speed — no cruise speed gets you home. `
      + 'Wait for calmer wind, or fly a lighter setup.';
  }
  const manual = state.cruiseMode === 'manual';
  const planMs = manual ? U.mphToMs(state.manualMph)
    : Math.min(drone().cruiseMs * scenario().speedFactor, 0.95 * r.speedLimitMs);
  if (manual && planMs > r.speedLimitMs) {
    return `A ${spd(planMs)} ${u.speedUnit} manual airspeed is past what this loadout holds (${ceiling}) `
      + '— dial the airspeed back, or drop weight.';
  }
  const fix = !outrunnable ? noWayOut
    : manual ? `push the airspeed above ${spd(r.wind.planningMs)} ${u.speedUnit}.`
    : `pick a faster flying style, or set cruise speed to Manual and push above ${spd(r.wind.planningMs)} ${u.speedUnit}.`;
  return `At ${spd(planMs)} ${u.speedUnit} you can’t make headway home against a ${wind} — ${fix}`;
}

/**
 * Out-leg and home-leg clock times at the planned cruise. planMission already
 * solved both ground speeds; the home leg has never been shown, and it is the
 * one that decides how early you turn.
 */
export function legTimes(r) {
  const { out, back } = r.legs;
  if (!out || !back || !(r.radiusKm > 0)) return null;
  return {
    outMin: r.radiusKm / (out.vg * 3.6) * 60,
    backMin: r.radiusKm / (back.vg * 3.6) * 60,
  };
}

// Where the pack actually finishes the mission: the landing reserve plus
// whatever sag strands below it. The profile timeline already integrates it.
function landingSoc(r) {
  const end = r.timeline.at(-1);
  return end && isFinite(end.soc) ? end.soc : null;
}

/**
 * "Can I fly this, here, now?" — the question the app is opened with. Pure
 * synthesis over the plan: one level, the binding constraint worst-first, and
 * the lever that moves it. Every number here is already on screen elsewhere.
 */
function verdict(r, stranded) {
  const u = units();
  const spd = (ms) => `${f0(u.speedFromMs(ms))} ${u.speedUnit}`;
  const b = loadoutBattery();
  const gustMs = U.mphToMs(state.env.gustMph);
  const gustShare = r.speedLimitMs > 0 ? gustMs / r.speedLimitMs : 0;
  const iRatio = b.maxContA ? r.hover.iA / b.maxContA : 0;
  const tempC = U.fToC(state.env.tempF);
  const coldPack = b.chem === 'liion' ? tempC <= 0 : tempC <= 5;
  const times = legTimes(r);

  const stop = [];
  if (r.flight.code === 'no_lift') {
    stop.push([
      `${f0(r.massKg * 1000)} g is over this rig’s ${liftSource(r.flight)} ${f0(r.flight.maxHoverMassG)} g lift ceiling — it will not leave the ground.`,
      'Take the camera and any extra weight off, or fly a lighter pack.',
    ]);
  } else if (r.flight.code === 'no_control_margin') {
    stop.push([
      `Only ${r.flight.thrustToWeight.toFixed(2)}:1 thrust — it may lift off, but nothing is left for a climb or a gust save.`,
      'Strip weight off it, or put a lighter pack on, before this one flies.',
    ]);
  }
  if (stranded) stop.push([stranded, null]);
  if (iRatio > 1) {
    stop.push([
      `Just hovering pulls about ${f0(r.hover.iA)} A from a pack rated for ${f0(b.maxContA)} A — you are over the pack before you move.`,
      'Fly a pack with more punch, or take weight off this one.',
    ]);
  }

  const care = [];
  if (gustShare > 0.45) {
    care.push([
      `Gusts to ${spd(gustMs)} are a big slice of this rig’s ${spd(r.speedLimitMs)} usable top speed.`,
      'Stay closer, keep it low behind cover, and save the long lines for a calmer day.',
    ]);
  }
  if (r.energy.sagLimited) {
    care.push([
      'The pack runs out of push before it runs out of energy — sag ends this flight early, not the capacity.',
      'Land on the timer instead of the low-voltage beep, or grab the bigger pack.',
    ]);
  }
  if (iRatio > 0.6 && iRatio <= 1) {
    care.push([
      `Hover alone is ${f0(iRatio * 100)}% of what this pack is rated to deliver — punch-outs will sag it hard.`,
      'Fly it smoothly, skip the hard climbs, or move to a pack with more headroom.',
    ]);
  }
  if (r.flight.code === 'marginal') {
    care.push([
      `${r.flight.thrustToWeight.toFixed(2)}:1 thrust is thin for gusts, climbs, and catching a bad line.`,
      'Fly gently and low, and leave the punch-outs for a lighter setup.',
    ]);
  }
  // A pilot-added airframe carries no motor or ESC limits, so the lift half of
  // this verdict is missing rather than passing. Say which, once, instead of
  // letting an infinite ceiling read as headroom.
  if (r.flight.code === 'unknown') {
    care.push([
      'This rig has no motor or ESC limits on record, so nothing here checks whether it can actually lift this weight.',
      'The times and distances are still modeled — hover it first and see what the OSD says.',
    ]);
  }
  if (coldPack) {
    care.push([
      'The pack is cold: expect less capacity than the plan assumes and heavy sag on the first pull.',
      'Keep packs in a pocket until launch, and cut a minute off the timer.',
    ]);
  }
  if (r.densityAltM > 2500) {
    care.push([
      `The air up here is thin — ${f0(U.mToFt(r.densityAltM))} ft density altitude costs you both thrust and efficiency.`,
      'Fly lighter, plan a shorter hop, and give yourself extra height on the way home.',
    ]);
  }

  const level = stop.length ? 'nogo' : care.length ? 'caution' : 'go';
  const label = level === 'nogo' ? 'DON’T FLY' : level === 'caution' ? 'CAUTION' : 'GO';
  const liftKnown = isFinite(r.flight.thrustToWeight);
  const [why, fix] = stop[0] || care[0] || [
    `Nothing in this plan is fighting you — ${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit} out and back in ${mmss(r.timeMin)}`
      + (liftKnown ? `, on ${r.flight.thrustToWeight.toFixed(2)}:1 of thrust.` : '.'),
    times ? `Fly it — turn for home at ${mmss(times.outMin)} on the timer.` : 'Fly it, and keep an eye on the timer.',
  ];

  const chips = liftKnown ? [`lift ${r.flight.thrustToWeight.toFixed(2)}:1`] : ['lift not modeled'];
  if (r.speedLimitMs > 0) chips.push(`gusts ${f0(gustShare * 100)}% of top speed`);
  if (b.maxContA) chips.push(`hover ${f0(iRatio * 100)}% of pack rating`);
  chips.push(r.energy.sagLimited ? 'sag-limited' : 'sag headroom OK');
  const land = landingSoc(r);
  if (land != null) chips.push(`lands ~${f0(land)}%`);

  return { level, label, why, fix, margins: chips.join(' · ') };
}

export function renderVerdict(r, stranded) {
  const v = verdict(r, stranded);
  const host = $('verdict');
  host.className = `verdict verdict-${v.level}`;
  $('verdict-badge').textContent = v.label;
  $('verdict-why').textContent = v.why;
  const fix = $('verdict-fix');
  fix.textContent = v.fix || '';
  fix.hidden = !v.fix;
  $('verdict-margins').textContent = v.margins;
}

/**
 * The one state with no plan behind it: nothing in the battery registry fits
 * the selected rig, so there is no mission to render. Unreachable with the
 * built-in catalog — every drone we ship has packs — and the net that catches
 * a user-defined airframe whose connector or cell count matches nothing yet.
 */
export function renderNoBattery() {
  const d = drone();
  const host = $('verdict');
  host.className = 'verdict verdict-nogo';
  $('verdict-badge').textContent = 'NO PACK';
  $('verdict-why').textContent =
    `No battery in your list fits the ${d?.short || d?.name || 'selected drone'}, so there is nothing to plan.`;
  const fix = $('verdict-fix');
  fix.textContent = 'Add a pack with a matching connector and cell count, or widen what this rig accepts.';
  fix.hidden = false;
  $('verdict-margins').textContent = '';
  renderWarnings([]);
  // Nothing downstream of the verdict has been re-rendered — there is no plan to
  // render — so hide it rather than leave the previous rig's radius, tiles and
  // charts on screen under a NO PACK badge. app.js's update() clears this the
  // moment a plan exists again.
  document.body.dataset.plan = 'none';
}

function setChartFlightState(id, flight, message = null) {
  const host = $(id);
  const invalid = flight.code === 'no_lift';
  host.classList.toggle('flight-invalid', invalid);
  host.dataset.flightMessage = invalid ? (message || 'WILL NOT FLY · lift ceiling exceeded') : '';
}

/**
 * The §6.2 band beside the headline: "8.4 mi (7.9–8.8, from your 11 flights)".
 *
 * Only while a fit is actually applied — `drone().calibration` exists only then,
 * so nothing here has to ask the logbook — and only when that fit has a spread
 * to report. Off in beginner mode, where the point is one number. Silent when
 * there is no plan to put a range around: a band on "WILL NOT FLY", or around a
 * zero radius, would be arithmetic about a mission that isn't happening.
 */
function renderHeroBand(r, u, suppress) {
  const el = $('hero-band');
  const cal = drone().calibration;
  const band = suppress || beginner() || !cal ? null : rangeBandKm(missionInputs(), cal);
  const text = band
    ? bandPhrase(u.distanceFromKm(band.loKm), u.distanceFromKm(band.hiKm), band.nFlights)
    : '';
  el.textContent = text;
  el.hidden = !text;
}

export function renderStats(r) {
  const u = units();
  const noLift = r.flight.code === 'no_lift';
  const hero = document.querySelector('.hero-card');
  hero.classList.toggle('flight-invalid-card', noLift);
  $('hero-value').textContent = noLift ? 'WILL NOT FLY' : f1(u.distanceFromKm(r.radiusKm));
  $('hero-unit').textContent = noLift ? '' : u.distanceUnit;
  const stranded = !noLift && !(r.legs.out && r.legs.back);
  const times = legTimes(r);
  const land = landingSoc(r);
  // Reserve plus whatever sag strands under it — say which, so "35%" doesn't
  // read as the app disagreeing with the reserve slider.
  const landing = land == null ? `${f0(r.energy.reservePct)}% reserve`
    : land - r.energy.reservePct < 0.5 ? `about ${f0(land)}% left, your landing reserve`
    : `about ${f0(land)}% left — your ${f0(r.energy.reservePct)}% reserve plus the bottom the pack can’t use`;
  $('hero-sub').textContent = noLift
    ? `${f0(r.massKg * 1000)} g all-up weight exceeds ${f0(r.flight.maxHoverMassG)} g ${liftSource(r.flight)} continuous lift`
    : stranded
      ? 'Zero radius — you could not fly home from any distance out. See the note above.'
      : `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit} out — start home at ${mmss(times?.outMin)} on the timer, land at ${mmss(r.timeMin)} with ${landing}`;
  renderHeroBand(r, u, noLift || stranded);
  setTile('tile-time', noLift ? '—' : mmss(r.timeMin),
    noLift ? 'mission invalid · insufficient lift'
      : times ? `${mmss(times.outMin)} out · ${mmss(times.backMin)} home · ${f1(u.distanceFromKm(r.totalKm))} ${u.distanceUnit} round trip`
      : 'no out-and-back closes in this wind');
  setTile('tile-hover', noLift ? '—' : mmss(r.hoverTimeMin),
    noLift ? `requires ${f0(r.hover.pW)} W · cannot sustain hover` : `hover · ${f0(r.hover.pW)} W · ${f1(r.hover.iA)} A`);
  setTile('tile-auw', `${f0(r.massKg * 1000)} g`,
    `${f1(r.massKg * 2.20462)} lb · ` + (isFinite(r.flight.maxHoverMassG)
      ? `lift ceiling ${f0(r.flight.maxHoverMassG)} g`
      : 'lift ceiling unknown for this rig'));
  const d = drone();
  setTile('tile-disc', `${r.discLoadingGcm2.toFixed(2)} g/cm²`, `${d.numRotors}× ${d.propDiaIn}″ props`);
  setTile('tile-eff', ratio(r.flight.thrustToWeight),
    // `estimated: false` means the ceiling came off a pasted bench table rather
    // than out of momentum theory — the one case where this tile isn't a guess.
    r.flight.estimated === false
      ? `${flightLabel(r.flight)} · from your thrust table`
      : r.flight.code === 'unknown'
        ? `${flightLabel(r.flight)} · no motor or ESC limits on record`
        // Whichever of the three tiers the motor and ESC limits came in as: a
        // published rating is not the guess "estimated" implies.
        : `${flightLabel(r.flight)} · ${r.flight.limitingComponent} limited · ${confidenceWord(r.flight.confidence)}`);
  setTile('tile-da', `${f0(U.mToFt(r.densityAltM))} ft`,
    `the altitude this air feels like · air density ${r.rho.toFixed(3)} kg/m³`);
  // Density altitude is a full-only tile, but thin air changes the whole plan —
  // promote it back into beginner view on the same threshold the warnings use.
  $('tile-da').classList.toggle('full-only', !(r.densityAltM > 2500));
  const out = r.legs.out, back = r.legs.back;
  setTile('tile-cruise',
    out && back ? `${f0(u.speedFromMs(out.v))} / ${f0(u.speedFromMs(back.v))} ${u.speedUnit}` : '—',
    out && back ? `airspeed out / back · ${f0(u.speedFromMs(out.vg))} / ${f0(u.speedFromMs(back.vg))} ${u.speedUnit} over the ground`
      : noLift ? 'mission invalid · insufficient lift' : 'wind or propulsion exceeds capability');
  // Pilots buy packs in mAh and charge them in mAh, so the Wh figure carries its
  // mAh twin. Converted at the pack's nominal voltage (packWh / capacity), which
  // is the same basis the Wh numbers are quoted on.
  const packMah = loadoutBattery().capAh * 1000;
  const nomV = packMah > 0 ? r.energy.packWh / (packMah / 1000) : 0;
  const usableMah = nomV > 0 ? r.energy.usableWh / nomV * 1000 : null;
  setTile('tile-energy', `${f1(r.energy.usableWh)} Wh`,
    (usableMah != null
      ? `${f0(usableMah)} of ${f0(packMah)} mAh usable · ${f1(r.energy.packWh)} Wh in the pack`
      : `usable of ${f1(r.energy.packWh)} Wh nominal`)
    + (r.overheadF > 1 ? ` · burn ×${r.overheadF.toFixed(2)}` : ''));
}

export function renderPowerCurve(r) {
  const u = units();
  const pts = r.curve.map(p => ({ x: u.speedFromMs(p.v), y: p.p }));
  const markers = [];
  if (r.endurance) markers.push({ x: u.speedFromMs(r.endurance.vMs), y: r.endurance.pW, color: 'var(--series-3)', label: 'endurance' });
  if (r.legs.out) markers.push({ x: u.speedFromMs(r.legs.out.v), y: r.legs.pOut, color: 'var(--series-1)', label: 'out' });
  if (r.legs.back && Math.abs(r.legs.back.v - (r.legs.out?.v ?? -1)) > 0.3) {
    markers.push({ x: u.speedFromMs(r.legs.back.v), y: r.legs.pBack, color: 'var(--series-2)',
      label: 'back', labelBelow: true });
  }
  // No propulsion block means no ceiling to draw — an Infinity here would blow
  // out the y-axis and hide the curve the chart exists for.
  const limitPts = pts.length && isFinite(r.flight.maxElectricalW) ? [
    { x: pts[0].x, y: r.flight.maxElectricalW },
    { x: pts.at(-1).x, y: r.flight.maxElectricalW },
  ] : [];
  lineChart($('chart-power'), {
    series: [
      { name: 'required electrical power', color: 'var(--series-1)', pts },
      ...(limitPts.length
        ? [{ name: 'continuous power ceiling', color: 'var(--status-critical)', pts: limitPts, dash: '6 5' }]
        : []),
    ],
    markers, height: 250,
    xLabel: `airspeed (${u.speedUnit})`, yLabel: 'W',
    xFmt: v => `${f0(v)}`, yFmt: v => `${f0(v)}`,
    tipTitle: 'airspeed',
  });
  setChartFlightState('chart-power', r.flight);
}

export function renderSpeedTradeoff(r) {
  const u = units();
  const d = drone();
  const base = missionInputs();
  const cache = packCache(battery());
  const time = state.speedMetric === 'time';
  const unit = time ? '' : ` ${u.distanceUnit}`;
  const metric = time ? mmss : f1;
  const pts = [];
  let best = null;
  for (let v = 2; v <= d.maxSpeedMs * 0.95; v += 0.5) {
    const rr = planMission({ ...base, cruiseMode: 'manual', manualVMs: v, lite: true, _pCache: cache });
    const p = { x: u.speedFromMs(v), y: time ? rr.timeMin : u.distanceFromKm(rr.radiusKm) };
    pts.push(p);
    if (!best || p.y > best.y) best = p;
  }
  const nearestY = x => pts.reduce((a, b) => Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a).y;
  const markers = [];
  const viable = best && best.y > 0;
  const peakLabel = time ? 'longest flight' : 'best range';
  if (viable) markers.push({ x: best.x, y: best.y, color: 'var(--series-3)', label: peakLabel });
  const plannedSpeed = r.legs.out ? u.speedFromMs(r.legs.out.v) : null;
  const atOptimum = viable && plannedSpeed !== null && Math.abs(plannedSpeed - best.x) < u.speedFromMs(2 / 3.6);
  if (viable && plannedSpeed !== null && !atOptimum) {
    markers.push({ x: plannedSpeed, y: nearestY(plannedSpeed), color: 'var(--series-2)', label: 'planned',
      labelBelow: Math.abs(best.x - plannedSpeed) < 0.12 * (pts.at(-1).x - pts[0].x) });
  }
  lineChart($('chart-speed'), {
    series: [{ name: time ? 'mission time' : 'mission radius', color: 'var(--series-1)', pts }],
    markers, height: 250,
    xLabel: `cruise airspeed (${u.speedUnit})`, yLabel: time ? 'mm:ss' : u.distanceUnit,
    xFmt: v => f0(v), yFmt: v => metric(v), tipTitle: 'cruise',
  });
  setChartFlightState('chart-speed', r.flight);
  const note = $('speed-note');
  if (viable && plannedSpeed !== null) {
    const py = nearestY(plannedSpeed);
    const cost = best.y - py;
    note.textContent =
      `${time ? 'Longest flight' : 'Best range'}: ${f0(best.x)} ${u.speedUnit} → ${metric(best.y)}${unit} · ` +
      `planned: ${f0(plannedSpeed)} ${u.speedUnit} → ${metric(py)}${unit}` +
      (atOptimum || cost <= 0.05 ? ' · already at the optimum'
        : ` · pushing costs ${metric(cost)}${time ? ' of flight time' : ` ${u.distanceUnit} of radius`}`);
  } else {
    note.textContent = r.flight.code === 'no_lift'
      ? 'No cruise calculation is valid because the configured aircraft cannot sustain hover.'
      : 'No cruise speed produces a viable out-and-back in this wind or propulsion envelope.';
  }
}

export function renderProfile(r) {
  const u = units();
  const empty = $('chart-profile-empty');
  empty.hidden = r.timeline.length > 0;
  empty.textContent = r.flight.code === 'no_lift'
    ? `WILL NOT FLY — all-up weight exceeds the ${liftSource(r.flight)} continuous lift ceiling.`
    : 'No viable mission in these conditions.';
  missionProfile($('chart-profile'), {
    timeline: r.timeline,
    cutoffV: CHEMISTRY[battery().chem].cutoffLoad * battery().s,
    reservePct: r.energy.reservePct,
    colorSoc: 'var(--series-1)',
    colorV: 'var(--series-2)',
    distanceFromKm: u.distanceFromKm,
    distanceUnit: u.distanceUnit,
    height: 300,
  });
  setChartFlightState('chart-profile', r.flight);
}

export function renderWindSensitivity(r) {
  const u = units();
  // The pack you're flying always makes the chart; catalog order fills the rest.
  const sel = battery();
  const all = compatibleBatteries();
  const others = all.filter(b => b.id !== sel?.id);
  const batts = (sel ? [sel, ...others] : others).slice(0, 4);
  const series = batts.map((b) => {
    const cache = packCache(b);
    const pts = [];
    for (let w = 0; w <= 30; w += 2) {
      const env = { ...state.env, windMph: w, gustMph: w * 1.5 }; // gusts scale with the sweep
      const rr = planMission({ ...missionInputs(b, env), lite: true, _pCache: cache });
      pts.push({ x: u.speedFromMph(w), y: u.distanceFromKm(rr.radiusKm) });
    }
    // Color follows the pack's catalog position so it matches the shoot-out chart
    // even with the selected pack hoisted to the front.
    return { name: b.short || b.name, color: SERIES[all.findIndex(x => x.id === b.id) % SERIES.length], pts };
  });
  lineChart($('chart-wind'), {
    series, height: 250,
    xLabel: `average wind (${u.speedUnit})`, yLabel: u.distanceUnit,
    xFmt: v => f0(v), yFmt: v => f1(v),
    tipTitle: 'wind',
  });
  legend($('legend-wind'), series);
  setChartFlightState('chart-wind', r.flight);
}
