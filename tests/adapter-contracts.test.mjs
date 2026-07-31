import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_IMPORT_BYTES, adapterResult, assertSafeSize, deriveLosses, sanitizeText,
} from '../src/infrastructure/export/adapter-contracts.js';

/* The property under test is ADR 0010 §2's: an adapter author cannot forget to
 * report a loss, because nobody writes the losses. The mission says what it
 * uses, the adapter declares one static table of what it can hold, and the
 * entries fall out. The failure mode that matters is the silent one — a concept
 * that is neither supported nor reported — so the tests that count are the ones
 * about absence: a table with a gap in it, and a table written before a concept
 * existed. */

/** What `compileMission` hands over: concepts with a human fragment each. */
const INVENTORY = [
  { concept: 'geometry', detail: '3 waypoints from launch' },
  { concept: 'altitude-reference', detail: 'altitudes authored launch-relative' },
  { concept: 'speed', detail: 'cruise speed policy' },
  { concept: 'hold', detail: '2 hold segments' },
];

const conceptsOf = (losses) => losses.map((l) => l.concept);

/* ---------- 1. losses fall out of the table ---------- */

test('a native concept is no loss; approximate and unsupported are named', () => {
  const losses = deriveLosses(INVENTORY, {
    geometry: 'native',
    'altitude-reference': 'native',
    speed: 'approximate',
    hold: 'unsupported',
  });

  assert.deepEqual(losses, [
    { concept: 'speed', detail: 'cruise speed policy', disposition: 'approximated' },
    { concept: 'hold', detail: '2 hold segments', disposition: 'dropped' },
  ]);
});

test('a concept missing from the table is a loss, which is what makes forgetting safe', () => {
  // The table an adapter author wrote before `hold` existed, or forgot to
  // extend. The concept is still reported, as dropped.
  const losses = deriveLosses(INVENTORY, { geometry: 'native', 'altitude-reference': 'native', speed: 'native' });
  assert.deepEqual(losses, [{ concept: 'hold', detail: '2 hold segments', disposition: 'dropped' }]);
});

test('an empty or absent table loses everything the mission uses', () => {
  assert.deepEqual(conceptsOf(deriveLosses(INVENTORY, {})), ['geometry', 'altitude-reference', 'speed', 'hold']);
  for (const loss of deriveLosses(INVENTORY, {})) assert.equal(loss.disposition, 'dropped');
});

test('a support level this vocabulary does not know is treated as unsupported', () => {
  const losses = deriveLosses(INVENTORY, {
    geometry: 'nativ', 'altitude-reference': 'partial', speed: 'NATIVE', hold: 'native',
  });
  assert.deepEqual(conceptsOf(losses), ['geometry', 'altitude-reference', 'speed']);
  assert.deepEqual([...new Set(losses.map((l) => l.disposition))], ['dropped']);
});

test('support is read from the table itself, not from what it inherits', () => {
  const inherited = Object.create({ geometry: 'native', 'altitude-reference': 'native', speed: 'native', hold: 'native' });
  assert.equal(deriveLosses(INVENTORY, inherited).length, 4, 'an inherited claim of support is not support');
});

test('a mission that uses nothing loses nothing', () => {
  assert.deepEqual(deriveLosses([], { geometry: 'unsupported' }), []);
});

test('the derived losses are the adapters to append to', () => {
  const losses = deriveLosses(INVENTORY, { geometry: 'native' });
  const before = losses.length;
  losses.push({ concept: 'altitude-reference', detail: 'AMSL re-referenced within 0.4 m', disposition: 'approximated' });
  assert.equal(losses.length, before + 1, 'value-level losses go on top of the derived ones');
});

/* ---------- 2. status is derived, never chosen ---------- */

test('status follows the payload and the losses', () => {
  assert.equal(adapterResult({ payload: '<gpx/>' }).status, 'ok');
  assert.equal(adapterResult({
    payload: '<gpx/>',
    semanticLosses: [{ concept: 'hold', detail: '2 hold segments', disposition: 'dropped' }],
  }).status, 'degraded');
  assert.equal(adapterResult({ payload: null }).status, 'failed');
  assert.equal(adapterResult({}).status, 'failed', 'no payload at all is a failure');
  assert.equal(adapterResult({ payload: undefined }).status, 'failed');
});

test('a payload that arrived with warnings or errors is still judged on the payload', () => {
  const result = adapterResult({
    payload: '<gpx/>',
    warnings: ['3 vendor extensions were dropped'],
    errors: [{ code: 'E-NOTE', message: 'a note that did not stop the export' }],
  });
  assert.equal(result.status, 'ok', 'ADR 0010: failed is about the payload, degraded about the losses');
  assert.deepEqual(result.warnings, ['3 vendor extensions were dropped']);
  assert.equal(result.errors[0].code, 'E-NOTE');
});

