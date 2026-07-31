// render/missions.js — the Missions fold: which mission is open, the rest of
// them, and where they are being kept.
//
// Every operation goes through src/mission-bridge.js, which is the only writer
// of the working document and the only holder of the repository handle. This
// file is the wording, the rows and the two-step delete — no storage logic and
// no document editing of its own.
import {
  deleteMission, exportMission, listMissions, missionId, missionStorage,
  missionTitle, openMission, renameMission, saveMissionCopy,
} from '../mission-bridge.js';
import {
  compatibilityReport, exportCurrentMission, exportFormats, importForeign,
} from '../interop.js';
import { $ } from './dom.js';

// No injected deps: every operation here goes through the bridge, and the bridge
// is what asks app.js for a re-render when a document actually changed.

/** The row waiting on a second click, and the timer that takes the offer back. */
let armedDelete = null;
let armedTimer = 0;

function setNote(msg, bad = false) {
  const el = $('mission-note');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('share-bad', !!msg && bad);
}

/* ---------- where the missions live ---------- */

/**
 * The durability line. Silent while everything is normal and saving cleanly —
 * a status line that always says "saved" is a status line nobody reads — and
 * loud about the two states a pilot can actually act on: a browser that will not
 * keep the missions past this tab, and a save that failed.
 */
export function renderMissionStorage(info = missionStorage()) {
  const el = $('mission-storage');
  el.dataset.save = info.save;
  el.dataset.adapter = info.adapter || 'none';
  let msg = '';
  let bad = false;
  if (info.save === 'failed') {
    msg = info.message || 'This mission could not be saved.';
    bad = true;
  } else if (!info.durable) {
    msg = 'This browser will not give the planner durable storage, so missions are kept in memory for '
      + 'this tab only — export anything you want to keep.';
    bad = true;
  } else if (info.persisted === false) {
    msg = 'Saved on disk, but the browser may evict it if the device runs short of space. Export a mission '
      + 'you cannot lose.';
  }
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('share-bad', bad);
}

/* ---------- the list ---------- */

const MINUTE = 60000;

/** "just now" / "14 minutes ago" / "3 days ago" — enough to tell two apart. */
function ago(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'saved at an unknown time';
  const mins = Math.round((Date.now() - then) / MINUTE);
  if (mins < 1) return 'saved just now';
  if (mins < 60) return `saved ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `saved ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `saved ${days} day${days === 1 ? '' : 's'} ago`;
}

function disarmDelete() {
  clearTimeout(armedTimer);
  armedDelete = null;
}

function slug(title) {
  return (title || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mission';
}

async function onExport(summary) {
  const json = await exportMission(summary.id);
  if (!json) { setNote('That mission could not be read back, so there was nothing to export.', true); return; }
  // Same two lines of DOM the hangar export uses — a Blob URL on a synthetic
  // link is the whole download story for a static app.
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(summary.title)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setNote(`Exported “${summary.title}”.`);
}

/**
 * @param {{ id: string, title: string, updatedAt: string }} summary
 * @param {boolean} open whether this is the mission on screen
 */
function missionRow(summary, open) {
  const row = document.createElement('div');
  row.className = 'spot-row';
  if (open) row.setAttribute('aria-current', 'true');

  const text = document.createElement('div');
  text.className = 'spot-text';
  const name = document.createElement('span');
  name.className = 'spot-name';
  name.textContent = summary.title;
  const meta = document.createElement('span');
  meta.className = 'spot-meta';
  meta.textContent = open ? `open now · ${ago(summary.updatedAt)}` : ago(summary.updatedAt);
  text.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'spot-actions';
  if (!open) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'map-btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', async () => {
      disarmDelete();
      const ok = await openMission(summary.id);
      setNote(ok ? `Opened “${summary.title}”.` : 'That mission could not be opened.', !ok);
    });
    actions.appendChild(openBtn);
  }
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'link-btn';
  exportBtn.textContent = 'export';
  exportBtn.addEventListener('click', () => { void onExport(summary); });

  // Two-step rather than a confirm() dialog: the second click is the confirmation,
  // it costs nothing to walk away from, and it does not block the tab. Nothing
  // else in this app deletes a mission's worth of work in one click.
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'link-btn';
  del.textContent = armedDelete === summary.id ? 'delete — sure?' : 'delete';
  del.addEventListener('click', async () => {
    if (armedDelete !== summary.id) {
      armedDelete = summary.id;
      del.textContent = 'delete — sure?';
      clearTimeout(armedTimer);
      armedTimer = setTimeout(() => { disarmDelete(); renderMissions(); }, 5000);
      return;
    }
    disarmDelete();
    const wasOpen = summary.id === missionId();
    const gone = await deleteMission(summary.id);
    setNote(gone
      ? `Deleted “${summary.title}”.${wasOpen ? ' Started a fresh mission at the same launch point.' : ''}`
      : 'That mission was already gone.', !gone);
    renderMissions();
  });
  actions.append(exportBtn, del);

  row.append(text, actions);
  return row;
}

async function renderList() {
  const host = $('mission-list');
  const summaries = await listMissions();
  const openId = missionId();
  host.replaceChildren();
  if (!summaries.length) {
    const empty = document.createElement('p');
    empty.className = 'spots-empty';
    empty.textContent = 'No missions saved yet.';
    host.appendChild(empty);
    return;
  }
  for (const s of summaries) host.appendChild(missionRow(s, s.id === openId));
}

/**
 * The whole fold. Safe to call on any pass: the title field is left alone while
 * the pilot is typing in it, so a render triggered by their own keystroke can
 * never move the caret.
 */
