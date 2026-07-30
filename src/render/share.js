// render/share.js — the Share fold (§6.3): export your own rigs, packs and
// logbook as a file, and take a stranger's file in.
//
// All the judgement lives in ../share.js, which knows nothing about the DOM. This
// file is the two buttons, the two checkboxes, and the panel that shows what an
// import would do *before* it does it — the confirm button is the only path to
// storage, so a file the pilot doesn't like the look of costs a click to walk
// away from.
import {
  applyPlan, buildPayload, describePlan, planImport, planIsEmpty, planSkips, readPayload,
} from '../share.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update, populateControls }
export function setupShare(d) { deps = d; }

// The plan awaiting a decision. Nothing in it has touched storage.
let pending = null;

const FILENAME = 'fpv-hangar.json';

function setNote(msg, bad = false) {
  const el = $('share-note');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('share-bad', !!msg && bad);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function countSentence(c) {
  return [
    plural(c.drones, 'drone', 'drones'),
    plural(c.batteries, 'pack', 'packs'),
    plural(c.logs, 'flight log', 'flight logs'),
  ].join(', ');
}

/* ---------- export ---------- */

function onExport() {
  const includeLogs = $('share-logs').checked;
  const includeTimestamps = $('share-times').checked;
  const payload = buildPayload({ includeLogs, includeTimestamps });
  const counts = {
    drones: payload.drones.length,
    batteries: payload.batteries.length,
    logs: payload.flightLogs.length,
  };
  if (!counts.drones && !counts.batteries && !counts.logs) {
    setNote('Nothing of your own to share yet — add a drone or a pack first, and the file will '
      + 'carry it.', true);
    return;
  }
  // Two lines of DOM instead of a library: a Blob URL on a synthetic link is the
  // whole download story for a static app.
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = FILENAME;
  a.click();
  URL.revokeObjectURL(url);
  setNote(`Saved ${FILENAME} — ${countSentence(counts)}`
    + `${includeTimestamps ? ', dates included' : ', no dates or locations'}.`);
}

/* ---------- import ---------- */

function clearPlan() {
  pending = null;
  $('share-diff').hidden = true;
  $('share-skips').replaceChildren();
  $('share-summary').textContent = '';
}

function renderDiff(plan) {
  $('share-summary').textContent = describePlan(plan);
  const host = $('share-skips');
  host.replaceChildren();
  for (const s of planSkips(plan)) {
    const row = document.createElement('p');
    row.className = 'rail-note share-skip';
    // The record's own id and the reason it was refused, on one line: that pair
    // is what lets the sender fix their file.
    row.textContent = `Skipped ${s.kind} ‘${s.originalId}’ — ${s.reason}`;
    host.appendChild(row);
  }
  const empty = planIsEmpty(plan);
  $('share-confirm').hidden = empty;
  $('share-confirm').textContent = 'Add these to my hangar';
  $('share-cancel').textContent = empty ? 'Close' : 'Cancel';
  $('share-diff').hidden = false;
}

async function onFile(e) {
  const input = e.target;
  const file = input.files?.[0];
  clearPlan();
  setNote('');
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    setNote(`That file couldn’t be read (${err.message}).`, true);
    return;
  } finally {
    // Clearing the input is what makes picking the *same* file again fire another
    // change event — and importing one file twice is exactly how a pilot checks
    // that it renames rather than overwrites.
    input.value = '';
  }
  const got = readPayload(text);
  if (!got.ok) {
    setNote(got.error, true);
    return;
  }
  const plan = planImport(got.payload);
  pending = plan;
  renderDiff(plan);
  if (planIsEmpty(plan)) {
    pending = null;
    setNote('Nothing in that file could be added — see the reasons above. Your hangar is unchanged.', true);
  }
}

function onConfirm() {
  if (!pending) return;
  const counts = applyPlan(pending);
  const renamed = ['drones', 'batteries', 'manufacturers', 'logs']
    .flatMap(k => pending[k].kept.filter(x => x.renamed));
  clearPlan();
  setNote(`Added ${countSentence(counts)}.`
    + (renamed.length ? ` ${plural(renamed.length, 'record', 'records')} came in under a new id — `
      + 'nothing of yours was replaced.' : '')
    + ' Pick it in Aircraft above.');
  deps.populateControls();
  deps.update();
}

function onCancel() {
  const had = !!pending;
  clearPlan();
  setNote(had ? 'Nothing was imported — your hangar is unchanged.' : '');
}

/** Bound once at boot, from app.js's bind(). */
export function bindShare() {
  $('share-export').addEventListener('click', onExport);
  $('share-file').addEventListener('change', onFile);
  $('share-confirm').addEventListener('click', onConfirm);
  $('share-cancel').addEventListener('click', onCancel);
}
