// dive-profile.js — the dive line and the ground beneath it, as numbers a strip
// can draw (M16, 3D-06's bottom edge).
//
// Pure, and deliberately so: every judgement this module makes is about what is
// and isn't known, and those are the judgements worth testing without a browser.
// Two of them decide the whole shape:
//
//  - **The pad's height is not invented.** A mission whose launch elevation was
//    never resolved gets a profile that *starts at the first gate*. Drawing the
//    approach leg from an assumed sea-level pad would put a 900 m climb on the
//    chart that nobody planned, and the pilot would read the dive's drop against
//    it.
//  - **Ground holes stay holes.** The sampler answers null wherever the terrain
//    corridor never looked — off-corridor by more than its tolerance, or before
//    the first field lands — and a null is carried through to the strip as a gap
//    in the silhouette. A silhouette interpolated across a col it never sampled
//    is a picture of clearance the tool does not have.
//
// The x axis is metres along the flown line, not along the great circle from the
// pad: with the approach leg dropped, the first gate sits at x = 0, which is
// what "the profile starts here" has to mean for the axis too.

import { bearingTo, destination, distanceKm } from '../../domain/geo.js';
import { diveLegChain, orderedGates } from './layers/dive-layer.js';

/**
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').DiveGateView} DiveGateView
 */

/**
 * @typedef {object} ProfileLeg  one drawn stretch of the flight line
 * @property {string} kind        the leg's id — the kind of the gate it ends at
 * @property {number} x0  metres along the profile
 * @property {number} x1
 * @property {number} y0  MSL metres
 * @property {number} y1
 */

/**
 * @typedef {object} ProfileGate  a gate as the strip plots and labels it
 * @property {string} kind
 * @property {number} ordinal     flight order, matching the map pins
 * @property {number} x           metres along the profile
 * @property {number} altitudeMslM
 */

/**
 * @typedef {object} ProfileSample  the ground at one station
 * @property {number} x
 * @property {number|null} groundMslM  null where the terrain field never looked
 */

/**
 * @typedef {object} DiveProfile
 * @property {ProfileLeg[]} legs
 * @property {ProfileGate[]} gates
 * @property {ProfileSample[]} ground
 * @property {number} totalM      length of the flown line
 * @property {number} minMslM     the y range, over the line *and* the ground it
 * @property {number} maxMslM       actually sampled — never over holes
 * @property {number} missing     stations the field could not answer
 * @property {boolean} fromLaunch whether the pad is the profile's first point
 */

/** Stations per leg, endpoints included. Enough to shape a ridge, cheap enough
 *  to recompute on every pass the plan changes. */
const DEFAULT_SAMPLES = 24;

/**
 * Build the profile. Returns null when there is no line to draw — no gates, or
 * only one point once an unknown pad height has been dropped.
 *
 * @param {object} spec
 * @param {LatLng} spec.launch
 * @param {number|null} spec.launchMslM  the pad's elevation, or null if unknown
 * @param {DiveGateView[]} spec.gates
 * @param {(lat: number, lng: number) => number|null} spec.groundAt
 * @param {number} [spec.samplesPerLeg]
 * @returns {DiveProfile|null}
 */
export function diveProfileFrom({ launch, launchMslM, gates, groundAt, samplesPerLeg = DEFAULT_SAMPLES }) {
  const chain = diveLegChain(launch, gates ?? []);
  if (!chain.length) return null;

  /* The pad joins the line only if its height is known (see the header). When
     it doesn't, the first leg loses its start and goes with it — what remains is
     still a true picture of the rest of the plan. */
  const fromLaunch = Number.isFinite(launchMslM);
  const drawn = fromLaunch ? chain : chain.filter((leg) => leg.fromGate);
  if (!drawn.length) return null;

  const ordinals = new Map(orderedGates(gates ?? []).map(({ gate, ordinal }) => [gate.kind, ordinal]));

  /** @type {ProfileLeg[]} */
  const legs = [];
  /** @type {ProfileGate[]} */
  const out = [];
  /** @type {ProfileSample[]} */
  const ground = [];
  let x = 0;

  const first = drawn[0];
  if (first.fromGate) {
    out.push({
      kind: first.fromGate.kind,
      ordinal: ordinals.get(first.fromGate.kind) ?? 1,
      x: 0,
      altitudeMslM: first.fromGate.altitudeMslM,
    });
  }

  for (const [i, leg] of drawn.entries()) {
    const spanM = distanceKm(leg.from, leg.to) * 1000;
    const y0 = leg.fromGate ? leg.fromGate.altitudeMslM : /** @type {number} */ (launchMslM);
    const y1 = leg.gate.altitudeMslM;
    legs.push({ kind: leg.kind, x0: x, x1: x + spanM, y0, y1 });

    /* The shared endpoint between two legs is sampled once: it is one place on
       the ground, and two stations at the same x would draw a vertical spike
       through any rounding difference between them. */
    const bearing = bearingTo(leg.from, leg.to);
    const steps = Math.max(2, Math.round(samplesPerLeg));
    for (let s = i === 0 ? 0 : 1; s <= steps; s += 1) {
      const t = s / steps;
      /* `destination` answers in Leaflet's `[lat, lng]` tuple; the endpoints are
         used as given so a station on a gate is the gate's own coordinates and
         not a round trip through trigonometry. */
      const at = t === 0 ? leg.from
        : t === 1 ? leg.to
          : latLng(destination(leg.from.lat, leg.from.lng, bearing, (spanM * t) / 1000));
      ground.push({ x: x + spanM * t, groundMslM: sample(groundAt, at) });
    }

    x += spanM;
    out.push({
      kind: leg.gate.kind,
      ordinal: ordinals.get(leg.gate.kind) ?? out.length + 1,
      x,
      altitudeMslM: y1,
    });
  }

  const heights = [
    ...legs.flatMap((l) => [l.y0, l.y1]),
    ...ground.map((g) => g.groundMslM).filter((g) => g !== null),
  ];
  return {
    legs,
    gates: out,
    ground,
    totalM: x,
    minMslM: Math.min(...heights),
    maxMslM: Math.max(...heights),
    missing: ground.filter((g) => g.groundMslM === null).length,
    fromLaunch,
  };
}

/**
 * Leaflet's `[lat, lng]` tuple as the object the rest of this file speaks.
 * @param {[number, number]} pair
 * @returns {LatLng}
 */
function latLng(pair) {
  return { lat: pair[0], lng: pair[1] };
}

/**
 * One station's ground, defended against a sampler that answers with something
 * other than a number: the field's own "I never looked" is null, and anything
 * else non-finite means the same thing to a chart.
 * @param {(lat: number, lng: number) => number|null} groundAt
 * @param {LatLng} at
 * @returns {number|null}
 */
function sample(groundAt, at) {
  const g = groundAt(at.lat, at.lng);
  return typeof g === 'number' && Number.isFinite(g) ? g : null;
}