test('an empty payload is still a payload', () => {
  assert.equal(adapterResult({ payload: '' }).status, 'ok');
  assert.equal(adapterResult({ payload: 0 }).status, 'ok');
});

test('the envelope carries its formats and its version, defaulting to null', () => {
  const result = adapterResult({
    payload: { schemaVersion: 1 }, sourceFormat: 'gpx', targetFormat: 'mission', adapterVersion: '1.0.0',
  });
  assert.equal(result.sourceFormat, 'gpx');
  assert.equal(result.targetFormat, 'mission');
  assert.equal(result.adapterVersion, '1.0.0');

  const bare = adapterResult({ payload: 'x' });
  assert.deepEqual(
    [bare.sourceFormat, bare.targetFormat, bare.adapterVersion, bare.warnings, bare.errors, bare.semanticLosses],
    [null, null, null, [], [], []],
  );
});

test('the envelope is frozen, and does not freeze the caller arrays it copied', () => {
  const losses = [{ concept: 'hold', detail: '2 hold segments', disposition: 'dropped' }];
  const result = adapterResult({ payload: '<gpx/>', semanticLosses: losses });

  assert.throws(() => { result.status = 'ok'; }, TypeError);
  assert.throws(() => { result.semanticLosses.push({}); }, TypeError);
  assert.equal(Object.isFrozen(losses), false, "the caller's own array is left alone");

  losses.push({ concept: 'speed', detail: 'later', disposition: 'dropped' });
  assert.equal(result.semanticLosses.length, 1, 'the envelope copied rather than aliased');
});

/* ---------- 3. imported text ---------- */

/** Control characters, built rather than typed, so this file stays plain text. */
const ch = (code) => String.fromCharCode(code);

test('control characters are stripped from imported text', () => {
  const hostile = `Ridge${ch(0)}${ch(7)} run${ch(27)}[31m${ch(127)}${ch(155)}`;
  assert.equal(sanitizeText(hostile), 'Ridge run[31m');
});

test('whitespace runs collapse to one space, and the ends are trimmed', () => {
  assert.equal(sanitizeText(`  Pedernales${ch(9)}${ch(10)}${ch(13)}ridge   run  `), 'Pedernales ridge run');
  assert.equal(sanitizeText(`a${ch(10)}b`), 'a b', 'a newline is a space, not nothing');
  assert.equal(sanitizeText('   '), '');
});

test('text is capped, and the cap is caller-settable', () => {
  assert.equal(sanitizeText('a'.repeat(500)).length, 200);
  assert.equal(sanitizeText('a'.repeat(500), { maxLen: 12 }), 'a'.repeat(12));
  assert.equal(sanitizeText('once upon a time', { maxLen: 5 }), 'once', 'no trailing space at the cut');
  assert.equal(sanitizeText('short', { maxLen: 200 }), 'short');
});

test('anything that is not text is coerced, and nothing at all is empty', () => {
  assert.equal(sanitizeText(42), '42');
  assert.equal(sanitizeText(true), 'true');
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(''), '');
});

test('markup survives as literal text rather than being rewritten', () => {
  // Deliberate: this app renders imported strings through `textContent`, and a
  // sanitizer that rewrites markup is one that can be tricked into rewriting it
  // into something live.
  assert.equal(sanitizeText('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(sanitizeText('Bell & Howell'), 'Bell & Howell');
});

/* ---------- 4. the size gate ---------- */

test('a file inside the cap passes, and one over it fails with a code', () => {
  assert.deepEqual(assertSafeSize('<gpx/>'), { ok: true });
  assert.deepEqual(assertSafeSize('', 0), { ok: true });

  const verdict = assertSafeSize('a'.repeat(2048), 1024);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error.code, 'E-IMPORT-TOO-LARGE');
  assert.match(verdict.error.message, /limit/);
});

test('the cap is bytes, not characters', () => {
  assert.equal(assertSafeSize('é'.repeat(6), 10).ok, false, '6 characters, 12 UTF-8 bytes');
  assert.equal(assertSafeSize('é'.repeat(4), 10).ok, true, '4 characters, 8 UTF-8 bytes');
  assert.equal(assertSafeSize('🛩'.repeat(2), 7).ok, false, 'one emoji is 4 bytes');
});

test('a non-string input is refused rather than measured', () => {
  for (const value of [null, undefined, 42, {}, new Uint8Array(4)]) {
    const verdict = assertSafeSize(value);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.error.code, 'E-IMPORT-NOT-TEXT');
  }
});

test('the default cap is ADR 0010 §4\'s 5 MB', () => {
  assert.equal(MAX_IMPORT_BYTES, 5 * 1024 * 1024);
  assert.equal(assertSafeSize('a'.repeat(1024)).ok, true);
});

test('the gate never throws, whatever it is handed', () => {
  assert.doesNotThrow(() => assertSafeSize(Symbol('nope')));
  assert.doesNotThrow(() => assertSafeSize({ toString() { throw new Error('hostile'); } }));
});
