// state.js — the control surface's state, its session persistence, and the
// selection helpers that read it. Owns nothing about rendering: the render
// modules import this, never the other way round.
import {
  PAYLOADS, WEATHER, SCENARIOS,
  allBatteries, allManufacturers,
} from './data.js';
import { allDrones, compatible, compatibleBatteries as dronePacks } from './registry.js';
import { calibratedDrone } from './flightlog.js';
import { instanceBattery } from './packinstances.js';
import { get as storeGet, set as storeSet } from './store.js';
import { parallelBattery, GUST_FACTOR_DEFAULT, U } from './physics.js';
import { unitSystem } from './units.js';
import { CRUISE_ALTS_M, CRUISE_ALT_DEFAULT_M } from './windprofile.js';
import { planElevM } from './terrain.js';
import { LINK_BAND_DEFAULT, isLinkBand } from './rf.js';

export const state = {
  view: 'dash', // 'dash' | 'map'
  units: 'imperial',
  droneId: 'moz7v2',
  manufacturerId: 'all',
  batteryId: 'nav5000',
  parallelPacks: false,
  payloadId: 'naked',
  extraG: 0,
  weatherId: 'live', // 'live' | preset id | 'custom' — live is the boot default
  scenarioId: 'longrange',
  env: { elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windFromDeg: 170, windMode: 'headOut' },
  // The charge the pilot doesn't want to land below — pack care, not get-home
  // margin. The get-home margin is solved in Wh by planMission (Phase 4 item 2);
  // this is all that is left for a percent to mean.
  landFloorPct: 20,
  // How much of the gust spread the planning wind carries, as a percent
  // (physics.GUST_FACTOR_DEFAULT × 100). Expert-only; see populateControls().
  gustFactorPct: 35,
  // The pack's own temperature at takeoff (°F), or null when it tracks the air
  // (Phase 4 item 3). Null is the honest default — a pack that rode to the field
  // in a bag is at air temperature — and a number is the pilot saying otherwise:
  // warmed on the car dash, or still cold-soaked from a car left out overnight.
  // Expert-only; beginner mode pins it back to null.
  //
  // Not to be confused with a pack instance's `irTempC` (src/packinstances.js):
  // that records what the bench was at when the charger measured the pack's
  // resistance. This is how warm the pack is when it leaves the ground.
  packTempF: null,
  // Which level of the wind profile the plan flies, in m AGL (Phase 4 item 9).
  // 80 m is what every plan before this control existed flew, so leaving it alone
  // changes nothing; the other levels come off the same forecast call. Doubles as
  // the altitude the terrain profile measures clearance against (item 5).
  // Expert-only; beginner mode pins it back to 80.
  cruiseAltM: CRUISE_ALT_DEFAULT_M,
  // Which radio the Fresnel clearance over the terrain profile is computed for
  // (Phase 4 item 6). 5.8 GHz is the O4's high band — the video the pilot is
  // actually flying by — and the card quotes the other two beside it, because the
  // fatter low-band zone breaks first geometrically while the low-band link is the
  // more robust one in the air. Expert-only; beginner mode pins it back.
  linkBand: LINK_BAND_DEFAULT,
  cruiseMode: 'real',
  manualMph: 40,
  speedMetric: 'radius',
  detail: 'full', // 'full' | 'beginner' — how much of the physics is on screen
};

export const beginner = () => state.detail === 'beginner';

/**
 * The pack-temperature override's own range, in °F — the rail input's min/max and
 * the bound restoreSession() validates against, in one place so a saved blob can
 * never hold a temperature the control cannot show.
 */
export const PACK_TEMP_RANGE_F = [-20, 120];

/**
 * What ticking the pack-temperature box starts from: a pack off the car dash or
 * out of an inside pocket. Never colder than the air it is standing in, so
 * turning the control on can't make the plan worse by surprise — the pilot has to
 * type a colder number to say the pack is cold-soaked.
 */
