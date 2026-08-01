// render/field.js — the F-01 Field Mode home (design evolution M13): the
// verdict writ large, the flight clock against the turn-home mark, and the
// way back to the map. Everything here is presentation over the same analysis
// the Plan dashboard draws — verdict(), legTimes() and the plan's own numbers
// — so Field can never tell the pilot a different mission than Plan does. The
// clock is the one thing Field owns: a persisted wall-clock start
// (src/field-timer.js), mirroring the OSD timer the brief's turn-around
// headline already talks about.
import { icon } from '../components/icons.js';
import { units } from '../state.js';
import { $ } from './dom.js';
import { f1, mmss } from './format.js';
import { verdict, strandedFrom, legTimes } from './dashboard.js';
import { missionTitle, missionDocument, missionStorage } from '../mission-bridge.js';
import { applyTheme, currentTheme } from '../themes.js';
import { get as storeGet, set as storeSet } from '../store.js';
import { startTimer, resetTimer, elapsedMin } from '../field-timer.js';
import { freshnessModelFrom } from '../components/data-freshness.js';
import { readinessRows, renderReadiness } from '../components/readiness.js';
import { evidenceStatus } from '../analysis-host.js';

// Same glyph per level as the Plan card (components/verdict-card.js) — the
// two surfaces must read as one verdict, only set at different scales.
const LEVEL_ICON = {
  go: 'shield-check', caution: 'bailout', nogo: 'octagon-x', unknown: 'circle-question',
};

// The marks the Timer tile counts against, refreshed by every render so a
// slider moved over in Plan retunes the clock's coloring here. Null when no
// leg closes and the clock has nothing to count against.
let turnAtMin = null;
let planAtMin = null;
let tickHandle = null;

/** Build the home card's skeleton once; renders only retext it. Field gets
 *  its own ids and a data-level attribute rather than reusing the VerdictCard
 *  component: its child ids (#verdict-badge …) are a browser-spec contract
 *  and can only exist once in the document — Plan owns them. */
function ensure(host) {
  if (host.firstChild) return;
  const title = document.createElement('p');
  title.id = 'field-mission-title';
  title.className = 'fhome-mission';

  const card = document.createElement('div');
  card.id = 'field-verdict';
  card.className = 'fhome-verdict';
  const glyph = document.createElement('span');
  glyph.className = 'fhome-verdict-icon';
  const text = document.createElement('div');
  text.className = 'fhome-verdict-text';
  const label = document.createElement('p');
  label.id = 'field-verdict-label';
  label.className = 'fhome-verdict-label';
  const why = document.createElement('p');
  why.id = 'field-verdict-why';
  why.className = 'fhome-verdict-why';
  const fix = document.createElement('p');
  fix.id = 'field-verdict-fix';
  fix.className = 'fhome-verdict-fix';
  text.append(label, why, fix);
  card.append(glyph, text);

  const tiles = document.createElement('div');
  tiles.className = 'fhome-tiles';
  const tile = (labelText, valueId) => {
    const cell = document.createElement('div');
    cell.className = 'fhome-tile';
    const l = document.createElement('p');
    l.className = 'fhome-tile-label';
    l.textContent = labelText;
    const v = document.createElement('p');
    v.id = valueId;
    v.className = 'fhome-tile-value';
    v.textContent = '—';
    cell.append(l, v);
    return cell;
  };
  const timerTile = tile('Timer', 'field-timer');
  timerTile.dataset.state = 'idle';
  const timerBtn = document.createElement('button');
  timerBtn.id = 'btn-field-timer';
  timerBtn.className = 'map-btn fhome-timer-btn';
  timerBtn.type = 'button';
  timerBtn.textContent = 'Start';
  timerTile.append(timerBtn);
  tiles.append(tile('Radius', 'field-radius'), timerTile, tile('Turn home', 'field-turnhome'));

  const actions = document.createElement('div');
  actions.className = 'fhome-actions';
  const mapBtn = document.createElement('button');
  mapBtn.id = 'btn-field-map';
  mapBtn.className = 'map-btn fhome-open';
  mapBtn.type = 'button';
  mapBtn.textContent = 'Open map';
  const briefBtn = document.createElement('button');
  briefBtn.id = 'btn-field-brief';
  briefBtn.className = 'map-btn';
  briefBtn.type = 'button';
  briefBtn.textContent = 'Mission brief';
  actions.append(mapBtn, briefBtn);

  host.append(title, card, tiles, actions);
}

