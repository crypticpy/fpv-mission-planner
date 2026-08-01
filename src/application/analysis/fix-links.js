// application/analysis/fix-links.js — the fix-linking engine (M10 wave D).
//
// The round-2 design mandate: every no-go links to a specific editor or a
// suggested fix. A constraint already knows what is wrong (its W-* code) and
// what it is about (its anchor); this module adds the missing leg — where in
// the app the lever for it lives. Pure data in, pure descriptor out: the
// Review panel renders the descriptor as a button, app.js interprets it, and
// neither has to know the registry.
//
// The descriptor vocabulary is the app's navigation surface, nothing more:
//
//   { kind: 'segment', segmentId }   open this leg's inspector on the 2D map
//   { kind: 'mode', mode }           switch the Plan workspace mode
//   { kind: 'conditions', control }  reveal one control in the Conditions rail
//   { kind: 'dest', dest }           switch destination (the loadout is Aircraft's)
//   { kind: 'dive', gate }           open M16's dive plan, on one gate's leg
//                                    when a single gate moves the finding and on
//                                    the plan as a whole (`gate: null`) when it
//                                    does not
//
// `control` is a semantic token ('reserve', 'live-weather', …), not a DOM id —
// which element answers to it is the shell's business, so a renamed input
// never reaches into this layer.
//
// A null return is deliberate honesty: some findings are facts about the day
// or the model, not knobs. A row without a link says "know this", not "fix
// this", and inventing a destination for it would teach pilots the links are
// decorative.

/**
 * @typedef {{ kind: 'segment', segmentId: string, label: string }
 *         | { kind: 'mode', mode: '2d'|'analyze', label: string }
 *         | { kind: 'conditions', control: 'reserve'|'live-weather'|'pack-temp'|'cruise-speed', label: string }
 *         | { kind: 'dest', dest: 'aircraft', label: string }
 *         | { kind: 'dive', gate: 'approach'|'dive'|'recovery'|'abort'|'contingency'|null,
 *             label: string }} FixAction
 */

/* `gate: 'contingency'` is the one member of that union that is not a gate. The
 * lost-link altitude, the bailout landing and the abort gate belong to no leg —
 * there is no leg inspector that could edit them — so they open the recovery
 * plan instead, which is the only surface in the app where all three are
 * authored. Sending them to a leg would land the pilot on a panel with no
 * control for the thing they clicked. */

/** @type {(action: FixAction) => Readonly<FixAction>} */
const act = Object.freeze;

/**
 * Code-family table, first match wins, specific before generic. The families
 * mirror the registry's own prefixes; a new code lands in the right place by
 * naming, and an unmatched one lands on null rather than a wrong door.
 * @type {readonly [RegExp, Readonly<FixAction>][]}
 */
const BY_CODE = [
  // The route itself is broken — the only fix is redrawing it on the map.
  [/^W-(ROUTE-UNFLYABLE|WIND-NO-CLOSE)$/,
    act({ kind: 'mode', mode: '2d', label: 'Rework the route' })],
  // M16's dive, before the families whose words it borrows. Three of its codes
  // are fixed at knobs that already exist — the reserve slider and the loadout —
  // and sending them to the dive plan instead would be a shorter walk to the
  // wrong place. The dive's own rows come first so the split is visible here
  // rather than inferred from regex precedence further down.
  [/^W-DIVE-RESERVE-SHORT$/,
    act({ kind: 'conditions', control: 'reserve', label: 'Adjust the reserve' })],
  // The pull's current and the pack's sag under it are properties of the
  // airframe and the pack, exactly as their W-ENERGY-/W-LIFT- cousins are.
  [/^W-DIVE-(MOTOR-MARGIN|ESC-MARGIN|SAG-LIMITED)$/,
    act({ kind: 'dest', dest: 'aircraft', label: 'Review the loadout' })],
  // The pullout is authored on the dive leg: its inspector carries the speed and
  // the pullout-load boxes, which are the two figures every pullout finding
  // turns on — including the one that fires because they are absent.
  [/^W-DIVE-PULLOUT-/,
    act({ kind: 'dive', gate: 'dive', label: 'Open the dive leg' })],
  // A hole in the elevation data is not one gate's fault, and naming a gate here
  // would send the pilot to whichever one this module guessed. The plan is the
  // honest door: every gate on the line is in it.
  [/^W-DIVE-GROUND-UNKNOWN$/,
    act({ kind: 'dive', gate: null, label: 'Check the dive line' })],
  // The two contingency findings. Neither is about a leg, and both are authored
  // in one place; see the note on `gate: 'contingency'` above.
  [/^W-DIVE-(RTH-BELOW-TERRAIN|NO-BAILOUT)$/,
    act({ kind: 'dive', gate: 'contingency', label: 'Open the recovery plan' })],
  // Energy findings whose lever is the reserve the pilot chose to hold back.
  [/^W-(ROUTE-RESERVE-SHORT|RESERVE-|RETURN-ENERGY-SHORT)/,
    act({ kind: 'conditions', control: 'reserve', label: 'Adjust the reserve' })],
  // Ground truth: the elevation profile is where the route meets the terrain.
  [/^W-(TERR-|RETURN-TERRAIN-|DATA-TERRAIN-|DATA-ALTITUDE-)/,
    act({ kind: 'mode', mode: 'analyze', label: 'See the ground' })],
  [/^W-(RF-|DATA-LINK-)/,
    act({ kind: 'mode', mode: 'analyze', label: 'See the link check' })],
  // A stale — or absent — forecast has one button that fixes it.
  [/^W-DATA-FORECAST-|^W-WIND-(STALE|NODATA)$/,
    act({ kind: 'conditions', control: 'live-weather', label: 'Refresh the weather' })],
  [/^W-ENERGY-PACK-/,
    act({ kind: 'conditions', control: 'pack-temp', label: 'Set the pack temperature' })],
  // Lift and pack-rating findings are properties of the loadout, not the plan.
  [/^W-(ENERGY-|LIFT-)/,
    act({ kind: 'dest', dest: 'aircraft', label: 'Review the loadout' })],
  [/^W-SPEED-/,
    act({ kind: 'conditions', control: 'cruise-speed', label: 'Adjust cruise speed' })],
  [/^W-SHOT-SUBJECT-MISSING$/,
    act({ kind: 'mode', mode: '2d', label: 'Place the subject' })],
  // The wind and air families are read in Analyze; the fix is understanding.
  [/^W-(WIND-|AIR-|ALT-)/,
    act({ kind: 'mode', mode: 'analyze', label: 'See the analysis' })],
];

/**
 * The fix for one constraint, or null when there is no honest one.
 *
 * A segment anchor outranks every family rule: whatever the code, a finding
 * about one leg is fixed at that leg, and the inspector is where its knobs
 * (altitude, speed, intent) live.
 *
 * @param {{ code: string, anchor?: { scope: string, refId: string|null } }} c
 * @returns {Readonly<FixAction>|null}
 */
export function fixFor(c) {
  if (!c || typeof c.code !== 'string') return null;
  if (c.anchor?.scope === 'segment' && c.anchor.refId) {
    return act({ kind: 'segment', segmentId: c.anchor.refId, label: 'Open this leg' });
  }
  for (const [re, action] of BY_CODE) {
    if (re.test(c.code)) return action;
  }
  return null;
}
