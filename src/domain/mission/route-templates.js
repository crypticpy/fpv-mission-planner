// route-templates.js — the 3D-05 template row's three starting sketches (M16).
//
// A template here is not a document mutation: it is a list of ordinary reducer
// commands, raised through the same seam every hand edit goes through, so a
// seeded route obeys exactly the rules a drawn one does and a template can
// never author a document the validator would refuse. What a template knows
// that a hand edit doesn't is only geometry: where a first sketch of its shape
// goes, relative to the launch point the mission already has.
//
// The sketches are deliberately modest — a few hundred metres along the route's
// own bearing (north, before there is a route), heights that sit above the
// launch elevation so a fresh seed never starts underground. They are starting
// positions for the pilot to drag, not claims about the terrain; nothing here
// reads a DEM or invents a performance number.

import { bearingTo, destination } from '../geo.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */

/**
 * @typedef {object} TemplatePlan
 * @property {object[]} [commands] the reducer commands that seed the sketch
 * @property {string} [blocked]    why this template cannot seed right now
 */

export const ROUTE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'mountain-dive',
    label: 'Mountain dive',
    hint: 'Approach, dive and recovery gates along the route bearing',
  }),
  Object.freeze({
    id: 'ridge-traverse',
    label: 'Ridge traverse',
    hint: 'Three transit waypoints at a steady height above the ground',
  }),
  Object.freeze({
    id: 'high-altitude-orbit',
    label: 'High-altitude orbit',
    hint: 'One orbit point, high and holding',
  }),
]);

/**
 * The bearing the sketch extends along: the line the pilot already drew, or
 * north when there is nothing drawn yet — a stated default, not a guess about
 * the terrain.
 * @param {MissionDocumentV1} doc
 * @returns {number}
 */
function sketchBearing(doc) {
  const tail = doc.route.waypoints[doc.route.waypoints.length - 1];
  if (!tail) return 0;
  return bearingTo(
    { lat: doc.launch.latitude, lng: doc.launch.longitude },
    { lat: tail.latitude, lng: tail.longitude },
  );
}

/** @param {MissionDocumentV1} doc @param {number} bearingDeg @param {number} distM */
function pointAlong(doc, bearingDeg, distM) {
  const [lat, lng] = destination(doc.launch.latitude, doc.launch.longitude, bearingDeg, distM / 1000);
  return { lat, lng };
}

/**
 * The dive sketch: three gates on the route bearing, descending from well
 * above the launch elevation to just above it. Gate commands are set-by-kind,
 * so re-applying the template moves the same three gates back to the sketch
 * rather than duplicating anything.
 * @param {MissionDocumentV1} doc
 * @returns {TemplatePlan}
 */
function mountainDive(doc) {
  const baseMslM = doc.launch.elevationMslM;
  if (!Number.isFinite(baseMslM)) {
    return { blocked: 'Set the launch elevation first — dive gates are placed relative to it.' };
  }
  const bearingDeg = sketchBearing(doc);
  /** @type {[('approach'|'dive'|'recovery'), number, number][]} */
  const line = [['approach', 200, 250], ['dive', 450, 120], ['recovery', 700, 40]];
  return {
    commands: line.map(([kind, distM, aboveM]) => {
      const at = pointAlong(doc, bearingDeg, distM);
      return {
        type: 'setDiveGate',
        payload: {
          kind,
          latitude: at.lat,
          longitude: at.lng,
          altitudeMslM: /** @type {number} */ (baseMslM) + aboveM,
        },
      };
    }),
  };
}

/**
 * Waypoint-seeding templates sketch a *fresh* route; appending their shape to
 * a route the pilot already drew would tangle two intentions, so they decline
 * instead. (The dive template has no such guard: its gates live beside the
 * route, not on it.)
 * @param {MissionDocumentV1} doc
 * @returns {string|null}
 */
function routeInTheWay(doc) {
  return doc.route.waypoints.length > 0
    ? 'This template sketches a fresh route — this mission already has waypoints.'
    : null;
}

/** @param {MissionDocumentV1} doc @returns {TemplatePlan} */
function ridgeTraverse(doc) {
  const blocked = routeInTheWay(doc);
  if (blocked) return { blocked };
  const bearingDeg = sketchBearing(doc);
  return {
    commands: [300, 600, 900].map((distM) => {
      const at = pointAlong(doc, bearingDeg, distM);
      return {
        type: 'addWaypoint',
        payload: {
          latitude: at.lat,
          longitude: at.lng,
          altitude: { authored: 60, reference: 'agl' },
        },
      };
    }),
  };
}

/** @param {MissionDocumentV1} doc @returns {TemplatePlan} */
function highAltitudeOrbit(doc) {
  const blocked = routeInTheWay(doc);
  if (blocked) return { blocked };
  const at = pointAlong(doc, sketchBearing(doc), 500);
  return {
    commands: [{
      type: 'addWaypoint',
      payload: {
        latitude: at.lat,
        longitude: at.lng,
        altitude: { authored: 120, reference: 'agl' },
        intent: 'orbit',
        holdS: 60,
      },
    }],
  };
}

/** @type {Record<string, (doc: MissionDocumentV1) => TemplatePlan>} */
const BUILDERS = {
  'mountain-dive': mountainDive,
  'ridge-traverse': ridgeTraverse,
  'high-altitude-orbit': highAltitudeOrbit,
};

/**
 * The commands that seed one template onto this document, or the sentence
 * explaining why it declines to.
 * @param {string} id
 * @param {MissionDocumentV1} doc
 * @returns {TemplatePlan}
 */
export function templateCommands(id, doc) {
  const build = BUILDERS[id];
  if (!build) return { blocked: `No route template named '${id}'.` };
  return build(doc);
}
