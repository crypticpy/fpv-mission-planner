// segment-inspector.js — one leg of the route, in full, under the map.
//
// The route card answers "how does the whole flight add up". This answers "what
// about that leg" — the one the pilot just clicked on the map, in 2D or in 3D.
// It is the join between a line on a canvas and the analysis identifiers behind
// it: a click comes back with a segment id, and every figure below is read out
// of `snapshot.segments[thatId]` and `snapshot.constraints`.
//
// Three rules hold it together.
//
//   *It computes nothing.* Not the climb energy, not the clearance, not the
//     time. M3 published all of it; recomputing any of it here would create a
//     second answer that could drift from the one on the rail beside it. Where
//     the analysis has no figure, this says so.
//
//   *Unknown reads as unknown.* A leg whose ground was never sampled must never
//     render as clear, and a leg whose altitude never resolved must never render
//     as a height. This is the same rule the 3D scene draws by, in words.
//
//   *Selection is view state.* Nothing here raises a command, writes to the
//     document or persists anything (ADR 0002). Closing the panel clears a
//     variable in map-view.js and asks for another render pass; that is all.
//
// It is not a map layer — it draws no overlays and renders whether or not an
// engine has initialised — so like footprint-panel.js it takes the snapshot
// directly rather than a frame.

import { SEVERITY_RANK } from '../../application/analysis/analysis-contracts.js';
import { WARN_ICON, compass, f0, f1, mmss } from '../../render/format.js';
import { renderSegmentEditor, resetSegmentEditor } from './segment-editor.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('../../application/analysis/analysis-contracts.js').Constraint} Constraint
 * @typedef {import('../../application/analysis/analysis-contracts.js').SegmentAnalysis} SegmentAnalysis
 * @typedef {import('../../application/analysis/analysis-contracts.js').SegmentShot} SegmentShot
 * @typedef {import('./map-adapter.js').UnitSet} UnitSet
 * @typedef {import('./segment-editor.js').SceneProjection} SceneProjection
 * @typedef {import('./segment-editor.js').Raise} Raise
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** How the pilot said the height, in the words they chose it with. */
const REFERENCE_WORD = {
  msl: 'MSL',
  agl: 'above ground',
  launchRelative: 'above the launch',
};

/**
 * `ScreenDirection` in a sentence. The five values are a closed vocabulary from
 * domain/camera.js and each one is a different shot, so each gets its own words
 * rather than a shared "moves". 'held' is the absence of a sweep, not a sixth
 * direction, and says so.
 */
const SCREEN_WORD = {
  'left-to-right': 'crosses the frame left to right',
  'right-to-left': 'crosses the frame right to left',
  toward: 'closes on it head-on',
  away: 'leaves it behind',
  held: 'held in frame — this leg barely travels',
};

/* ---------- the pure half ---------- */

/**
 * Which segment the next render should be showing.
 *
 * The selection is a view variable and the route underneath it is not: a
 * waypoint can be dragged away, the route can be cleared, route mode can be
 * switched off, and the analysis can come back without the segment that was
 * open. None of those are errors — they are the pilot editing — so a selection
 * that no longer names anything is dropped silently rather than defended.
 *
 * The membership test is against `snapshot.segments`, which is the record the
 * inspector reads from and the only place a segment id appears in the published
 * analysis; the route's own legs carry no id.
 *
 * @param {string|null} selectedSegmentId
 * @param {AnalysisSnapshot|null} snapshot
 * @param {boolean} routeMode
 * @returns {string|null}
 */
export function liveSelection(selectedSegmentId, snapshot, routeMode) {
  if (!selectedSegmentId || !routeMode || !snapshot) return null;
  const route = snapshot.route;
  if (!route || route.empty) return null;
  return snapshot.segments?.[selectedSegmentId] ? selectedSegmentId : null;
}

/**
 * What a click on a leg means, given what is already open.
 *
 * Clicking the open leg closes it, which is the gesture that makes the panel
 * dismissable without going for the button. Kept here rather than in either
 * engine so 2D and 3D cannot come to different conclusions about the same click.
 *
 * @param {string|null} current
 * @param {string|null} clicked  null is an explicit clear, not a toggle
 * @returns {string|null}
 */
