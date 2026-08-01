// components/readiness.js — the O-03 offline-readiness rows (design evolution
// M13): what still works when the launch spot has no coverage, one honest row
// per store. This is the H-03 cache surface too, folded in: the same rows
// distinguish current, cached, stale and unavailable data, because for this
// app "the field region" IS these stores — the app shell, the mission's saved
// terrain, the last weather fetch and the mission documents. The one thing
// the app never stores is basemap imagery, and the tiles row says exactly
// that rather than letting the card imply a downloaded map.
//
// Pure on purpose: every input is gathered by the caller
// (src/render/field.js), so node tests can exercise the wording without a
// browser. Never color alone — each row's title carries its state in words.

/** @typedef {'ok'|'cached'|'warn'|'bad'|'info'} ReadinessState */
/**
 * @typedef {object} ReadinessRow
 * @property {string} key
 * @property {ReadinessState} state
 * @property {string} title
 * @property {string} body
 */

/**
 * @typedef {object} ReadinessInputs
 * @property {boolean|null} onLine  navigator.onLine, or null when the browser
 *   has no opinion. true is a weak promise (a router with no uplink still
 *   reads true) and the wording stays modest about it; false is definitive.
 * @property {'controlled'|'pending'|'unsupported'} sw  whether a service
 *   worker is serving this page, is still installing, or never will
 * @property {import('./data-freshness.js').FreshnessModel} weather
 * @property {{savedAt: string}|null|'no-mission'|'pending'} evidence  the
 *   evidence store's answer for the open mission (analysis-host.js);
 *   'pending' while the async read is in flight
 * @property {import('../mission-bridge.js').MissionStorageState} storage
 * @property {{usage: number, quota: number}|null} estimate
 *   navigator.storage.estimate(), or null when the browser cannot answer —
 *   no claim, not a guess (the mission-bridge rule, ADR 0012 §5)
 */

/** '840 kB' / '12 MB' / '1.2 GB' — coarse: the row answers "is there room".
 * @param {number} n @returns {string|null} */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1e6) return `${Math.round(n / 1e3)} kB`;
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** Age wording that matches the DataFreshness chip's coarseness.
 * @param {string} iso @param {number} nowMs @returns {string|null} */
function ago(iso, nowMs) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const min = Math.max(0, (nowMs - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} d ago`;
}

/** @param {ReadinessInputs} inputs @param {number} [nowMs] @returns {ReadinessRow[]} */
export function readinessRows(inputs, nowMs = Date.now()) {
  /** @type {ReadinessRow[]} */
  const rows = [];

  rows.push(inputs.onLine === false ? {
    key: 'signal', state: 'cached', title: 'Offline',
    body: 'No connection — flying on what is already on this device, listed below.',
  } : inputs.onLine === true ? {
    key: 'signal', state: 'ok', title: 'Online',
    body: 'The browser reports a connection — refresh anything stale before you head out.',
  } : {
    key: 'signal', state: 'info', title: 'Coverage unknown',
    body: 'This browser does not report its connection state.',
  });

  rows.push(inputs.sw === 'controlled' ? {
    key: 'app', state: 'ok', title: 'App cached on this device',
    body: 'Opens and computes with zero signal — every number is solved on the device.',
  } : inputs.sw === 'pending' ? {
    key: 'app', state: 'warn', title: 'App cache still installing',
    body: 'First visit — reload once while online and the app opens offline after that.',
  } : {
    key: 'app', state: 'bad', title: 'App not cached',
    body: 'This browser will not store the app, so it needs coverage to open at all.',
  });

  const w = inputs.weather;
  const wAge = w.at ? ago(w.at, nowMs) : null;
  rows.push(w.state === 'cached' ? {
    key: 'weather', state: 'cached', title: 'Weather from the last fetch',
    body: `${w.source} · fetched ${wAge ?? 'earlier'} — it cannot refresh without coverage.`,
  } : w.state === 'stale' ? {
    key: 'weather', state: 'warn', title: 'Weather stale',
    body: `${w.source} · ${wAge ?? 'old'} — old enough that the sky may have moved on.`,
  } : w.state === 'unavailable' ? {
    key: 'weather', state: 'bad', title: 'No weather fetched',
    body: 'Nothing has landed yet — a preset or hand-entered conditions work offline.',
  } : {
    key: 'weather', state: 'ok', title: 'Weather current',
    body: w.at
      ? `${w.source} · ${wAge} — refetches while you have signal.`
      : `${w.source} — travels with the app and works offline.`,
  });

  const ev = inputs.evidence;
  rows.push(ev === 'no-mission' ? {
    key: 'terrain', state: 'info', title: 'Terrain — no mission open',
    body: 'Ground is saved per mission when the Plan map fetches it.',
  } : ev === 'pending' ? {
    key: 'terrain', state: 'info', title: 'Terrain — checking…',
    body: 'Asking this device what it remembers for the open mission.',
  } : ev ? {
    key: 'terrain', state: 'ok', title: 'Terrain saved with the mission',
    body: `Sampled ${ago(ev.savedAt, nowMs) ?? 'earlier'} — the ground survives reloads with no signal.`,
  } : {
    key: 'terrain', state: 'warn', title: 'Terrain not saved yet',
    body: 'Open the Plan map while online and this device keeps the ground for the trip.',
  });

  const st = inputs.storage;
  const est = inputs.estimate;
  const room = est ? ` Using ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}.` : '';
  rows.push(!st.durable ? {
    key: 'missions', state: 'bad', title: 'Missions in memory only',
    body: 'This browser keeps missions for this tab alone — export anything you cannot lose.',
  } : st.nearFull ? {
    key: 'missions', state: 'warn', title: 'Mission storage nearly full',
    body: `Saves may start failing soon — export what you need to keep.${room}`,
  } : {
    key: 'missions', state: 'ok', title: 'Missions saved on this device',
    body: (st.persisted === false
      ? 'On disk, though the browser may evict them if space runs short — export the critical ones.'
      : 'On disk and durable across reloads.') + room,
  });

  rows.push({
    key: 'tiles', state: 'info', title: 'Map imagery — never stored',
    body: 'The basemap needs coverage. Your verdict, numbers and clock do not.',
  });

  return rows;
}

/**
 * @param {HTMLElement} host
 * @param {ReadinessRow[]} rows
 */
export function renderReadiness(host, rows) {
  const list = document.createElement('ul');
  list.className = 'rdy-rows';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'rdy-row';
    li.dataset.state = row.state;
    const dot = document.createElement('span');
    dot.className = 'rdy-dot';
    const text = document.createElement('div');
    text.className = 'rdy-text';
    const title = document.createElement('p');
    title.className = 'rdy-title';
    title.textContent = row.title;
    const body = document.createElement('p');
    body.className = 'rdy-body';
    body.textContent = row.body;
    text.append(title, body);
    li.append(dot, text);
    list.appendChild(li);
  }
  host.replaceChildren(list);
}
