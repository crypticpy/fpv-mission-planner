/* Mobile app shell — bottom dock plus the control rail as a bottom sheet.
   All layout lives in CSS; this only toggles classes, attributes, and focus.
   The dialog role is applied only while the sheet is open: on desktop the
   same element is a permanent sidebar, where that role would be wrong. */

const $ = (id) => document.getElementById(id);

const mobileLayout = window.matchMedia('(max-width: 900px)');

let sheetOpen = false;
let savedScrollY = 0;

function inertTargets() {
  return [
    document.querySelector('.masthead'),
    document.querySelector('.view-tabs'),
    $('view-dash'),
    $('view-map'),
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
  // Non-modal dialog: the dock stays operable (it holds the close toggle),
  // so aria-modal would wrongly hide it from assistive tech.
  rail.setAttribute('role', 'dialog');
  $('dock-loadout').setAttribute('aria-expanded', 'true');
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
  $('dock-loadout').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('dock-loadout').focus();
}

export function syncView(view) {
  $('dock-planner').setAttribute('aria-current', view === 'dash' ? 'true' : 'false');
  $('dock-map').setAttribute('aria-current', view === 'map' ? 'true' : 'false');
}

export function setupShell({ setView }) {
  $('dock-planner').addEventListener('click', () => { closeSheet(); setView('dash'); });
  $('dock-map').addEventListener('click', () => { closeSheet(); setView('map'); });
  $('dock-loadout').addEventListener('click', () => (sheetOpen ? closeSheet() : openSheet()));
  $('sheet-scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen) closeSheet();
  });
  // Leaving the mobile layout must never strand the body scroll lock.
  mobileLayout.addEventListener('change', (e) => {
    if (!e.matches) closeSheet();
  });
}
