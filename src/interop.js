// interop.js — Wave D's composition: the router behind the export button, the
// compatibility report the fold and the brief both read, and the one seam a
// foreign file crosses on its way into the mission document (ADR 0010 §6).
//
// Unlayered by design, the same reason src/mission-bridge.js is: an adapter
// (infrastructure) may not import the compiler (domain would be fine, but the
// layering in ADR 0009 draws no line there) while also being reached by a
// caller that needs both at once — so the module that reaches the compiler and
// the adapters together sits above the taxonomy, at the composition root's own
// level, and every dependency arrives injected rather than imported directly,
// the same pattern every setup* module here follows.
//
// The compiler, adapter-contracts.js and the five adapters behind import-router.js
// are ~3700 lines nobody pays for until they open the mission fold — so they are
// not a static import here, they are `engine()` below: one dynamic import, loaded
// once and cached, the same convention presentation/map/map-view.js uses for the
// 3D engine chunk. Every exported function here is async as a result; nothing
// about what the compiler or the adapters themselves do has changed, only when
// their bytes reach the browser.

/** @typedef {import('./domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./domain/mission/altitude.js').TerrainSampler} TerrainSampler */
/** @typedef {import('./infrastructure/export/adapter-contracts.js').AdapterResult} AdapterResult */
/** @typedef {import('./infrastructure/export/adapter-contracts.js').SemanticLoss} SemanticLoss */

/**
 * @typedef {object} InteropDeps
 * @property {() => MissionDocumentV1|null} missionDocument  the open mission,
 *   read-only — src/mission-bridge.js's own accessor
 * @property {(text: string) => Promise<*>} importMission     the native import
 *   path: validation, re-identification, persistence and open — reused as-is
 *   for a foreign file rather than duplicated per format
 * @property {TerrainSampler|null} [groundAt]  M3's terrain host; an authored
 *   `agl` altitude resolves only once this answers for the point
 * @property {() => void} [requestRender]  accepted for the same reason every
 *   setup* module here takes one, but not called directly: the injected
 *   `importMission` above already asks for its own render on a successful open
 *   (src/mission-bridge.js), so calling it again here would only double one
 *   render that already happened
 */

/** @type {InteropDeps|null} */
let deps = null;

/** @param {InteropDeps} d */
export function setupInterop(d) {
  deps = d;
}

/** @type {Promise<{
 *   compileMission: typeof import('./domain/mission/compile.js').compileMission,
 *   deriveLosses: typeof import('./infrastructure/export/adapter-contracts.js').deriveLosses,
 *   EXPORTABLE: typeof import('./infrastructure/export/import-router.js').EXPORTABLE,
 *   importAny: typeof import('./infrastructure/export/import-router.js').importAny,
 * }>|null} */
let enginePromise = null;

/**
 * The compiler, adapter-contracts.js and the five-adapter registry, loaded once
 * on first use and cached for every call after. One dynamic import across all
 * three rather than one each, so a bundler puts them in a single lazy chunk
 * instead of three small ones — the same reason Vite already draws exactly one
 * chunk for the 3D engine's own several files.
 */
function engine() {
  enginePromise ??= Promise.all([
    import('./domain/mission/compile.js'),
    import('./infrastructure/export/adapter-contracts.js'),
    import('./infrastructure/export/import-router.js'),
  ]).then(([compileMod, contractsMod, routerMod]) => ({
    compileMission: compileMod.compileMission,
    deriveLosses: contractsMod.deriveLosses,
    EXPORTABLE: routerMod.EXPORTABLE,
    importAny: routerMod.importAny,
  }));
  return enginePromise;
}

/**
 * Every format this planner can write, in registry order.
 * @returns {Promise<{ id: string, label: string }[]>}
 */
export async function exportFormats() {
  const { EXPORTABLE } = await engine();
  return EXPORTABLE.map((a) => ({ id: a.format.id, label: a.format.label }));
}

/**
 * The open mission, compiled fresh and handed to one adapter. This never
 * touches the DOM — the render module owns "save this file" — it only answers
 * what the bytes would be (ADR 0010 §6).
 * @param {string} formatId
 * @returns {Promise<AdapterResult>}
 */
export async function exportCurrentMission(formatId) {
  const { compileMission, EXPORTABLE } = await engine();
  const doc = deps?.missionDocument?.() ?? null;
  const surface = EXPORTABLE.find((a) => a.format.id === formatId);
  if (!doc || !surface) {
    return /** @type {AdapterResult} */ ({
      status: 'failed',
      payload: null,
      warnings: [],
      errors: [{
        code: doc ? 'E-INTEROP-UNKNOWN-FORMAT' : 'E-INTEROP-NO-MISSION',
        message: doc ? `'${formatId}' is not a format this planner can export.` : 'No mission is open to export.',
      }],
      semanticLosses: [],
      sourceFormat: 'mission-document-v1',
      targetFormat: formatId,
      adapterVersion: null,
    });
  }
  const compiled = compileMission(doc, { terrainSampler: deps?.groundAt ?? null });
  return surface.exportMission(compiled);
}

/**
 * What each exportable format would keep and lose about the mission open right
 * now, without writing a single byte — so the fold and the brief can both show
 * "what travels" before any export button is pressed (ADR 0010 §6).
 * @returns {Promise<{ formatId: string, label: string, losses: SemanticLoss[] }[]>}
 */
export async function compatibilityReport() {
  const doc = deps?.missionDocument?.() ?? null;
  if (!doc) return [];
  const { compileMission, deriveLosses, EXPORTABLE } = await engine();
  const compiled = compileMission(doc, { terrainSampler: deps?.groundAt ?? null });
  return EXPORTABLE.map((a) => ({
    formatId: a.format.id,
    label: a.format.label,
    losses: deriveLosses(compiled.inventory, a.support),
  }));
}

/**
 * A picked file, whatever tool wrote it. `mission-document-v1` — this app's
 * own export — skips the adapter layer and goes straight to the native import
 * path; every other recognised format is read through its adapter first and
 * the resulting document handed to that same native path, so a foreign file
 * gets exactly the validation, re-identification, persistence and open a
 * native one does (ADR 0010 §6).
 * @param {string} text
 * @param {string} filename
 * @returns {Promise<{ formatId: string|null, result: AdapterResult|null, applied: * }>}
 */
export async function importForeign(text, filename) {
  const { importAny } = await engine();
  const { formatId, result } = importAny(text, { filename });
  if (formatId === 'mission-document-v1') {
    return { formatId, result: null, applied: (await deps?.importMission?.(text)) ?? null };
  }
  if (!result || result.status === 'failed' || !result.payload) {
    return { formatId, result, applied: null };
  }
  const applied = (await deps?.importMission?.(JSON.stringify(result.payload))) ?? null;
  return { formatId, result, applied };
}