/** The clock tile, redrawn every second while running. The tile's label and
 *  state move together past each mark — text with the color, never color
 *  alone (the round-2 accessibility rule). */
function drawTimer() {
  const value = $('field-timer');
  if (!value) return;
  const elapsed = elapsedMin();
  const running = elapsed != null;
  const tile = value.closest('.fhome-tile');
  const state = !running ? 'idle'
    : planAtMin != null && elapsed >= planAtMin ? 'over'
      : turnAtMin != null && elapsed >= turnAtMin ? 'turn'
        : 'run';
  value.textContent = mmss(elapsed ?? 0);
  tile.dataset.state = state;
  tile.querySelector('.fhome-tile-label').textContent =
    state === 'turn' ? 'Timer — turn now'
      : state === 'over' ? 'Timer — past plan'
        : 'Timer';
  $('btn-field-timer').textContent = running ? 'Reset' : 'Start';
  if (running && tickHandle == null) tickHandle = setInterval(drawTimer, 1000);
  if (!running && tickHandle != null) { clearInterval(tickHandle); tickHandle = null; }
}

function syncSunlight() {
  $('btn-sunlight')?.setAttribute('aria-pressed', String(currentTheme().preference === 'sun-glare'));
}

/* ---------- O-03 offline readiness (design evolution M13) ---------- */

/** Stale-patch guard: only the newest render's async reads may retext rows. */
let rdySeq = 0;

/** navigator.storage.estimate(), or null when the browser cannot answer — no
 *  claim, not a guess (the mission-bridge rule, ADR 0012 §5).
 *  @returns {Promise<{usage: number, quota: number}|null>} */
async function storageEstimate() {
  const sm = globalThis.navigator?.storage;
  if (!sm || typeof sm.estimate !== 'function') return null;
  try {
    const { usage = NaN, quota = NaN } = await sm.estimate();
    return Number.isFinite(usage) && Number.isFinite(quota) && quota > 0
      ? { usage, quota } : null;
  } catch {
    return null;
  }
}

/**
 * The readiness card: a synchronous render of what is known now, then one
 * re-render when the two async answers (evidence store, storage estimate)
 * land. Plan-independent like the wind ribbon — coverage and caches are real
 * whether or not a pack fits — so app.js calls this ahead of the no-plan bail.
 * @param {any} snapshot
 */
export function renderFieldReadiness(snapshot) {
  const host = $('field-readiness');
  if (!host) return;
  const seq = ++rdySeq;
  const nav = globalThis.navigator;
  /** @type {import('../components/readiness.js').ReadinessInputs} */
  const inputs = {
    onLine: typeof nav?.onLine === 'boolean' ? nav.onLine : null,
    sw: !nav?.serviceWorker ? 'unsupported'
      : nav.serviceWorker.controller ? 'controlled' : 'pending',
    weather: freshnessModelFrom(snapshot),
    evidence: missionDocument() ? 'pending' : 'no-mission',
    storage: missionStorage(),
    estimate: null,
  };
  renderReadiness(host, readinessRows(inputs));
  void (async () => {
    const [ev, estimate] = await Promise.all([
      inputs.evidence === 'pending' ? evidenceStatus() : Promise.resolve(inputs.evidence),
      storageEstimate(),
    ]);
    if (seq !== rdySeq) return; // a newer render owns the card now
    renderReadiness(host, readinessRows({ ...inputs, evidence: ev, estimate }));
  })();
}

/** The H-03 update check: ask the service worker to look for a newer build
 *  now, and say what happened. sw.js takes over with skipWaiting() once an
 *  update installs, so the shell's update notice handles the reload offer —
 *  this note only reports the check itself. */
