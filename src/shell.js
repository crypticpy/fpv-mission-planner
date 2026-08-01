/* App shell — the four-destination nav (Field / Plan / Library / Aircraft)
   plus Plan's conditions rail as a mobile bottom sheet. One nav element, two
   postures, both drawn by CSS: a left icon rail on wide screens, the bottom
   dock on phones. This only toggles classes, attributes, and focus.
   The dialog role is applied to the rail only while the sheet is open: on
   desktop the same element is a permanent sidebar, where that role would be
   wrong. */

const $ = (id) => document.getElementById(id);

const mobileLayout = window.matchMedia('(max-width: 900px)');

const DESTS = ['field', 'plan', 'library', 'aircraft'];

let sheetOpen = false;
let savedScrollY = 0;

/* Everything under Plan except the tab row: the row holds the sheet's own
   toggle, which must stay operable while the sheet is open — as must the
   destnav, whose buttons close the sheet before they navigate. The other
   three destinations are [hidden] whenever the sheet can be open (it only
   exists inside Plan), so they are already out of reach. */
function inertTargets() {
  return [
    document.querySelector('.masthead'),
    $('verdict'),
    $('warnings'),
    $('view-map'),
    $('view-analyze'),
    $('view-review'),
  ].filter(Boolean);
}

function openSheet() {
  if (sheetOpen || !mobileLayout.matches) return;
  sheetOpen = true;
  const rail = $('rail');
  savedScrollY = window.scrollY;
  document.body.style.top = `-${savedScrollY}px`;
  document.body.classList.add('sheet-open');
  for (const el of inertTargets()) el.inert = true;
  // Non-modal dialog: the destnav and the toggle stay operable, so aria-modal
  // would wrongly hide them from assistive tech.
  rail.setAttribute('role', 'dialog');
  $('btn-plan-controls').setAttribute('aria-expanded', 'true');
  rail.focus({ preventScroll: true });
}

function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  const rail = $('rail');
  const returnFocus = rail.contains(document.activeElement);
  document.body.classList.remove('sheet-open');
  document.body.style.top = '';
  window.scrollTo(0, savedScrollY);
  for (const el of inertTargets()) el.inert = false;
  rail.removeAttribute('role');
  $('btn-plan-controls').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('btn-plan-controls').focus();
}

/** Bring the conditions rail on screen: opens the bottom sheet on the mobile
 *  layout, a no-op on desktop where the rail is a permanent sidebar. For the
 *  Review fix links, which land on a rail control and need it visible first. */
export function revealRail() {
  openSheet();
}

/** Mark the open destination on the nav. aria-current="page" doubles as the
 *  CSS hook for the active state in both postures. */
export function syncDest(dest) {
  for (const d of DESTS) {
    const btn = $(`nav-${d}`);
    if (d === dest) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}

export function setupShell({ setDest }) {
  for (const d of DESTS) {
    $(`nav-${d}`).addEventListener('click', () => { closeSheet(); setDest(d); });
  }
  $('btn-plan-controls').addEventListener('click', () => (sheetOpen ? closeSheet() : openSheet()));
  $('sheet-scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen) closeSheet();
  });
  // Leaving the mobile layout must never strand the body scroll lock.
  mobileLayout.addEventListener('change', (e) => {
    if (!e.matches) closeSheet();
  });
}