export function nextSelection(current, clicked) {
  if (clicked == null) return null;
  return clicked === current ? null : clicked;
}

/**
 * The heading for the segment at `index`. Segment 0 leaves the launch pad;
 * every other one leaves the waypoint before it. The same vocabulary the route
 * table's leg column uses, minus its "→ home" row — that row is the flight home,
 * and the flight home is not an authored segment.
 * @param {number} index
 * @returns {string}
 */
export function segmentHeading(index) {
  if (!Number.isInteger(index) || index < 0) return 'Segment';
  return index === 0 ? 'Launch → 1' : `${index} → ${index + 1}`;
}

/**
 * The findings about this one segment, worst first.
 *
 * Anchors are the join (ADR 0008): a constraint about a segment carries
 * `{scope: 'segment', refId}`. Mission-wide findings are deliberately not
 * repeated here — they are already on the rail, and a panel about one leg that
 * showed them would read as though they were about that leg.
 *
 * @param {readonly Constraint[]|null|undefined} constraints
 * @param {string} segmentId
 * @returns {Constraint[]}
 */
export function segmentConstraints(constraints, segmentId) {
  const rank = (/** @type {string} */ s) => SEVERITY_RANK[s] ?? SEVERITY_RANK.unknown;
  return [...(constraints ?? [])]
    .filter((c) => c.anchor?.scope === 'segment' && c.anchor.refId === segmentId)
    .sort((a, b) => rank(a.severity) - rank(b.severity));
}

/**
 * The rows of the fact list, as label/value pairs already in the pilot's units.
 *
 * Every branch that returns a word instead of a number is deliberate. "Not
 * checked" and "unknown" are different states and are named differently; a
 * figure with unsurveyed ground behind it says so beside itself; a level leg and
 * a leg whose altitudes never resolved do not share a line.
 *
 * @param {SegmentAnalysis} segment
 * @param {UnitSet} u
 * @returns {{ label: string, value: string, note?: string }[]}
 */
export function segmentFacts(segment, u) {
  const rows = [];

  rows.push({
    label: 'Distance',
    value: `${f1(u.distanceFromKm(segment.distanceKm))} ${u.distanceUnit}`,
  });
  rows.push({
    label: 'Time',
    value: segment.timeMin == null ? 'no airspeed holds this' : mmss(segment.timeMin),
  });
  rows.push({
    label: 'Cruise energy',
    value: segment.flightWh == null ? 'no airspeed holds this' : `${f1(segment.flightWh)} Wh`,
  });

  /* The dwell only exists on the intents that carry one, and `flightWh` above is
   * the leg alone — so a hold that is not shown would make the two figures look
   * like the whole cost of the segment when they are not. */
  if (segment.holdWh > 0) {
    rows.push({
      label: 'Hold at the far end',
      value: `${f1(segment.holdWh)} Wh`,
      note: segment.holdS ? `${mmss(segment.holdS / 60)} on station` : undefined,
    });
  }

  rows.push(verticalRow(segment));
  rows.push(altitudeRow(segment));
  rows.push(clearanceRow(segment));
  if (segment.shot) rows.push(...shotRows(segment.shot));
  return rows;
}

/**
 * The shot, exactly as M7 wave C computed it (ADR 0011 §3) — four rows, and not
 * one of the numbers in them is arrived at here.
 *
 * Every field of a `SegmentShot` is separately nullable and each null names a
 * different missing input: the five geometry fields go null together when an
 * altitude never resolved (a shot short one of its three points is not a
 * partially known shot), while the framing pair goes null on its own when the
 * subject has no radius or the scene has no camera profile. So the rows say
 * which input is absent rather than printing an em dash and leaving the pilot to
 * guess whether the shot is unknown or the lens is.
 *
 * @param {SegmentShot} shot
 * @returns {{ label: string, value: string, note?: string }[]}
 */