async function checkForUpdates() {
  const note = $('rdy-update-note');
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw) {
    note.textContent = 'This browser cannot update the app in the background.';
    return;
  }
  note.textContent = 'Checking…';
  try {
    const reg = await sw.getRegistration();
    if (!reg) {
      note.textContent = 'The app shell has not installed yet — reload once while online.';
      return;
    }
    await reg.update();
    note.textContent = reg.installing || reg.waiting
      ? 'Update found — installing. A reload notice will appear when it is ready.'
      : 'You are on the newest build.';
  } catch {
    note.textContent = 'Could not reach the server — try again with coverage.';
  }
}

/**
 * Bind the home card's controls once at boot. The two buttons lead out of
 * Field — to the Plan map and to the same brief Review opens — so both
 * arrive as callbacks; Field owns no navigation of its own. requestRender
 * re-runs the analysis pass so a coverage change moves every freshness
 * surface at once — the readiness rows and the ribbon's chip cannot disagree.
 * @param {{openPlan: () => void, openBrief: () => void, requestRender: () => void}} deps
 */
export function setupField({ openPlan, openBrief, requestRender }) {
  $('btn-rdy-update').addEventListener('click', () => { void checkForUpdates(); });
  // The first online/offline listeners in the app (M13): coverage moving is
  // exactly what this destination exists to be honest about.
  for (const ev of ['online', 'offline']) {
    window.addEventListener(ev, requestRender);
  }
  ensure($('field-home'));
  $('btn-field-map').addEventListener('click', openPlan);
  $('btn-field-brief').addEventListener('click', openBrief);
  $('btn-field-timer').addEventListener('click', () => {
    if (elapsedMin() != null) resetTimer();
    else startTimer();
    drawTimer();
  });
  // The sunlight latch: one press to the sun-glare theme — the max-contrast
  // preset built for direct sun — and one press back to whatever the pilot
  // had. Pressed means forced: in auto mode on a bright day the theme may
  // already resolve to sun-glare, and the latch still honestly reads off.
  const sun = $('btn-sunlight');
  sun.prepend(icon('sun', 'sun-glyph'));
  sun.addEventListener('click', () => {
    const { preference } = currentTheme();
    if (preference === 'sun-glare') applyTheme(storeGet('sunlightPrev', 'auto'));
    else {
      storeSet('sunlightPrev', preference);
      applyTheme('sun-glare');
    }
    syncSunlight();
  });
  syncSunlight();
  drawTimer(); // a clock left running survives the reload and resumes ticking here
}

/**
 * One render of the home card off the snapshot the pass already computed.
 * Only called with a plan in hand — the no-pack state blanks every Field card
 * and says why through #field-empty instead.
 * @param {any} snapshot
 */
export function renderFieldHome(snapshot) {
  const host = $('field-home');
  ensure(host);
  const r = snapshot.plan;
  const v = verdict(r, strandedFrom(snapshot));
  const card = $('field-verdict');
  card.dataset.level = v.level;
  card.querySelector('.fhome-verdict-icon')
    .replaceChildren(icon(LEVEL_ICON[v.level] ?? 'circle-question', 'fhome-glyph'));
  $('field-verdict-label').textContent = v.label;
  $('field-verdict-why').textContent = v.why;
  const fix = $('field-verdict-fix');
  fix.textContent = v.fix || '';
  fix.hidden = !v.fix;
  $('field-mission-title').textContent = missionTitle().trim() || 'Untitled mission';

  const u = units();
  const flies = r.flight.code !== 'no_lift' && r.radiusKm > 0;
  const times = flies ? legTimes(r) : null;
  $('field-radius').textContent =
    flies ? `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit}` : '—';
  $('field-turnhome').textContent = times ? mmss(times.outMin) : '—';
  turnAtMin = times ? times.outMin : null;
  planAtMin = flies ? r.timeMin : null;
  syncSunlight();
  drawTimer();
}
