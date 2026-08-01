// render/camerapage.js — the Camera page of the Aircraft destination (E-03).
//
// The select is the same seam as Plan's segment editor: both write the
// mission's one `scene.cameraProfile` through the setCameraProfile command, so
// whichever door picked the camera, the shot solver and the framing preview
// here read the same profile. Everything drawn below the select comes from
// domain/camera.js — fovDeg() for the wedge and the tiles, subjectFraming()
// for the sentence — so the preview cannot disagree with what the Plan
// destination's shot checks compute.
//
// The two sliders are view state, not mission state: "how big is my subject
// and how far back am I" is a question the pilot is asking the camera, not a
// fact about the mission, so it deliberately lives here and is not saved.
import { CAMERAS } from '../catalog/cameras.js';
import { fovDeg, subjectFraming } from '../domain/camera.js';
import { missionDocument, dispatch } from '../mission-bridge.js';
import { f0, f1 } from './format.js';
import { $, fillSelect } from './dom.js';

// Slider ranges, in meters. 200 m is also the preview's full width, so the
// subject dot always lands inside the drawing.
const DIST_MAX_M = 200;

let distM = 30;
let sizeM = 5;

export function setupCameraPage() {
  $('sel-camera').addEventListener('change', () => {
    const value = /** @type {HTMLSelectElement} */ ($('sel-camera')).value;
    if (value === '') { dispatch({ type: 'setCameraProfile', payload: { profile: null } }); return; }
    const preset = CAMERAS.find((c) => c.id === value);
    if (!preset) return;
    /* The catalog `id` is a selection key, not part of the profile shape — and
     * checkCameraProfile rejects a bag carrying a key the shape does not name,
     * so it has to come off before the command goes anywhere. */
    const { id: _catalogId, ...profile } = preset;
    dispatch({ type: 'setCameraProfile', payload: { profile } });
  });
  $('in-cam-dist').addEventListener('input', () => {
    distM = Number($('in-cam-dist').value);
    renderCameraPage();
  });
  $('in-cam-size').addEventListener('input', () => {
    sizeM = Number($('in-cam-size').value);
    renderCameraPage();
  });
}

export function renderCameraPage() {
  const profile = missionDocument()?.scene?.cameraProfile ?? null;
  fillSelect($('sel-camera'),
    [{ value: '', label: '— none —' }, ...CAMERAS.map((c) => ({ value: c.id, label: c.name }))],
    CAMERAS.find((c) => c.name === profile?.name)?.id ?? '');

  const fov = fovDeg(profile);
  const body = $('cam-body');
  const empty = $('cam-empty');
  body.hidden = !fov;
  empty.hidden = !!fov;
  if (!fov) return;

  tile('tile-cam-sensor', `${f1(profile.sensorWidthMm)} × ${f1(profile.sensorHeightMm)} mm`, 'width × height');
  tile('tile-cam-focal', `${f1(profile.focalLengthMm)} mm`, 'actual, not equivalent');
  tile('tile-cam-fov', `${f0(fov.hDeg)}° × ${f0(fov.vDeg)}°`, 'horizontal × vertical');
  tile('tile-cam-stab', profile.stabilized ? 'Yes' : 'No',
    profile.stabilized ? 'in-camera' : 'plan smoother lines');

  $('cam-dist-val').textContent = `${f0(distM)} m`;
  $('cam-size-val').textContent = `${f0(sizeM)} m`;
  /** @type {HTMLInputElement} */ ($('in-cam-dist')).value = String(distM);
  /** @type {HTMLInputElement} */ ($('in-cam-size')).value = String(sizeM);

  drawPreview(fov);
  $('cam-framing').textContent = framingSentence(fov);
}

function tile(id, value, sub) {
  $(id).querySelector('.tile-value').textContent = value;
  $(id).querySelector('.tile-sub').textContent = sub;
}

function framingSentence(fov) {
  const frac = subjectFraming(distM, sizeM / 2, fov);
  if (frac == null) return '';
  if (frac >= 1) {
    return `A ${f0(sizeM)} m subject at ${f0(distM)} m — the camera is inside the subject's own radius,`
      + ' so the frame is all subject.';
  }
  const pct = frac * 100;
  const filled = `A ${f0(sizeM)} m subject at ${f0(distM)} m fills about ${pct < 10 ? f1(pct) : f0(pct)}%`
    + ' of the frame width';
  if (pct >= 50) return `${filled} — a tight full-frame shot; small position errors will crop it.`;
  if (pct < 2) return `${filled} — a speck. Get closer or pick a longer lens.`;
  return `${filled}.`;
}

/* ---------- the top-down wedge ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Top-down: camera on the left looking right, the horizontal field of view as
 * a wedge, the subject as a dot at the slider distance. One fixed scale —
 * full width is DIST_MAX_M — so the dot and the wedge stay comparable while
 * the sliders move. Ultra-wide wedges run off the top and bottom edges, which
 * is the honest drawing of a lens that sees more than the pane shows.
 */
function drawPreview(fov) {
  const host = $('cam-preview');
  const w = Math.max(280, host.clientWidth || 0);
  const h = 190;
  const camX = 16;
  const midY = h / 2 - 8;
  const pxPerM = (w - camX - 10) / DIST_MAX_M;
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
  svg.setAttribute('aria-label',
    `Top-down field-of-view preview: a ${f0(fov.hDeg)}-degree wedge with the subject at ${f0(distM)} m`);

  // Distance ticks along the sightline, before the wedge so they read as floor.
  for (const m of [50, 100, 150, 200]) {
    const x = camX + m * pxPerM;
    svg.appendChild(el('line', {
      x1: x, y1: midY - 4, x2: x, y2: midY + 4,
      stroke: 'var(--border)', 'stroke-width': 1,
    }));
    const label = el('text', { x, y: h - 6, 'text-anchor': 'middle' });
    label.textContent = `${m} m`;
    svg.appendChild(label);
  }

  // The wedge. tan() is capped so a near-180° lens still yields sane
  // coordinates — the rays leave the pane either way.
  const half = (fov.hDeg / 2) * (Math.PI / 180);
  const spread = Math.min(Math.tan(half), 20) * (w - camX);
  svg.appendChild(el('path', {
    d: `M ${camX} ${midY} L ${w} ${midY - spread} L ${w} ${midY + spread} Z`,
    fill: 'var(--accent)', 'fill-opacity': 0.08,
    stroke: 'var(--accent)', 'stroke-opacity': 0.55, 'stroke-width': 1.5,
    'stroke-linejoin': 'round',
  }));
  svg.appendChild(el('line', {
    x1: camX, y1: midY, x2: w, y2: midY,
    stroke: 'var(--border)', 'stroke-width': 1, 'stroke-dasharray': '3 5',
  }));

  // The camera, then the subject at its slider distance and true scale.
  svg.appendChild(el('circle', { cx: camX, cy: midY, r: 3.5, fill: 'var(--accent)' }));
  svg.appendChild(el('circle', {
    cx: camX + distM * pxPerM, cy: midY,
    r: Math.max(2, (sizeM / 2) * pxPerM),
    fill: 'var(--series-2)',
  }));

  host.replaceChildren(svg);
}