function shotRows(shot) {
  const rows = [];

  rows.push({
    label: 'Framing',
    value: shot.subjectName,
    note: shot.screenDirection
      ? SCREEN_WORD[shot.screenDirection] ?? shot.screenDirection
      : 'the leg passes straight over it — there is no side of frame to cross to',
  });

  const start = shot.distanceStartM;
  const end = shot.distanceEndM;
  rows.push({
    label: 'Subject range',
    value: start == null || end == null
      ? 'unknown — an altitude this shot is measured between never resolved'
      : `${f0(start)} → ${f0(end)} m`,
    note: shot.bearingToSubjectDeg == null
      ? undefined
      : `${f0(shot.bearingToSubjectDeg)}° ${compass(shot.bearingToSubjectDeg)} from the leg's midpoint`,
  });

  const elevation = shot.elevationAngleDeg;
  rows.push({
    label: 'Elevation angle',
    value: elevation == null
      ? 'unknown'
      : `${f1(Math.abs(elevation))}° ${elevation < 0 ? 'below' : 'above'} horizontal`,
  });

  const a = shot.framingStart;
  const b = shot.framingEnd;
  rows.push({
    label: 'Frame filled',
    value: a == null || b == null
      ? (shot.fov == null
        ? 'no camera profile — there is no frame to fill'
        : 'no subject radius — nothing to measure against the frame')
      : `${f0(a * 100)}% → ${f0(b * 100)}%`,
    note: shot.subjectRadiusM == null ? undefined : `taken against a ${f0(shot.subjectRadiusM)} m bounding radius`,
  });

  return rows;
}

/**
 * The climb or the descent, exactly as M3b charged it — never re-derived. A
 * descent can cost nothing (the model gives no credit below level flight) and
 * that is a real answer, not a missing one.
 * @param {SegmentAnalysis} segment
 */
function verticalRow(segment) {
  const v = segment.vertical;
  if (!v) {
    // `legVerticalFlight` returns nothing for a delta of zero *and* for a delta
    // it could not compute. Those are not the same thing to a pilot.
    if (segment.altitudeDeltaM === 0) return { label: 'Climb', value: 'level with the leg before' };
    return { label: 'Climb', value: 'unknown — the altitudes either side never resolved' };
  }
  const climbing = (segment.altitudeDeltaM ?? 0) > 0;
  return {
    label: climbing ? 'Climb' : 'Descent',
    value: `${f1(v.wh)} Wh`,
    note: `${f0(Math.abs(segment.altitudeDeltaM ?? 0))} m over ${mmss((climbing ? v.climbS : v.descentS) / 60)}`,
  };
}

/**
 * What the pilot typed and what every calculation actually used (ADR 0003). Both,
 * always, because the second is derived from the first plus a terrain reading
 * and the pilot cannot check the derivation without seeing both ends of it.
 * @param {SegmentAnalysis} segment
 */
function altitudeRow(segment) {
  const authored = segment.altitudeAuthoredM == null
    ? '—'
    : `${f0(segment.altitudeAuthoredM)} m ${REFERENCE_WORD[segment.altitudeReference] ?? segment.altitudeReference}`;
  return {
    label: 'Altitude',
    value: authored,
    note: segment.altitudeMslM == null
      ? 'no metres-MSL figure resolved — nothing here was derived from it'
      : `${f0(segment.altitudeMslM)} m MSL`,
  };
}

/**
 * The ground under the leg. Three states, and the whole point of the row is that
 * they are three: never looked, looked and found a gap, looked and cleared it.
 * @param {SegmentAnalysis} segment
 */
function clearanceRow(segment) {
  const c = segment.clearance;
  if (!c) return { label: 'Terrain clearance', value: 'not checked' };
  if (c.minM == null) {
    return {
      label: 'Terrain clearance',
      value: 'unknown',
      note: 'no ground under this leg could be checked',
    };
  }
  return {
    label: 'Terrain clearance',
    value: `${f0(c.minM)} m at the lowest`,
    note: c.missing > 0
      ? `${c.missing} of ${c.checked + c.missing} stations have no elevation — `
        + 'treat those stretches as unsurveyed rather than clear'
      : `${c.checked} stations checked`,
  };
}