export const packPreheatSeedF = () => Math.max(70, Math.round(state.env.tempF));

/**
 * The pack temperature the plan actually runs on: the pilot's override when there
 * is one, otherwise the air. `overridden` is what the UI says out loud, and the
 * only reason this returns a shape rather than a number.
 */
export function packTemp() {
  const overridden = state.packTempF != null;
  const tempF = overridden ? state.packTempF : state.env.tempF;
  return { overridden, tempF, tempC: U.fToC(tempF) };
}

/* ---------- session persistence ---------- */

export function saveSession() {
  storeSet('session', state);
}

/**
 * Restore the control surface, all-or-nothing: any unknown id or out-of-range
 * number discards the whole blob, because a half-restored loadout reads as a
 * plan for a rig the pilot never selected. Returns the saved view, if valid.
 *
 * `detail` is the one exception: it is a view preference, not part of the plan,
 * so it falls back to 'full' on its own rather than voiding a blob written
 * before the toggle existed.
 *
 * Two fields are read with a migration in front of them rather than voiding an
 * older blob — see `landFloor` and `gustFactor` below.
 */
export function restoreSession() {
  const s = storeGet('session', null);
  if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return null;
  const env = s.env;
  const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  // Phase 4 item 2 renamed this field as its meaning narrowed. A blob written
  // before the change carries `reservePct`, which used to withhold that share of
  // the pack as the get-home margin; the number is carried over verbatim as the
  // pack-care floor, because the slider it came off was already labeled "battery
  // left when you land" — the figure means what it always displayed, and the
  // get-home margin it used to double as is now solved in Wh instead. Out-of-
  // range values still void the blob, the same as every other number here.
  const landFloor = num(s.landFloorPct, 0, 40) ? s.landFloorPct
    : s.landFloorPct === undefined && num(s.reservePct, 10, 40) ? s.reservePct
    : null;
  // Written for the first time by this version; an older blob simply gets the
  // default rather than being thrown away over a knob that did not exist.
  const gustFactor = s.gustFactorPct === undefined ? GUST_FACTOR_DEFAULT * 100
    : num(s.gustFactorPct, 0, 100) ? s.gustFactorPct
    : null;
  // Same tolerance for the pack temperature, with the wrinkle that `null` is a
  // real, meaningful value here (the pack tracks the air) rather than an absence
  // — so a missing key and a stored null land on the same place, and only a
  // number out of the input's own range voids the blob. `false` sentinels the
  // void, since null is taken.
  const packTemp = s.packTempF === undefined || s.packTempF === null ? null
    : num(s.packTempF, PACK_TEMP_RANGE_F[0], PACK_TEMP_RANGE_F[1]) ? s.packTempF
    : false;
  // Same migration tolerance as the two above: a blob written before the
  // cruise-altitude control existed gets the level the app has always flown, and
  // only a level the select could never show voids the blob.
  const cruiseAlt = s.cruiseAltM === undefined ? CRUISE_ALT_DEFAULT_M
    : CRUISE_ALTS_M.includes(s.cruiseAltM) ? s.cruiseAltM
    : null;
  // And the same for the video/control band the Fresnel check runs at: a blob
  // written before the link check existed gets the default rather than being
  // thrown away, and only a band the select could never show voids it.
  const link = s.linkBand === undefined ? LINK_BAND_DEFAULT
    : isLinkBand(s.linkBand) ? s.linkBand
    : null;
  // allDrones(), not the catalog: a rig the pilot added themselves has to survive
  // a reload exactly like a built-in, and store.js is import-time safe so the
  // custom records are readable this early in boot.
  const savedDrone = allDrones().find(d => d.id === s.droneId);
  const batt = allBatteries().find(b => b.id === s.batteryId && compatible(savedDrone, b));
  // A rig with nothing in the pack list is a legitimate state to come back to now
  // that a pilot can add their own airframe: the verdict card says NO PACK and
  // waits for a battery. Demanding a compatible pack here would quietly hand them
  // back a built-in instead of the rig they just built.
  const noPacks = !!savedDrone && dronePacks(savedDrone).length === 0;
  const ok = savedDrone
    && (batt || noPacks)
    && (s.manufacturerId === 'all'
      || (batt && batt.manufacturerId === s.manufacturerId && allManufacturers().some(m => m.id === s.manufacturerId)))
    && PAYLOADS.some(p => p.id === s.payloadId)
    && SCENARIOS.some(x => x.id === s.scenarioId)
    && (s.weatherId === 'live' || s.weatherId === 'custom' || WEATHER.some(w => w.id === s.weatherId))
    && ['imperial', 'metric'].includes(s.units)
    && ['dash', 'map'].includes(s.view)
    && ['real', 'range', 'manual'].includes(s.cruiseMode)
    && ['radius', 'time'].includes(s.speedMetric)
    && ['headOut', 'tailOut', 'cross'].includes(env.windMode)
    && typeof s.parallelPacks === 'boolean'
    && num(s.extraG, 0, 500) && landFloor !== null && gustFactor !== null && packTemp !== false
    && cruiseAlt !== null && link !== null
    && num(s.manualMph, 5, 120)
    && num(env.elevFt, -1500, 30000) && num(env.tempF, -60, 140) && num(env.rhPct, 0, 100)
    && num(env.windMph, 0, 120) && num(env.gustMph, 0, 160) && num(env.windFromDeg, 0, 359);
  if (!ok) return null;
  Object.assign(state, {
    units: s.units, droneId: s.droneId, manufacturerId: s.manufacturerId, batteryId: s.batteryId,
    parallelPacks: s.parallelPacks, payloadId: s.payloadId, extraG: s.extraG,
    weatherId: s.weatherId, scenarioId: s.scenarioId,
    landFloorPct: landFloor, gustFactorPct: gustFactor, packTempF: packTemp,
    cruiseAltM: cruiseAlt, linkBand: link,
    cruiseMode: s.cruiseMode, manualMph: s.manualMph, speedMetric: s.speedMetric,
    detail: ['full', 'beginner'].includes(s.detail) ? s.detail : 'full',
    env: {
      elevFt: env.elevFt, tempF: env.tempF, rhPct: env.rhPct, windMph: env.windMph,
      gustMph: env.gustMph, windFromDeg: env.windFromDeg, windMode: env.windMode,
    },
  });
  return s.view;
}

