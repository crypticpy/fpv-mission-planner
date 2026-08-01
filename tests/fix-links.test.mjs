import test from 'node:test';
import assert from 'node:assert/strict';

import { fixFor } from '../src/application/analysis/fix-links.js';
import { CONSTRAINT_CODES } from '../src/application/analysis/constraints.js';

/* The fix-linking engine (M10 wave D). The round-2 mandate is "every no-go
 * links to a specific editor or suggested fix", and the registry sweep at the
 * bottom is that mandate as a tripwire: a new code either lands in a family
 * here or gets consciously added to the unlinked list, never silently. */

const mission = { scope: 'mission', refId: null };
const at = (code, anchor = mission) => ({ code, anchor });

test('a segment anchor outranks every code family', () => {
  const fix = fixFor(at('W-TERR-CLEARANCE', { scope: 'segment', refId: 'seg_3' }));
  assert.deepEqual({ ...fix }, { kind: 'segment', segmentId: 'seg_3', label: 'Open this leg' });
  // A segment scope with no refId has no leg to open — the family answers.
  assert.equal(fixFor(at('W-TERR-CLEARANCE', { scope: 'segment', refId: null })).mode, 'analyze');
  // A sample anchor is about a metre of ground, not a leg — the family answers.
  assert.equal(fixFor(at('W-TERR-CLEARANCE', { scope: 'sample', refId: 's1' })).mode, 'analyze');
});

test('each family lands on its own door', () => {
  const expect = {
    'W-ROUTE-UNFLYABLE': { kind: 'mode', mode: '2d' },
    'W-WIND-NO-CLOSE': { kind: 'mode', mode: '2d' },
    'W-SHOT-SUBJECT-MISSING': { kind: 'mode', mode: '2d' },
    'W-ROUTE-RESERVE-SHORT': { kind: 'conditions', control: 'reserve' },
    'W-RESERVE-HOLD-BUDGET': { kind: 'conditions', control: 'reserve' },
    'W-RESERVE-ONE-WAY': { kind: 'conditions', control: 'reserve' },
    'W-RETURN-ENERGY-SHORT': { kind: 'conditions', control: 'reserve' },
    'W-TERR-CLEARANCE': { kind: 'mode', mode: 'analyze' },
    'W-RETURN-TERRAIN-BLOCKED': { kind: 'mode', mode: 'analyze' },
    'W-DATA-TERRAIN-ABSENT': { kind: 'mode', mode: 'analyze' },
    'W-DATA-ALTITUDE-UNRESOLVED': { kind: 'mode', mode: 'analyze' },
    'W-RF-LOS-BLOCKED': { kind: 'mode', mode: 'analyze' },
    'W-DATA-LINK-ABSENT': { kind: 'mode', mode: 'analyze' },
    'W-DATA-FORECAST-STALE': { kind: 'conditions', control: 'live-weather' },
    'W-WIND-STALE': { kind: 'conditions', control: 'live-weather' },
    'W-WIND-NODATA': { kind: 'conditions', control: 'live-weather' },
    'W-ENERGY-PACK-COLD': { kind: 'conditions', control: 'pack-temp' },
    'W-ENERGY-SAG-LIMITED': { kind: 'dest', dest: 'aircraft' },
    'W-ENERGY-NO-PACK': { kind: 'dest', dest: 'aircraft' },
    'W-LIFT-NO-LIFT': { kind: 'dest', dest: 'aircraft' },
    'W-SPEED-POLICY-UNSUPPORTED': { kind: 'conditions', control: 'cruise-speed' },
    'W-WIND-LEE': { kind: 'mode', mode: 'analyze' },
    'W-AIR-DENSITY-ALTITUDE': { kind: 'mode', mode: 'analyze' },
    'W-ALT-VERTICAL-UNMODELLED': { kind: 'mode', mode: 'analyze' },
  };
  for (const [code, want] of Object.entries(expect)) {
    const got = fixFor(at(code));
    assert.ok(got, `${code} should link somewhere`);
    for (const [k, v] of Object.entries(want)) {
      assert.equal(got[k], v, `${code} → ${k}`);
    }
    assert.ok(got.label, `${code} has a pilot-facing label`);
  }
});

test('specific families win over the generic ones they share a prefix with', () => {
  // W-WIND-STALE and W-WIND-NODATA are weather-refresh problems, not analysis
  // reading; the generic W-WIND- family must not swallow them.
  assert.equal(fixFor(at('W-WIND-STALE')).control, 'live-weather');
  assert.equal(fixFor(at('W-WIND-NODATA')).control, 'live-weather');
  assert.equal(fixFor(at('W-WIND-REGIME')).mode, 'analyze');
  // Pack temperature is a rail knob; the loadout family must not swallow it.
  assert.equal(fixFor(at('W-ENERGY-PACK-COLD')).control, 'pack-temp');
  assert.equal(fixFor(at('W-ENERGY-HOVER-OVER-RATING')).dest, 'aircraft');
});

test('no honest door means null, not a wrong one', () => {
  assert.equal(fixFor(at('W-ANALYSIS-UNCLASSIFIED')), null);
  assert.equal(fixFor(at('W-SOMETHING-NEW')), null);
  assert.equal(fixFor(null), null);
  assert.equal(fixFor({}), null);
  assert.equal(fixFor({ code: 5 }), null);
});

test('every registered code links, except the consciously unlinked', () => {
  // The two shot codes are segment-anchored by their producer, so the segment
  // rule catches them in practice; at mission scope they are honestly linkless.
  // W-ANALYSIS-UNCLASSIFIED is the taxonomy's own catch-all — by definition
  // nobody knows its lever.
  const unlinked = new Set([
    'W-ANALYSIS-UNCLASSIFIED', 'W-SHOT-HOLD-WIND', 'W-SHOT-ORBIT-RADIUS',
  ]);
  for (const code of Object.keys(CONSTRAINT_CODES)) {
    const fix = fixFor(at(code));
    if (unlinked.has(code)) {
      assert.equal(fix, null, `${code} is on the unlinked list but now matches a family`);
    } else {
      assert.ok(fix, `${code} links nowhere — add a family or consciously add it to the unlinked list`);
    }
  }
});

test('descriptors are shared frozen singletons', () => {
  const a = fixFor(at('W-TERR-CLEARANCE'));
  assert.ok(Object.isFrozen(a));
  assert.equal(a, fixFor(at('W-DATA-TERRAIN-ABSENT'))); // same family, same object
  assert.ok(Object.isFrozen(fixFor(at('W-X', { scope: 'segment', refId: 'seg_1' }))));
});
