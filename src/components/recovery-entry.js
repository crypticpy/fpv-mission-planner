// components/recovery-entry.js — the RecoveryEntry of the round-2 design
// system: one row of the Library's history-and-recovery list — a manual save,
// an autosave, a restore, an import, or a record quarantined at load. Pure DOM
// over a model, the same contract verdict-card.js draws under: the caller
// decides what the entry says and what its buttons do; this module only draws
// it, which is what lets the version timeline and the quarantine list share
// one shape instead of growing two.

/** The badge word for each kind — always a word, never colour alone. */
const KIND_BADGE = Object.freeze({
  manual: 'MANUAL SAVE',
  auto: 'AUTOSAVE',
  restore: 'RESTORED',
  import: 'IMPORTED',
  quarantine: 'QUARANTINED',
});

/**
 * @typedef {object} RecoveryAction
 * @property {string} label
 * @property {() => void} act
 * @property {boolean} [primary]  drawn as a solid button rather than a link
 */

/**
 * @typedef {object} RecoveryEntryModel
 * @property {'manual'|'auto'|'restore'|'import'|'quarantine'} kind
 * @property {boolean} [current]  the newest checkpoint — gains a CURRENT badge
 * @property {string} name        "v8", or the quarantined record's id line
 * @property {string} meta        age and size — one muted line
 * @property {RecoveryAction[]} actions
 */

/**
 * @param {RecoveryEntryModel} model
 * @returns {HTMLElement}
 */
export function recoveryEntry(model) {
  const row = document.createElement('div');
  row.className = 'spot-row recovery-entry';
  row.dataset.kind = model.kind;
  if (model.current) row.setAttribute('aria-current', 'true');

  const text = document.createElement('div');
  text.className = 'spot-text';
  const head = document.createElement('span');
  head.className = 'recovery-head';
  if (model.current) {
    const cur = document.createElement('span');
    cur.className = 'recovery-badge recovery-badge-current';
    cur.textContent = 'CURRENT';
    head.appendChild(cur);
  }
  const name = document.createElement('span');
  name.className = 'spot-name';
  name.textContent = model.name;
  const badge = document.createElement('span');
  badge.className = 'recovery-badge';
  badge.textContent = KIND_BADGE[model.kind] ?? String(model.kind).toUpperCase();
  head.append(name, badge);
  const meta = document.createElement('span');
  meta.className = 'spot-meta';
  meta.textContent = model.meta;
  text.append(head, meta);

  const actions = document.createElement('div');
  actions.className = 'spot-actions';
  for (const a of model.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = a.primary ? 'map-btn' : 'link-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', () => { a.act(); });
    actions.appendChild(btn);
  }

  row.append(text, actions);
  return row;
}
