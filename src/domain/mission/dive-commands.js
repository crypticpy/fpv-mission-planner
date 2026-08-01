// dive-commands.js — the M16 reducer commands for `scene.dive` (screens
// 3D-05…08): the dive plan's gates, the bailout landing, the lost-link/RTH
// altitude plane, and the speed and pullout load the run is authored at.
// Filed separately from scene-commands.js for the same reason
// that file exists apart from mission-reducer.js — same envelope, same two
// rules ("a rejected command changes nothing", "the reducer never hands back
// an invalid document"), new concern.
//
// The commands are set-by-kind, not add-by-id: a plan carries at most one gate
// of each kind (scene-schema.js's `checkDive`), so the kind *is* the identity
// a caller addresses. Setting a gate whose kind already exists moves that gate
// and keeps its id — an anchor pointing at "the recovery gate" survives the
// pilot dragging it. `Rejection`/`reject` are imported from scene-commands.js,
// never redefined: missionReduce's `instanceof Rejection` check needs one
// class identity across every handler file.

import { ID_PREFIXES } from './mission-schema.js';
import { reject } from './scene-commands.js';
import { DIVE_GATE_KINDS, isDiveGateKind, isValidName, sanitizeName } from './scene-schema.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').DivePlan} DivePlan */
/** @typedef {import('./mission-schema.js').DiveGate} DiveGate */
/** @typedef {import('./mission-schema.js').DiveBailout} DiveBailout */
/** @typedef {{ [key: string]: unknown }} Bag */
/** @typedef {{ idgen: (prefix: string) => string }} HandlerCtx */
/** @typedef {(doc: MissionDocumentV1, payload: Bag, ctx: HandlerCtx) => MissionDocumentV1} Handler */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} lat @param {unknown} lon */
const isLatLon = (lat, lon) => isNum(lat) && lat >= -90 && lat <= 90 && isNum(lon) && lon >= -180 && lon <= 180;

/** @param {MissionDocumentV1} doc @returns {DivePlan} */
const diveOf = (doc) => doc.scene.dive
  ?? { gates: [], bailout: null, rthAltitudeMslM: null, speedMs: null, pulloutLoadG: null };

/**
 * Writes the plan back, collapsing an emptied one to `null` — "no dive plan"
 * has exactly one representation, so the UI's "has this mission a dive?" is
 * one null check rather than several emptiness checks. The profile numbers
 * count as content like any other field, and an absent one reads as null: a
 * plan authored before they existed still collapses when its gates go.
 * @param {MissionDocumentV1} doc @param {DivePlan} dive
 * @returns {MissionDocumentV1}
 */
function withDive(doc, dive) {
  const empty = dive.gates.length === 0 && dive.bailout === null && dive.rthAltitudeMslM === null
    && dive.speedMs == null && dive.pulloutLoadG == null;
  return { ...doc, scene: { ...doc.scene, dive: empty ? null : dive } };
}