// Falls back to the first record the same way battery()/payload()/scenario() do:
// deleting the custom drone that was selected must not leave the plan reading a
// hole. The UI puts the rail back on a built-in; this is the net under it.
//
// The record as written down — catalog or pilot-authored, with nothing fitted on
// top. Only the calibration UI wants this: it is the "0.55 (catalog)" half of
// the status line, and the base the fit is solved against.
export function catalogDrone() {
  const list = allDrones();
  return list.find(d => d.id === state.droneId) || list[0];
}

/**
 * The record everything else plans with. When this airframe's flight log has
 * earned a fit *and* the pilot has the switch on, etaProp and cdA come back as
 * theirs instead of the catalog's — so planMission, every chart, and the
 * comparison table see the calibrated rig without knowing calibration exists.
 * Off by default at every tier below 'default'; see flightlog.appliedState().
 */
export function drone() {
  return calibratedDrone(catalogDrone());
}
export function droneBatteries() {
  return dronePacks(drone());
}
export function compatibleBatteries() {
  const batts = droneBatteries();
  return state.manufacturerId === 'all'
    ? batts
    : batts.filter(b => b.manufacturerId === state.manufacturerId);
}
// The pack model as written down, with no physical copy of it overlaid. Only the
// pack-instance UI wants this: it is the "22 mΩ (catalog spec)" half of the fold,
// and the fallback the plan returns to when no instance is selected.
export function catalogBattery() {
  const list = compatibleBatteries();
  return list.find(b => b.id === state.batteryId) || list[0];
}