/* ---------- the DOM half ---------- */

/**
 * The panel, or nothing at all.
 *
 * Called on every map render pass, whether or not anything is selected: a stale
 * inspector is worse than none, and the cheapest way to have no stale inspector
 * is for the same pass that draws the route to decide whether the panel is up.
 *
 * @param {object} view
 * @param {AnalysisSnapshot|null} view.snapshot
 * @param {string|null} view.selectedSegmentId  already resolved by liveSelection
 * @param {UnitSet} view.units
 * @param {() => void} view.onClose
 * @param {SceneProjection} [view.scene]  the document's subjects, profile and
 *   templates — the editing half's only inputs that the snapshot cannot supply
 * @param {Raise} [view.raise]  one command in, its verdict out. Absent before the
 *   mission bridge has handed its port over, and the editing half stays folded
 *   away rather than offering controls that could not land anywhere
 */
export function renderSegmentInspector({ snapshot, selectedSegmentId, units: u, onClose, scene, raise }) {
  const card = $('segment-card');
  if (!card) return;

  const segment = selectedSegmentId ? snapshot?.segments?.[selectedSegmentId] ?? null : null;
  if (!segment) { card.hidden = true; resetSegmentEditor(); return; }
  card.hidden = false;

  const close = $('btn-segment-close');
  // Assigned rather than added: this runs every pass, and `addEventListener`
  // would stack a new handler on each one.
  if (close) close.onclick = onClose;

  const title = $('segment-title');
  if (title) title.textContent = segmentHeading(segment.index);

  const sub = $('segment-sub');
  if (sub) sub.textContent = subLine(segment);

  fillFacts(segmentFacts(segment, u));
  fillWarnings(segmentConstraints(snapshot?.constraints, segment.segmentId));

  const fold = $('segment-editor-fold');
  const editable = !!scene && !!raise;
  if (fold) fold.hidden = !editable;
  if (scene && raise) renderSegmentEditor({ segment, scene, raise });

  const id = $('segment-id');
  if (id) id.textContent = segment.segmentId;
}

/**
 * The line under the heading: what this leg is for, and what it is pointed at.
 *
 * The subject's name comes off the shot record rather than the scene, because
 * the shot is what decided the segment has one — a `subjectRef` the analysis
 * could not resolve produces no shot, and naming a subject the figures below were
 * not computed against would be the panel's one and only lie.
 * @param {SegmentAnalysis} segment
 */
function subLine(segment) {
  const framing = segment.shot ? ` · framing ${segment.shot.subjectName}` : '';
  return `${segment.intent}${framing} · everything below is the analysis's own, not recomputed here.`;
}

/** @param {{ label: string, value: string, note?: string }[]} rows */
function fillFacts(rows) {
  const host = $('segment-facts');
  if (!host) return;
  host.replaceChildren();
  for (const row of rows) {
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.textContent = row.value;
    if (row.note) {
      const note = document.createElement('span');
      note.className = 'segment-note';
      note.textContent = row.note;
      dd.appendChild(note);
    }
    host.append(dt, dd);
  }
}

/**
 * The segment's own findings, in the warning rail's clothes — same classes, same
 * glyphs, same data attributes, so a severity means the same thing wherever a
 * pilot meets it. The text is the producer's, verbatim (ADR 0008).
 * @param {Constraint[]} constraints
 */
function fillWarnings(constraints) {
  const host = $('segment-warnings');
  if (!host) return;
  host.replaceChildren();
  for (const c of constraints) {
    const el = document.createElement('div');
    el.className = `warn warn-${c.severity}`;
    el.dataset.code = c.code;
    el.dataset.severity = c.severity;
    const icon = document.createElement('span');
    icon.className = 'warn-icon';
    icon.textContent = WARN_ICON[c.severity] ?? '●';
    const label = document.createElement('span');
    label.className = 'warn-level';
    label.textContent = c.severity;
    const text = document.createElement('span');
    text.textContent = c.text;
    el.append(icon, label, text);
    host.appendChild(el);
  }
  host.hidden = constraints.length === 0;
}