export function renderMissions() {
  const title = $('mission-title');
  if (document.activeElement !== title) title.value = missionTitle();
  renderMissionStorage();
  void renderInteropReport();
  void renderList();
}

/* ---------- interop: hand this mission to (or read one from) another tool ---------- */

/** Human words for ADR 0010 §2's concept ids, for a status line a pilot reads once. */
const CONCEPT_LABELS = Object.freeze({
  geometry: 'route geometry',
  'altitude-reference': 'altitude reference',
  speed: 'speed policy',
  hold: 'hold time',
  'camera-intent': 'camera intent',
  'return-policy': 'return policy',
  reserve: 'reserve policy',
});

/** What a set of adapter losses cost, worded for a note appended after "Exported as X" or "Imported as X". */
function lossSummary(losses) {
  if (!losses.length) return 'everything this planner knows about this mission travels.';
  const concepts = [...new Set(losses.map((l) => CONCEPT_LABELS[l.concept] ?? l.concept))];
  const n = concepts.length;
  return `${n} thing${n === 1 ? '' : 's'} this planner knows ${n === 1 ? 'doesn’t' : 'don’t'} travel: ${concepts.join(', ')}.`;
}

/** The other tool's own label for a format id — exportFormats() covers every format this router can name, kml included. */
async function formatLabel(formatId) {
  return (await exportFormats()).find((f) => f.id === formatId)?.label ?? formatId;
}

async function populateInteropFormats() {
  const select = $('interop-format');
  select.replaceChildren(...(await exportFormats()).map((f) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    return opt;
  }));
}

/** What would travel if the open mission were exported right now, one line per format (ADR 0010 §6). */
async function renderInteropReport() {
  // Await before clearing, same as renderList: two overlapping calls that both
  // clear first and append after would leave the report doubled.
  const entries = await compatibilityReport();
  const host = $('interop-report');
  host.replaceChildren();
  for (const entry of entries) {
    const p = document.createElement('p');
    p.className = 'rail-note';
    p.textContent = `${entry.label}: ${lossSummary(entry.losses)}`;
    host.appendChild(p);
  }
}

async function onInteropExport() {
  const formatId = $('interop-format').value;
  const label = await formatLabel(formatId);
  const result = await exportCurrentMission(formatId);
  if (!result.payload) {
    setNote(`That mission can’t be exported as ${label} yet: ${result.errors[0]?.message ?? ''}`, true);
    return;
  }
  // Same Blob-URL-on-a-synthetic-link download onExport() uses above.
  const { text, filename, mime } = result.payload;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  setNote(`Exported as ${label} — ${lossSummary(result.semanticLosses)}`);
}

/* ---------- import ---------- */

async function onFile(e) {
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    setNote(`That file couldn’t be read (${err.message}).`, true);
    return;
  } finally {
    // Clearing the input is what makes picking the same file again fire another
    // change event — and importing one file twice is how a pilot checks that it
    // arrives beside the original rather than on top of it.
    input.value = '';
  }
  // importForeign rides the same lazy chunk the export path does; if that load
  // fails, say so — a silently cleared file input reads as "nothing happened".
  let routed;
  try {
    routed = await importForeign(text, file.name);
  } catch {
    setNote('Importing needs a part of the app that could not be loaded — try again once you are back online.', true);
    return;
  }
  const { formatId, result, applied } = routed;
  if (!formatId) {
    setNote('That file is not a mission format this planner recognizes.', true);
    return;
  }
  if (formatId !== 'mission-document-v1' && !result) {
    setNote(`${await formatLabel(formatId)} files can’t be imported into this planner (export only).`, true);
    return;
  }
  if (result && result.status === 'failed') {
    setNote(`That file is not a mission this planner can read: ${result.errors[0]?.message ?? ''}`, true);
    return;
  }
  if (!applied) { setNote('There is nowhere to store an imported mission in this browser.', true); return; }
  if (!applied.ok) {
    setNote(`That file is not a mission this planner can read: ${applied.errors[0]?.message ?? ''}`, true);
    return;
  }
  const warned = applied.warnings.length ? ` ${applied.warnings.length} thing(s) need attention before analysis.` : '';
  const reid = applied.reidentified ? ' It arrived beside the mission it shares an id with, not over it.' : '';
  const asFormat = formatId === 'mission-document-v1' ? '' : ` as ${await formatLabel(formatId)}`;
  const lossNote = result ? ` ${lossSummary(result.semanticLosses)}` : '';
  setNote(`Imported “${applied.doc.title}”${asFormat} and opened it.${reid}${warned}${lossNote}`);
  renderMissions();
}

export function bindMissions() {
  $('mission-title').addEventListener('change', (e) => {
    const title = e.target.value.trim();
    if (!title) { setNote('A mission needs a name — this one kept the one it had.', true); renderMissions(); return; }
    renameMission(title);
    setNote(`Renamed to “${title}”.`);
  });
  $('btn-mission-copy').addEventListener('click', async () => {
    const copy = await saveMissionCopy();
    if (!copy) { setNote('This mission could not be copied.', true); return; }
    setNote(`Copied to “${copy.title}” — that is the one you are editing now. The original is untouched.`);
    renderMissions();
  });
  void populateInteropFormats();
  $('btn-interop-export').addEventListener('click', () => { void onInteropExport(); });
  $('mission-file').addEventListener('change', (e) => { void onFile(e); });
  // The list goes stale while the fold is shut; opening it is the cheapest place
  // to notice.
  $('mission-fold').addEventListener('toggle', (e) => { if (e.target.open) renderMissions(); });
}
