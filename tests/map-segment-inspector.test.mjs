import test from 'node:test';
import assert from 'node:assert/strict';

import {
  liveSelection,
  nextSelection,
  segmentConstraints,
  segmentFacts,
  segmentHeading,
} from '../src/presentation/map/segment-inspector.js';

/* The segment inspector, minus its DOM (M4 wave C).
 *
 * The panel itself is four `replaceChildren` calls and is checked in the
 * browser. What is worth asserting without a browser is the half that decides
 * *what it says*, and every test below is one of the two ways that can go wrong:
 *
 *   it shows the wrong segment's numbers — a stale selection surviving an edit,
 *     a constraint from a neighbouring leg, a heading off by one;
 *   or it shows an absence as a fact — "clear" for ground nobody sampled,
 *     "level" for altitudes that never resolved, a zero standing in for a null.
 *
 * The second kind is the one that could put an aircraft into a hill, so it gets
 * the most of them. */

/** Metric in, metric out — the formatting is not what these tests are about. */
const units = {
  distanceFromKm: (km) => km,
  distanceUnit: 'km',
  areaFromKm2: (a) => a,
  areaUnit: 'km²',
  speedFromMs: (ms) => ms,
  speedUnit: 'm/s',
};

/** A segment with everything resolved; each test spoils the one field it is about. */
const solved = (over = {}) => ({
  segmentId: 'seg-1',
  index: 1,
  intent: 'transit',
  distanceKm: 2.4,
  courseDeg: 90,
  groundSpeedMs: 12,
  airSpeedMs: 13,
  timeMin: 3.5,
  flightWh: 41.2,
  holdWh: 0,
  energyWh: 41.2,
  holdS: null,
  speedMode: 'cruise',
  speedTargetMs: null,
  speedHonoured: true,
  altitudeMslM: 340,
  altitudeDeltaM: 60,
  altitudeAuthoredM: 120,
  altitudeReference: 'launchRelative',
  vertical: { climbWh: 8.1, descentWh: 0, wh: 8.1, climbS: 30, descentS: 0 },
  clearance: { minM: 74, atSampleId: 'c-9', checked: 40, missing: 0 },
  air: null,
  wind: null,
  explanations: [],
  ...over,
});

const snapshotWith = (segments) => ({
  route: { empty: false },
  segments,
  constraints: [],
});

const factFor = (segment, label) => segmentFacts(segment, units).find((r) => r.label === label);

/* ---------- what stays selected ---------- */

test('a selection survives while the segment it names does', () => {
  const snap = snapshotWith({ 'seg-1': solved() });
  assert.equal(liveSelection('seg-1', snap, true), 'seg-1');
});

test('editing the route away drops the selection without a word', () => {
  // Every one of these is the pilot working, not a failure: dragging the last
  // waypoint off, clearing the route, leaving route mode. A panel still showing
  // a leg that no longer exists would be worse than no panel.
  assert.equal(liveSelection('seg-1', snapshotWith({ 'seg-2': solved() }), true), null,
    'the analysis came back without it');
  assert.equal(liveSelection('seg-1', snapshotWith({}), true), null);
  assert.equal(liveSelection('seg-1', { route: { empty: true }, segments: {} }, true), null,
    'the route was cleared');
  assert.equal(liveSelection('seg-1', { route: null, segments: {} }, true), null);
  assert.equal(liveSelection('seg-1', null, true), null, 'no snapshot yet');
  assert.equal(liveSelection('seg-1', snapshotWith({ 'seg-1': solved() }), false), null,
    'route mode is off — beginner mode included');
  assert.equal(liveSelection(null, snapshotWith({ 'seg-1': solved() }), true), null);
});

test('clicking the open leg closes it, and another switches', () => {
  assert.equal(nextSelection(null, 'seg-1'), 'seg-1');
  assert.equal(nextSelection('seg-1', 'seg-1'), null, 'the same leg toggles shut');
  assert.equal(nextSelection('seg-1', 'seg-2'), 'seg-2');
  // The close button, and a clear that is not a toggle.
  assert.equal(nextSelection('seg-1', null), null);
  assert.equal(nextSelection(null, null), null);
});

/* ---------- what it is called ---------- */

test('the first segment leaves the launch pad and the rest leave a waypoint', () => {
  assert.equal(segmentHeading(0), 'Launch → 1');
  assert.equal(segmentHeading(1), '1 → 2');
  assert.equal(segmentHeading(4), '4 → 5');
  // There is no "→ home" heading: the flight home is not an authored segment,
  // so nothing can select it and nothing has to name it.
  assert.equal(segmentHeading(-1), 'Segment');
  assert.equal(segmentHeading(null), 'Segment');
});

/* ---------- whose findings ---------- */

const constraint = (over) => ({
  id: 'x', code: 'W-TEST', severity: 'caution', text: 't',
  anchor: { scope: 'segment', refId: 'seg-1' }, explanation: null, ...over,
});

