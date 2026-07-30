// mission-migrations.js — the one door an untrusted mission record comes
// through (ADR 0002: migrations are forward-only, one step per schema version;
// unknown future versions are rejected with a readable error, never partially
// loaded; corrupt or incomplete records fail safely to "not loaded").
//
// The registry below is empty on purpose — v1 is the first version, so there is
// nothing to step from yet. It is written as a registry anyway because the
// shape of the v1→v2 change is the whole point: one function, keyed by the
// version it upgrades *from*, returning the next version's document. When v2
// lands, `MIGRATIONS[1]` appears here beside a round-trip fixture and no caller
// changes.
//
// Three refusals worth naming, because each one is a different kind of bad day:
//
//   a future version is a *newer app wrote this*. We cannot know what fields
//     mean, so we say so by version number and stop. Downgrading by dropping
//     unknown fields would hand the pilot a mission quietly missing the thing
//     they saved it for.
//
//   a missing or non-numeric version is *this isn't ours* — a stray blob, a
//     half-written record, someone's JSON file. Rejected before any field of it
//     is read as if it meant something.
//
//   a structurally invalid document is rejected with the validator's own error
//     list, so the failure is reportable rather than a shrug. Warnings ride
//     along on success: an intact mission with an unresolved altitude loads,
//     and the caller is told what is missing.

import { MISSION_SCHEMA_VERSION, validateMission } from './mission-schema.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').ValidationIssue} ValidationIssue */

/**
 * @typedef {object} MigrationResult
 * @property {boolean} ok
 * @property {MissionDocumentV1} [doc]      only when ok
 * @property {number} [fromVersion]         the version the record arrived as
 * @property {ValidationIssue[]} [errors]   only when not ok
 * @property {ValidationIssue[]} [warnings] completeness notes, on success
 */

/**
 * Forward-only upgrade steps, keyed by the version each one upgrades *from*.
 * A step takes the document at version N and returns it at version N+1; it may
 * assume nothing beyond "this validated as version N".
 *
 * @type {Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>}
 */
const MIGRATIONS = {};

/**
 * Bring an untrusted record up to the current schema version, or say why not.
 *
 * @param {unknown} raw
 * @returns {MigrationResult}
 */
export function migrateMission(raw) {
  /** @param {string} code @param {string} message @param {string} [path] */
  const fail = (code, message, path = '') => ({ ok: false, errors: [{ path, code, message }] });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('E-DOC-NOT-OBJECT',
      `A mission record must be an object; got ${Array.isArray(raw) ? 'an array' : typeof raw}.`);
  }

  const version = /** @type {Record<string, unknown>} */ (raw).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail('E-DOC-VERSION-MISSING',
      `This record does not declare a mission schema version (found ${JSON.stringify(version)}), `
      + 'so it cannot be read as a mission.', 'schemaVersion');
  }
  if (version > MISSION_SCHEMA_VERSION) {
    return fail('E-DOC-VERSION-FUTURE',
      `This mission was saved by a newer version of the planner (schema v${version}; `
      + `this build reads up to v${MISSION_SCHEMA_VERSION}). Update the app to open it — `
      + 'it has been left untouched.', 'schemaVersion');
  }

  // Step forward one version at a time. Nothing is written back to `raw`: each
  // step hands over its own object, so a failure halfway up the chain leaves
  // the caller's record exactly as it arrived.
  let doc = /** @type {Record<string, unknown>} */ ({ ...raw });
  for (let v = version; v < MISSION_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      return fail('E-DOC-MIGRATION-MISSING',
        `No migration exists from mission schema v${v} to v${v + 1}.`, 'schemaVersion');
    }
    doc = step(doc);
  }

  const verdict = validateMission(doc);
  if (!verdict.ok) {
    return { ok: false, fromVersion: version, errors: verdict.errors };
  }
  return {
    ok: true,
    doc: /** @type {MissionDocumentV1} */ (/** @type {unknown} */ (doc)),
    fromVersion: version,
    warnings: verdict.warnings,
  };
}
