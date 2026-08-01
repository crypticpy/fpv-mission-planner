// render/onboarding.js — the first-run tour (O-01 welcome chooser + O-02
// location step, design evolution M13). An overlay above the already-booted
// app, shown once: every door only navigates and closes, so nothing a
// returning pilot needs lives in here. First run means no saved session and
// no completed tour — a pilot upgrading from any earlier build has a session
// and never sees it.
import { icon } from '../components/icons.js';
import { renderSystemState } from '../components/system-state.js';
import { $ } from './dom.js';
import { get as storeGet, set as storeSet } from '../store.js';
import { useMyLocation } from './live.js';

let target = 'plan'; // the destination the chosen door leads to
let setDest = null;
let done = false;

/** Close for good: the tour never shows twice, whatever exit was taken. The
 *  done latch also swallows a geolocation answer that lands after the pilot
 *  already pressed Not now — a late fix must not yank them to another screen. */
function finish(dest) {
  if (done) return;
  done = true;
  storeSet('onboarded', true);
  $('onboard').hidden = true;
  document.removeEventListener('keydown', onKey);
  setDest?.(dest);
}

function onKey(e) {
  if (e.key === 'Escape') finish('plan');
}

function toLocation(t) {
  target = t;
  $('onboard-welcome').hidden = true;
  $('onboard-location').hidden = false;
}

function locate() {
  renderSystemState($('onboard-geo'), {
    kind: 'loading',
    title: 'Getting your location…',
    body: 'The browser will ask for permission first.',
  });
  useMyLocation((err) => {
    if (!err) {
      finish(target);
      return;
    }
    // The rail shows the same sentence; here it must not strand the pilot —
    // both buttons below stay live for a retry or a Not now.
    renderSystemState($('onboard-geo'), { kind: 'permission-denied', title: 'No location', body: err });
  });
}

/**
 * Bind and show the tour when this boot is a first run; otherwise do nothing.
 * Called after the boot renders, so every door lands on a live destination.
 * @param {{setDest: (dest: string) => void}} deps
 */
export function setupOnboarding(deps) {
  if (storeGet('session', null) != null || storeGet('onboarded', false)) return;
  setDest = deps.setDest;
  const doors = [
    ['onboard-field', 'shield-check', () => toLocation('field')],
    ['onboard-plan', 'waypoint', () => toLocation('plan')],
    ['onboard-library', 'layers', () => finish('library')],
  ];
  for (const [id, sym, go] of doors) {
    const door = $(id);
    door.prepend(icon(sym, 'onboard-glyph'));
    door.addEventListener('click', go);
  }
  for (const li of document.querySelectorAll('#onboard .onboard-why li')) {
    li.prepend(icon(li.dataset.sym, 'onboard-why-glyph'));
  }
  $('onboard-dismiss').addEventListener('click', () => finish('plan'));
  $('onboard-locate').addEventListener('click', locate);
  $('onboard-later').addEventListener('click', () => finish(target));
  document.addEventListener('keydown', onKey);
  const overlay = $('onboard');
  overlay.hidden = false;
  overlay.querySelector('.onboard-card').focus();
}