/**
 * The pack everything else plans with. When the pilot has told us which physical
 * copy of this model is on the rig *and* measured its resistance, the record
 * comes back carrying that number instead of the model's — so planMission, the
 * sag warnings and every chart see the aged pack without knowing instances
 * exist. Mirrors drone()/catalogDrone() above; see src/packinstances.js.
 */
export function battery() {
  return instanceBattery(catalogBattery());
}
export function manufacturer(id) {
  return allManufacturers().find(m => m.id === id);
}
export function payload() { return PAYLOADS.find(p => p.id === state.payloadId) || PAYLOADS[0]; }
export function scenario() { return SCENARIOS.find(s => s.id === state.scenarioId) || SCENARIOS[0]; }
export function units() { return unitSystem(state.units); }
export function loadoutBattery(batt = battery()) {
  // Nothing in the registry fits this rig. Hand back null rather than a shell
  // object, so missionInputs() passes a falsy battery and planMission answers
  // with its handled `no_battery` code instead of doing arithmetic on holes.
  if (!batt) return null;
  // Run the instance overlay over whatever we were handed, not just over the
  // default: the pack shoot-out plans every compatible pack through here, and a
  // row for the model whose Pack #2 is selected has to agree with the hero above
  // it. Idempotent, so the default argument doesn't get it twice.
  batt = instanceBattery(batt);
  if (!state.parallelPacks) return { ...batt, packCount: 1, extraCdA: 0 };
  const d = drone();
  return parallelBattery(batt, 2, {
    harnessMassG: d.parallelHarnessMassG || 0,
    extraCdA: d.parallelPackCdA || 0,
  });
}

/**
 * The inputs one planMission() call takes, assembled from the rail.
 *
 * `terrain: false` opts out of the turnaround-elevation substitution below — the
 * probe pass that discovers how far out the plan turns around has to run at the
 * launch elevation, or it would be reading a turnaround it hasn't found yet.
 */
export function missionInputs(batt = battery(), envOverride = null, { terrain = true } = {}) {
  const env = envOverride || state.env;
  const configuredBatt = loadoutBattery(batt);
  return {
    drone: drone(),
    battery: configuredBatt,
    payloadG: payload().massG,
    payloadCdA: payload().cdA,
    extraG: state.extraG,
    env: {
      // Density altitude at the turnaround, not at the launch point (Phase 4
      // item 5): a mission that climbs 300 m into the Hill Country is planning
      // thinner air than the pilot is standing in, and the turnaround is where
      // the thrust margin has to hold. Falls back to the rail's own elevation
      // whenever no terrain profile describes this launch point — which is every
      // offline flight, and every plan this app made before the profile existed.
      elevM: terrain ? planElevM(env.elevFt) : U.ftToM(env.elevFt),
      tempC: U.fToC(env.tempF),
      rhPct: env.rhPct,
      windAvgMs: U.mphToMs(env.windMph),
      windGustMs: U.mphToMs(env.gustMph),
      windFromDeg: env.windFromDeg,
      windMode: env.windMode,
    },
    // The pack's temperature, resolved against whichever air this call is
    // planning — `env` may be a swept copy of the rail (the wind-sensitivity
    // chart), and the pilot's override stands over all of them. Equal to
    // `env.tempC` to the last bit while it tracks the air, which is what keeps an
    // untouched plan identical to one from before this input existed.
    packTempC: U.fToC(state.packTempF ?? env.tempF),
    landFloorPct: state.landFloorPct,
    gustFactor: state.gustFactorPct / 100,
    cruiseMode: state.cruiseMode,
    realVMs: drone().cruiseMs * scenario().speedFactor,
    manualVMs: U.mphToMs(state.manualMph),
    overheadF: scenario().overheadFactor,
  };
}

// The cruise modes that ask the pilot to think in airspeed rather than in flying
// style. Beginner mode drops both and plans the realistic cruise.
export const EXPERT_CRUISE_MODES = ['range', 'manual'];
