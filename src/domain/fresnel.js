// fresnel.js — the radio geometry, with nothing impure attached to it.
//
// These four formulas have been right since Phase 4 item 6 and they lived in
// src/rf.js, which is fine for the terrain card and impossible for the analysis
// pipeline: rf.js imports src/terrain.js, which holds a fetch and a module-level
// cache, and the application layer may not import either (ADR 0009). Rather than
// grow a second copy of a Fresnel radius — the classic way two answers about the
// same ridge start disagreeing — the geometry moved down here and rf.js re-exports
// it. Every existing caller keeps the import it already had.
//
// What is here is the geometry and only the geometry: a wavelength, the first
// Fresnel radius, the earth's own bulge, and one function that walks a list of
// obstructions and reports the tightest point. There is no profile, no plan, no
// band table and no verdict — those stay in rf.js, where the pilot-facing
// sentences that quote them live.

const C_MS = 299792458;

/**
 * How high the pilot's antenna is above the ground they are standing on, in
 * metres. A goggle antenna at head height, standing, and a control transmitter
 * held in front of the chest — call the pair 1.5 m and be done. Deliberately a
 * constant and not another control: the number moves the blockage distance by
 * metres over a ridge that moves it by hundreds, and the tool does not need
 * another knob to be wrong about.
 */
export const ANTENNA_HEIGHT_M = 1.5;

/** The share of the first Fresnel radius that has to stay clear for a good link. */
export const FRESNEL_CLEAR_FRAC = 0.6;

/**
 * Wavelength in metres for a frequency in GHz.
 * @param {number} ghz
 * @returns {number}
 */
export const wavelengthM = (ghz) => C_MS / (ghz * 1e9);

/**
 * First Fresnel zone radius at a point d1 from one end and d2 from the other, all
 * in metres: r = sqrt(lambda*d1*d2 / d). Everything is SI here so the dimensions
 * check by inspection — the familiar field form r = 8.657*sqrt(d_km / f_GHz) is
 * this same expression evaluated at the midpoint, and the tests pin the two
 * together.
 * @param {number} d1M
 * @param {number} d2M
 * @param {number} ghz
 * @returns {number}
 */
export function fresnelRadiusM(d1M, d2M, ghz) {
  const d = d1M + d2M;
  if (!(d > 0) || !(ghz > 0) || d1M < 0 || d2M < 0) return 0;
  return Math.sqrt(wavelengthM(ghz) * d1M * d2M / d);
}

/**
 * The 4/3-radius effective earth: standard atmospheric refraction bends the beam
 * back down, and pretending it does not would put ridges in the way that are not.
 */
const EARTH_R_EFF_M = (4 / 3) * 6371000;

/**
 * How much the earth's own curve lifts the ground between two points, in metres.
 * Half a metre over 5 km — never the headline, but it is two lines of arithmetic
 * and it always signs the same way (against the pilot), so there is no reason to
 * leave it out.
 * @param {number} d1M
 * @param {number} d2M
 * @returns {number}
 */
export const earthBulgeM = (d1M, d2M) => d1M * d2M / (2 * EARTH_R_EFF_M);

/**
 * One thing between the pilot and the aircraft. `alongM` is how far along the
 * sightline it sits; `groundMslM` is how high it is. `id` is carried through
 * untouched so a finding can be anchored to the sample it came off.
 * @typedef {{ id: string, alongM: number, groundMslM: number }} Obstruction
 */

/** @typedef {{ marginM: number, atId: string|null, atAlongM: number|null }} RayMargin */

/**
 * @typedef {object} FresnelReading
 * @property {number} counted        obstructions that actually lay on the ray
 * @property {RayMargin} los         margin with no Fresnel allowance at all
 * @property {RayMargin} fresnel     margin against `clearFrac` of the first zone
 */

/**
 * The tightest point on one sightline, measured twice: once as bare line of
 * sight, once against the share of the first Fresnel zone that has to stay
 * clear. Both come out of one pass because they differ by a single term, and
 * because a caller has to be able to tell "the ridge is in the way" from "the
 * ridge is eating the beam" — they fail differently and the pilot is told
 * different things about them.
 *
 * A positive margin is metres of headroom at the worst obstruction. A negative
 * one is metres of intrusion. With nothing on the ray at all the margin is
 * `Infinity` and `counted` is 0 — which is *not* the same statement as "clear",
 * and the caller is expected to know the difference: an empty obstruction list
 * can mean flat ground or it can mean nobody sampled any.
 *
 * `groundRefMslM` reproduces rf.js's hard-won filter: ground at or below the
 * pilot's own feet is not an obstruction. A Fresnel zone grows as sqrt(d1) while
 * the ray from a 1.5 m antenna climbs linearly, so within a few hundred metres
 * of the pilot the zone always touches level ground — on a runway, on a lake, on
 * anything — and how badly depends on how finely the DEM happens to be sampled
 * there, which is not a property of the flight. Grazing level ground is a
 * ground-reflection problem, not a blockage, and this tool does not claim on it.
 *
 * @param {object} spec
 * @param {number} spec.txMslM        the transmitting antenna, metres MSL
 * @param {number} spec.rxMslM        the aircraft, metres MSL
 * @param {number} spec.totalM        horizontal distance between them
 * @param {number} spec.ghz
 * @param {readonly Obstruction[]} spec.obstacles
 * @param {number} [spec.clearFrac]
 * @param {number} [spec.groundRefMslM] ground at or below this is not in the way
 * @returns {FresnelReading}
 */
export function worstFresnelMargin({
  txMslM, rxMslM, totalM, ghz, obstacles,
  clearFrac = FRESNEL_CLEAR_FRAC,
  groundRefMslM = -Infinity,
}) {
  /** @type {RayMargin} */
  const los = { marginM: Infinity, atId: null, atAlongM: null };
  /** @type {RayMargin} */
  const fresnel = { marginM: Infinity, atId: null, atAlongM: null };
  let counted = 0;
  if (!(totalM > 0) || !(ghz > 0)) return { counted, los, fresnel };

  for (const o of obstacles) {
    const d1 = o.alongM;
    if (!(d1 > 0) || !(d1 < totalM)) continue;      // behind the pilot, or past the aircraft
    if (!(o.groundMslM > groundRefMslM)) continue;  // level with the pilot's feet
    counted++;
    const d2 = totalM - d1;
    const rayMslM = txMslM + (rxMslM - txMslM) * (d1 / totalM);
    const topMslM = o.groundMslM + earthBulgeM(d1, d2);
    const bare = rayMslM - topMslM;
    const clear = bare - clearFrac * fresnelRadiusM(d1, d2, ghz);
    if (bare < los.marginM) { los.marginM = bare; los.atId = o.id; los.atAlongM = d1; }
    if (clear < fresnel.marginM) {
      fresnel.marginM = clear; fresnel.atId = o.id; fresnel.atAlongM = d1;
    }
  }
  return { counted, los, fresnel };
}