/** @type {Record<string, Handler>} */
export const DIVE_HANDLERS = {
  /** Places or moves the plan's one gate of this kind. Gates are stored in
   * DIVE_GATE_KINDS order whatever order they were authored in — the flight
   * order is the vocabulary's, not the pilot's editing history's. */
  setDiveGate(doc, payload, ctx) {
    const { kind, latitude, longitude, altitudeMslM } = payload;
    if (!isDiveGateKind(kind)) reject(`Gate kind must be one of ${DIVE_GATE_KINDS.join(', ')}.`, 'kind');
    if (!isLatLon(latitude, longitude)) {
      reject('A dive gate needs a latitude in -90..90 and a longitude in -180..180.', 'latitude/longitude');
    }
    if (!isNum(altitudeMslM)) reject('A dive gate needs its altitude as a number of metres MSL.', 'altitudeMslM');
    const radiusM = payload.radiusM == null ? null
      : isNum(payload.radiusM) && payload.radiusM > 0 ? payload.radiusM
        : reject('Gate corridor radius must be a positive number of metres, or null.', 'radiusM');
    const dive = diveOf(doc);
    const existing = dive.gates.find((g) => g.kind === kind);
    /** @type {DiveGate} */
    const gate = {
      id: existing ? existing.id : ctx.idgen(ID_PREFIXES.gate),
      kind: /** @type {DiveGate['kind']} */ (kind),
      latitude: /** @type {number} */ (latitude),
      longitude: /** @type {number} */ (longitude),
      altitudeMslM: /** @type {number} */ (altitudeMslM),
      radiusM: /** @type {number|null} */ (radiusM),
    };
    const gates = DIVE_GATE_KINDS.flatMap((k) => (k === kind ? [gate] : dive.gates.filter((g) => g.kind === k)));
    return withDive(doc, { ...dive, gates });
  },

  removeDiveGate(doc, payload) {
    const { kind } = payload;
    if (!isDiveGateKind(kind)) reject(`Gate kind must be one of ${DIVE_GATE_KINDS.join(', ')}.`, 'kind');
    const dive = diveOf(doc);
    if (!dive.gates.some((g) => g.kind === kind)) reject(`No '${String(kind)}' gate in this dive plan.`, 'kind');
    return withDive(doc, { ...dive, gates: dive.gates.filter((g) => g.kind !== kind) });
  },

  /** `null` clears the bailout landing. An omitted name defaults rather than
   * rejecting, the same reasoning as `addSubject`: the pilot dropping the pin
   * has not typed a label yet. */
  setDiveBailout(doc, payload) {
    const raw = payload.bailout;
    if (raw === null || raw === undefined) return withDive(doc, { ...diveOf(doc), bailout: null });
    if (typeof raw !== 'object' || Array.isArray(raw)) reject('A bailout landing must be an object or null.', 'bailout');
    const b = /** @type {Bag} */ (raw);
    if (!isLatLon(b.latitude, b.longitude)) {
      reject('A bailout landing needs a latitude in -90..90 and a longitude in -180..180.', 'bailout.latitude/longitude');
    }
    const name = b.name === undefined ? 'Bailout landing' : sanitizeName(b.name);
    if (!isValidName(name)) reject('A bailout landing needs a non-empty name.', 'bailout.name');
    const elevationMslM = b.elevationMslM == null ? null
      : isNum(b.elevationMslM) ? b.elevationMslM
        : reject('Bailout elevation must be a number of metres MSL, or null.', 'bailout.elevationMslM');
    /** @type {DiveBailout} */
    const bailout = {
      name: /** @type {string} */ (name),
      latitude: /** @type {number} */ (b.latitude),
      longitude: /** @type {number} */ (b.longitude),
      elevationMslM: /** @type {number|null} */ (elevationMslM),
    };
    return withDive(doc, { ...diveOf(doc), bailout });
  },

  /** `null` clears the plane. Any finite MSL figure is accepted — whether it
   * clears the ridge is the analysis pass's statement to make, not a shape
   * rule's. */
  setDiveRthAltitude(doc, payload) {
    const v = payload.altitudeMslM;
    if (v !== null && v !== undefined && !isNum(v)) {
      reject('The lost-link/RTH altitude must be a number of metres MSL, or null.', 'altitudeMslM');
    }
    return withDive(doc, { ...diveOf(doc), rthAltitudeMslM: isNum(v) ? v : null });
  },

  /** The two numbers the pullout maths is authored against. Each field is
   * addressed on its own — an omitted key leaves that field standing, `null`
   * clears it — so the inspector's speed control never has to resend a load it
   * did not touch, and a payload naming neither field is a caller mistake
   * rather than a no-op write. Both bounds are domain/dive.js's own:
   * `pulloutArc` has no arc to describe at a load of 1 g or less, and no radius
   * to divide out at zero speed. */
  setDiveProfile(doc, payload) {
    const { speedMs, pulloutLoadG } = payload;
    if (speedMs === undefined && pulloutLoadG === undefined) {
      reject('A dive profile command needs a speed, a pullout load, or both.', 'speedMs/pulloutLoadG');
    }
    const dive = diveOf(doc);
    const speed = speedMs === undefined ? dive.speedMs ?? null
      : speedMs === null ? null
        : isNum(speedMs) && speedMs > 0 ? speedMs
          : reject('Dive speed must be a positive number of metres per second, or null.', 'speedMs');
    const load = pulloutLoadG === undefined ? dive.pulloutLoadG ?? null
      : pulloutLoadG === null ? null
        : isNum(pulloutLoadG) && pulloutLoadG > 1 ? pulloutLoadG
          : reject('Pullout load must be a load factor above 1 g, or null.', 'pulloutLoadG');
    return withDive(doc, { ...dive, speedMs: speed, pulloutLoadG: load });
  },
};
