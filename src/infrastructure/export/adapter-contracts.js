// adapter-contracts.js — what every importer and exporter shares (ADR 0007's
// `AdapterResult`, ADR 0010 §2's loss-by-construction).
//
// The rule this file exists to make mechanical: **an unsupported concept is
// never silently dropped.** Asking each adapter author to remember to write a
// loss entry for every mission semantic their format cannot hold is asking them
// to be exhaustive about absence, which nobody is. So an adapter declares one
// static table of what it supports, the compiler says what the mission uses,
// and `deriveLosses` produces the entries. Forgetting is not available: a
// concept missing from the table is `unsupported`, so the failure mode of an
// out-of-date adapter is an over-reported loss, never an under-reported one.
//
// `status` is derived for the same reason. An adapter that returns a payload and
// three losses is `degraded` whether or not its author thought so, and one that
// returns no payload is `failed`.
//
// The last two exports are boundary code and are strict on purpose: every string
// coming out of an imported file passes through `sanitizeText`, and every
// imported file passes `assertSafeSize` before a parser sees it (ADR 0010 §4).

/** @typedef {import('../../domain/mission/compile.js').Concept} Concept */
/** @typedef {import('../../domain/mission/compile.js').InventoryEntry} InventoryEntry */

/** @typedef {'native'|'approximate'|'unsupported'} SupportLevel */
/** @typedef {Partial<Record<Concept, SupportLevel>>} SupportTable */
/** @typedef {'dropped'|'approximated'} LossDisposition */
/** @typedef {{ concept: Concept, detail: string, disposition: LossDisposition }} SemanticLoss */
/** @typedef {{ code: string, message: string }} AdapterError */
/** @typedef {'ok'|'degraded'|'failed'} AdapterStatus */

/**
 * ADR 0007's frozen envelope. `payload` is the produced artifact on export, the
 * imported document on import, and null on failure.
 * @template [T=unknown]
 * @typedef {object} AdapterResult
 * @property {AdapterStatus} status
 * @property {T|null} payload
 * @property {readonly string[]} warnings
 * @property {readonly AdapterError[]} errors
 * @property {readonly SemanticLoss[]} semanticLosses
 * @property {string|null} sourceFormat
 * @property {string|null} targetFormat
 * @property {string|null} adapterVersion
 */

/** 5 MB, the cap an imported file meets before any parser sees it (ADR 0010 §4). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * The losses that follow from what a mission uses and what an adapter can hold.
 *
 * A level this function does not recognise — a typo, a table written against a
 * later vocabulary — is treated as `unsupported`, on the same principle as an
 * absent entry: the safe direction to be wrong in is the one that names a loss
 * the format may in fact survive.
 *
 * The result is a fresh array the caller owns: adapters append their own
 * value-level losses (a re-referenced altitude, a truncated name) on top.
 *
 * @param {readonly InventoryEntry[]} inventory  from `compileMission`
 * @param {SupportTable} support                 the adapter's static declaration
 * @returns {SemanticLoss[]}
 */
export function deriveLosses(inventory, support) {
  /** @type {SemanticLoss[]} */ const losses = [];
  for (const entry of inventory) {
    const level = support && Object.hasOwn(support, entry.concept)
      ? support[entry.concept]
      : 'unsupported';
    if (level === 'native') continue;
    losses.push({
      concept: entry.concept,
      detail: entry.detail,
      disposition: level === 'approximate' ? 'approximated' : 'dropped',
    });
  }
  return losses;
}

/**
 * An `AdapterResult` with its status derived from what it carries.
 *
 * The arrays are copied before they are frozen, so the envelope cannot be
 * edited after the fact and the caller's own arrays are not frozen underneath
 * them.
 *
 * @template [T=unknown]
 * @param {object} spec
 * @param {T|null} [spec.payload]
 * @param {readonly string[]} [spec.warnings]
 * @param {readonly AdapterError[]} [spec.errors]
 * @param {readonly SemanticLoss[]} [spec.semanticLosses]
 * @param {string|null} [spec.sourceFormat]
 * @param {string|null} [spec.targetFormat]
 * @param {string|null} [spec.adapterVersion]
 * @returns {AdapterResult<T>}
 */
export function adapterResult({
  payload = null, warnings = [], errors = [], semanticLosses = [],
  sourceFormat = null, targetFormat = null, adapterVersion = null,
}) {
  const losses = Object.freeze([...semanticLosses]);
  const status = payload == null ? 'failed' : losses.length > 0 ? 'degraded' : 'ok';
  return Object.freeze({
    status: /** @type {AdapterStatus} */ (status),
    payload: payload ?? null,
    warnings: Object.freeze([...warnings]),
    errors: Object.freeze([...errors]),
    semanticLosses: losses,
    sourceFormat,
    targetFormat,
    adapterVersion,
  });
}

/**
 * C0, C1 and DEL removed, by code point rather than by a character class — a
 * regex naming these is a regex full of literal control characters, which is
 * both unreadable and what `no-control-regex` exists to catch.
 *
 * Tab, newline and carriage return survive this pass on purpose: the whitespace
 * collapse in `sanitizeText` turns them into the single space they meant, which
 * keeps `a\nb` from becoming `ab`.
 *
 * @param {string} text
 * @returns {string}
 */
function stripControls(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const control = cp < 0x20 || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F);
    if (!control || cp === 0x09 || cp === 0x0A || cp === 0x0D) out += ch;
  }
  return out;
}

/**
 * An imported title, name or note, reduced to text this app is willing to hold.
 *
 * Control characters go (a mission titled with an ANSI escape is a terminal
 * exploit waiting for a log line), whitespace runs collapse so a name cannot
 * carry layout, and the whole thing is capped so an import cannot hand the UI a
 * megabyte-long label. Markup is deliberately *not* stripped: an imported
 * `<script>` stays the literal characters `<script>` and is rendered through
 * `textContent`, because a sanitizer that rewrites markup is a sanitizer that
 * can be tricked into rewriting it into something live (ADR 0010 §4).
 *
 * @param {unknown} value
 * @param {{ maxLen?: number }} [options]
 * @returns {string}
 */
export function sanitizeText(value, { maxLen = 200 } = {}) {
  if (value === null || value === undefined) return '';
  return stripControls(String(value))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trimEnd();
}

/**
 * Whether a file is small enough to parse, answered rather than thrown — the
 * size check is the first thing an import does and its answer belongs in the
 * `AdapterResult`, not in a stack trace.
 *
 * Measured in UTF-8 bytes, because that is what the file was. A string's length
 * in UTF-16 code units is never more than its UTF-8 byte count, so an oversized
 * input is rejected on that alone and the encoder never runs against it.
 *
 * @param {unknown} text
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, error?: AdapterError }}
 */
export function assertSafeSize(text, maxBytes = MAX_IMPORT_BYTES) {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'E-IMPORT-NOT-TEXT', message: 'An imported file must be read as text.' } };
  }
  const tooLarge = () => ({
    ok: false,
    error: {
      code: 'E-IMPORT-TOO-LARGE',
      message: `This file is larger than the ${Math.round(maxBytes / 1024)} kB import limit.`,
    },
  });
  if (text.length > maxBytes) return tooLarge();
  if (new TextEncoder().encode(text).length > maxBytes) return tooLarge();
  return { ok: true };
}
