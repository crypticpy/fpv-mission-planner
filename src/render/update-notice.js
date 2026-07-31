// render/update-notice.js — the app-shell update notice (ADR 0012 §4).
//
// sw.js takes over with skipWaiting()/clients.claim() the instant a new build
// finishes installing, so the very next fetch this tab makes is already
// served by different code with nothing on screen having said so. A silent
// swap is indistinguishable from a stale tab until something the old build
// couldn't do is asked of it. `controllerchange` is the one event a page can
// hear that handoff on, and this module's whole job is to turn it into a
// notice the pilot can act on or ignore — never a reload forced on them
// mid-plan, which is exactly the kind of surprise ADR 0012 §4 rules out.
//
// The same event also fires once, harmlessly, the first time a page is ever
// controlled at all — an install with no previous build to have updated
// *from*. Reporting that as "updated" would greet every new pilot with a
// stale-app warning about an app they just opened for the first time, so
// setupUpdateNotice() has to tell the two apart: only a controllerchange that
// lands after the page already had a controller, or a second one after the
// first has already been let through silently, is a real update.

import { $ } from './dom.js';

function buildNotice(host) {
  host.replaceChildren();

  const text = document.createElement('p');
  text.className = 'update-notice-text';
  text.textContent = 'The planner updated in the background — reload to run the newest build.';

  const actions = document.createElement('div');
  actions.className = 'update-notice-actions';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'map-btn';
  reload.textContent = 'Reload';
  // No auto-reload, ever (ADR 0012 §4): the pilot may be mid-plan or mid-flight
  // and the new build is already running for everyone regardless of when this
  // tab catches up to it.
  reload.addEventListener('click', () => window.location.reload());

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'link-btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { host.hidden = true; });

  actions.append(reload, dismiss);
  host.append(text, actions);
}

/**
 * Wire the controllerchange listener. Zero-argument: the notice owns only its
 * own DOM and a full page reload, so app.js has nothing to inject — unlike
 * every other render/*.js `setup*` this rides in the entry bundle rather than
 * a lazy chunk, so it stays deliberately tiny.
 */
export function setupUpdateNotice() {
  const sw = navigator.serviceWorker;
  if (!sw) return; // no service worker support: nothing can ever take over
  const host = $('update-notice');
  // Captured once, before the first event can arrive: true only when this
  // script itself was already served by a controller, meaning any change from
  // here is necessarily a *second* one taking over.
  let firstHandoffPending = !sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (firstHandoffPending) { firstHandoffPending = false; return; }
    buildNotice(host);
    host.hidden = false;
  });
}
