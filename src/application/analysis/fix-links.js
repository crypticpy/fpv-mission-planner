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
 *         | { kind: 'dest', dest: 'aircraft', label: string }} FixAction
 */

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