test('only this segment’s findings, worst first', () => {
  const all = [
    // Out of order on purpose, and in ADR 0008's order the codes read A, B, C:
    // critical, unknown, advisory. `unknown` outranks `advisory` because "could
    // not check" is a louder thing to say than "here is a fact".
    constraint({ code: 'W-C', severity: 'advisory' }),
    constraint({ code: 'W-OTHER', anchor: { scope: 'segment', refId: 'seg-2' } }),
    constraint({ code: 'W-A', severity: 'critical' }),
    constraint({ code: 'W-MISSION', anchor: { scope: 'mission', refId: null } }),
    constraint({ code: 'W-SAMPLE', anchor: { scope: 'sample', refId: 'seg-1' } }),
    constraint({ code: 'W-B', severity: 'unknown' }),
  ];
  // Mission-wide findings are already on the rail; repeating them in a panel
  // about one leg would read as though they were about that leg. A sample anchor
  // whose refId happens to collide is a different scope and is not this leg.
  assert.deepEqual(segmentConstraints(all, 'seg-1').map((c) => c.code), ['W-A', 'W-B', 'W-C']);
  assert.deepEqual(segmentConstraints([], 'seg-1'), []);
  assert.deepEqual(segmentConstraints(null, 'seg-1'), []);
});

/* ---------- absences, said as absences ---------- */

test('ground nobody sampled reads as unknown, never as clear', () => {
  assert.deepEqual(factFor(solved({ clearance: null }), 'Terrain clearance'),
    { label: 'Terrain clearance', value: 'not checked' });

  const unknown = factFor(
    solved({ clearance: { minM: null, atSampleId: null, checked: 0, missing: 12 } }),
    'Terrain clearance');
  assert.equal(unknown.value, 'unknown');
  assert.match(unknown.note, /could be checked/);

  // A figure with gaps behind it still gets the figure — and the gap beside it,
  // in the same words route-checks.js uses.
  const partial = factFor(
    solved({ clearance: { minM: 74, atSampleId: 'c-9', checked: 30, missing: 10 } }),
    'Terrain clearance');
  assert.match(partial.value, /74/);
  assert.match(partial.note, /unsurveyed rather than clear/);

  assert.match(factFor(solved(), 'Terrain clearance').note, /40 stations checked/);
});

test('a level leg and a leg with no altitudes are not the same row', () => {
  // legVerticalFlight returns nothing for a delta of zero *and* for a delta it
  // could not compute. Collapsing those two would tell a pilot the aircraft
  // holds its height across a leg where nobody knows what its height is.
  assert.equal(factFor(solved({ vertical: null, altitudeDeltaM: 0 }), 'Climb').value,
    'level with the leg before');
  assert.match(factFor(solved({ vertical: null, altitudeDeltaM: null }), 'Climb').value, /unknown/);
});

test('the climb is M3b’s own figure, and a descent is named a descent', () => {
  const climb = factFor(solved(), 'Climb');
  assert.match(climb.value, /8\.1 Wh/, 'the published number, not one recomputed here');
  assert.match(climb.note, /60 m/);

  const descent = factFor(solved({
    altitudeDeltaM: -40,
    // The model gives no credit below level flight, so a descent can cost
    // nothing — which is an answer, not a missing value.
    vertical: { climbWh: 0, descentWh: 0, wh: 0, climbS: 0, descentS: 22 },
  }), 'Descent');
  assert.equal(descent.value, '0.0 Wh');
  assert.match(descent.note, /40 m over 0:22/);
});

test('an unresolved altitude says so instead of printing a height', () => {
  const row = factFor(solved({ altitudeMslM: null }), 'Altitude');
  assert.equal(row.value, '120 m above the launch', 'what the pilot typed is still theirs');
  assert.match(row.note, /no metres-MSL figure resolved/);
  // And both ends of the derivation when it did resolve (ADR 0003).
  assert.equal(factFor(solved(), 'Altitude').note, '340 m MSL');
});

test('an unsolved leg says no airspeed holds it rather than showing a zero', () => {
  const unsolved = solved({ timeMin: null, flightWh: null, energyWh: null });
  assert.equal(factFor(unsolved, 'Time').value, 'no airspeed holds this');
  assert.equal(factFor(unsolved, 'Cruise energy').value, 'no airspeed holds this');
});

test('a dwell is shown, because the cruise figure is the leg alone', () => {
  // Without this row `flightWh` reads as the whole cost of a hold segment.
  assert.equal(factFor(solved(), 'Hold at the far end'), undefined, 'no hold, no row');
  const hold = factFor(solved({ holdWh: 19.4, holdS: 120, energyWh: 60.6 }), 'Hold at the far end');
  assert.equal(hold.value, '19.4 Wh');
  assert.match(hold.note, /2:00 on station/);
});
