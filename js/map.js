// map.js — Map view: vendored Leaflet base map, draggable launch point, and a
// wind-shaped mission footprint swept from the same physics as the dashboard.
// The footprint is the out-and-back turnaround envelope: how far out you can
// fly on each course and still make it home — not general reachability.

import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { planMission } from './physics.js';
import { loadMapState, saveMapState } from './data.js';
import { lineChart, legend } from './charts.js';

const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const EARTH_R_KM = 6371;
const SWEEP_STEP_DEG = 5; // half-sweep sample spacing, relative to the wind axis

const $ = id => document.getElementById(id);

let deps = null; // injected by app.js: { missionInputs, units, requestRender, applyEnv }
let map = null;
let marker = null;
let satLayer = null, osmLayer = null;
let footReal = null, footBest = null;
let windControl = null;
let launch = null;       // { lat, lng } of the launch point
let justDragged = false; // swallow the synthetic click Leaflet fires after a drag
let needsFit = false;    // fit map to footprint on next render
let tileErrorShown = false;

export function setupMapView(d) { deps = d; }

/** Called on switch to the Map tab, after the container is un-hidden. */
export function showMapView() {
  if (!map) initMap();
  map.invalidateSize({ pan: false });
}

function initMap() {
  const saved = loadMapState();
  launch = saved ? { lat: saved.lat, lng: saved.lng } : { ...AUSTIN };
  needsFit = !saved;

  satLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
      maxNativeZoom: 19, maxZoom: 21,
    });
  osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19, maxZoom: 21,
  });

  map = L.map('map-canvas', {
    center: [launch.lat, launch.lng],
    zoom: saved ? saved.zoom : 12,
    layers: [saved?.baseLayer === 'streets' ? osmLayer : satLayer],
  });
  L.control.layers({ Satellite: satLayer, Streets: osmLayer }).addTo(map);
  L.control.scale().addTo(map);
  windControl = makeWindControl().addTo(map);

  const icon = L.divIcon({
    className: 'launch-marker', html: '<div class="launch-dot"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  marker = L.marker([launch.lat, launch.lng], { icon, draggable: true, title: 'Launch point' }).addTo(map);
  marker.on('dragend', () => {
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    moveLaunch(marker.getLatLng());
  });
  map.on('click', e => { if (!justDragged) moveLaunch(e.latlng); });
  map.on('moveend zoomend baselayerchange', persist);
  satLayer.on('tileerror', onTileError);
  osmLayer.on('tileerror', onTileError);

  $('btn-locate').addEventListener('click', locate);
  $('btn-fit').addEventListener('click', () => { needsFit = true; deps.requestRender(); });
  $('btn-live-wx').addEventListener('click', fetchLiveWeather);
}

function persist() {
  saveMapState({
    lat: launch.lat, lng: launch.lng,
    zoom: map.getZoom(),
    baseLayer: map.hasLayer(osmLayer) ? 'streets' : 'satellite',
  });
}

function moveLaunch(latlng) {
  launch = { lat: latlng.lat, lng: wrapLng(latlng.lng) };
  marker.setLatLng(launch);
  needsFit = true;
  persist();
  deps.requestRender();
}

function locate() {
  if (!navigator.geolocation) { note('Geolocation is not available in this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => moveLaunch({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => note('Location unavailable — check browser permissions.'),
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function onTileError() {
  if (tileErrorShown) return;
  tileErrorShown = true;
  wxNote('Some map tiles failed to load — the footprint math is unaffected.');
}

function note(msg) {
  const el = $('map-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function wxNote(msg) {
  const el = $('wx-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* ---------- geometry ---------- */

function wrapLng(lng) {
  return ((lng % 360) + 540) % 360 - 180;
}

// Spherical destination point from launch along a bearing.
function destination(lat, lng, bearingDeg, distKm) {
  const br = bearingDeg * Math.PI / 180;
  const d = distKm / EARTH_R_KM;
  const la1 = lat * Math.PI / 180, lo1 = lng * Math.PI / 180;
  const sinLa2 = Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br);
  const la2 = Math.asin(sinLa2);
  const lo2 = lo1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * sinLa2,
  );
  return [la2 * 180 / Math.PI, wrapLng(lo2 * 180 / Math.PI)];
}

/* ---------- footprint sweep ---------- */

// Half-sweep 0…180° off the wind axis; the other half is its mirror image
// (the wind decomposition depends only on cos and |sin| of the offset).
function sweep(cruiseMode, cache) {
  const base = deps.missionInputs();
  const windFrom = base.env.windFromDeg;
  const radii = [];
  for (let a = 0; a <= 180; a += SWEEP_STEP_DEG) {
    radii.push(planMission({
      ...base, cruiseMode, courseDeg: windFrom + a, lite: true, _pCache: cache,
    }).radiusKm);
  }
  return radii;
}

// Expand a half-sweep to per-degree radii for all 360 absolute courses.
function fullCircle(halfRadii, windFrom) {
  const out = new Array(360);
  for (let c = 0; c < 360; c++) {
    let off = (c - windFrom) % 360;
    if (off < 0) off += 360;
    const alpha = off > 180 ? 360 - off : off;
    const i = alpha / SWEEP_STEP_DEG;
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, halfRadii.length - 1);
    const t = i - lo;
    out[c] = halfRadii[lo] * (1 - t) + halfRadii[hi] * t;
  }
  return out;
}

function footprintLatLngs(radiiByCourse) {
  const pts = [];
  for (let c = 0; c < 360; c++) {
    const r = radiiByCourse[c];
    const p = r > 0 ? destination(launch.lat, launch.lng, c, r) : [launch.lat, launch.lng];
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    pts.push(p);
  }
  return pts;
}

// Polar shoelace: ½ Σ rᵢ·rᵢ₊₁·sin Δθ — exact for the sampled polygon, and
// zero-radius wedges contribute nothing (right answer for a pinched fan).
function footprintAreaKm2(radiiByCourse) {
  let s = 0;
  for (let c = 0; c < 360; c++) s += radiiByCourse[c] * radiiByCourse[(c + 1) % 360];
  return 0.5 * s * Math.sin(Math.PI / 180);
}

/* ---------- wind control ---------- */

function makeWindControl() {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'wind-control');
      div.innerHTML = '<span class="wind-arrow">➤</span><span class="wind-text"></span>';
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  return new Ctl();
}

function updateWindControl(env, u) {
  const el = windControl.getContainer();
  if (!el) return;
  // "➤" points right (a 90° bearing); wind flows toward windFromDeg + 180.
  el.querySelector('.wind-arrow').style.transform = `rotate(${(env.windFromDeg + 90) % 360}deg)`;
  el.querySelector('.wind-text').textContent =
    `${Math.round(u.speedFromMs(env.windAvgMs))} ${u.speedUnit} from ${Math.round(env.windFromDeg)}°`;
}

/* ---------- render ---------- */

function setTile(id, value, sub) {
  const t = $(id);
  t.querySelector('.tile-value').textContent = value;
  t.querySelector('.tile-sub').textContent = sub;
}

const COMPASS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' };

/** Full overlay + chart render; rPlan is the dashboard planning-case result. */
export function renderMapView(rPlan) {
  if (!deps) return;
  if (!map) initMap();
  map.invalidateSize({ pan: false });

  const u = deps.units();
  const base = deps.missionInputs();
  const windFrom = base.env.windFromDeg;

  const cache = new Map(); // one powerAtSpeed memo shared across both sweeps
  const halfReal = sweep(base.cruiseMode, cache);
  const halfBest = sweep('range', cache);
  const realByCourse = fullCircle(halfReal, windFrom);
  const bestByCourse = fullCircle(halfBest, windFrom);

  if (footReal) { footReal.remove(); footReal = null; }
  if (footBest) { footBest.remove(); footBest = null; }
  const anyReal = realByCourse.some(r => r > 0);
  const anyBest = bestByCourse.some(r => r > 0);
  if (!anyReal && !anyBest) {
    note('No viable mission in these conditions — the footprint collapses to the launch point.');
  } else {
    note(anyReal ? null
      : 'No reach at the planned cruise in this wind — the dashed ring is what best-range speed could still manage.');
    footBest = L.polygon(footprintLatLngs(bestByCourse), {
      interactive: false, color: 'var(--series-3)', weight: 2,
      dashArray: '6 5', fill: false, opacity: 0.9,
    }).addTo(map);
    if (anyReal) {
      footReal = L.polygon(footprintLatLngs(realByCourse), {
        interactive: false, color: 'var(--series-1)', weight: 2,
        fillColor: 'var(--series-1)', fillOpacity: 0.12, opacity: 0.95,
      }).addTo(map);
    }
  }

  if (needsFit) {
    needsFit = false;
    const target = footReal || footBest;
    if (target) map.fitBounds(target.getBounds(), { padding: [24, 24] });
    else map.setView([launch.lat, launch.lng]);
  }

  updateWindControl(base.env, u);

  // Stat tiles — upwind/downwind/crosswind come straight from the half-sweep samples.
  const upC = ((Math.round(windFrom) % 360) + 360) % 360;
  const downC = (upC + 180) % 360;
  const fmtDist = km => `${u.distanceFromKm(km).toFixed(1)} ${u.distanceUnit}`;
  setTile('tile-upwind', fmtDist(halfReal[0]), `course ${upC}° — into the wind`);
  setTile('tile-downwind', fmtDist(halfReal[halfReal.length - 1]), `course ${downC}° — wind behind`);
  setTile('tile-crosswind', fmtDist(halfReal[90 / SWEEP_STEP_DEG]),
    `course ${(upC + 90) % 360}° / ${(upC + 270) % 360}°`);
  setTile('tile-area', `${u.areaFromKm2(footprintAreaKm2(realByCourse)).toFixed(1)} ${u.areaUnit}`,
    'planned-cruise envelope');
  setTile('tile-aloft', `${rPlan.timeMin.toFixed(1)} min`, 'dashboard planning case');

  // Range vs heading chart, with the dashboard's relative-wind case pinned on it.
  const series = [
    {
      name: 'Planned cruise', color: 'var(--series-1)',
      pts: Array.from({ length: 361 }, (_, c) => ({ x: c, y: u.distanceFromKm(realByCourse[c % 360]) })),
    },
    {
      name: 'Theoretical best range', color: 'var(--series-3)',
      pts: Array.from({ length: 361 }, (_, c) => ({ x: c, y: u.distanceFromKm(bestByCourse[c % 360]) })),
    },
  ];
  const plannedC = base.env.windMode === 'tailOut' ? downC
    : base.env.windMode === 'cross' ? (upC + 90) % 360 : upC;
  const markers = [
    { x: upC, y: u.distanceFromKm(realByCourse[upC]), color: 'var(--series-2)', label: 'upwind' },
    { x: downC, y: u.distanceFromKm(realByCourse[downC]), color: 'var(--series-2)', label: 'downwind', labelBelow: true },
    { x: plannedC, y: u.distanceFromKm(rPlan.radiusKm), color: 'var(--series-4)', label: 'planned', labelBelow: true },
  ];
  legend($('legend-bearing'), series);
  lineChart($('chart-bearing'), {
    series, markers, height: 240,
    xTicks: [0, 45, 90, 135, 180, 225, 270, 315, 360],
    xFmt: c => COMPASS[c] ?? `${c}°`,
    yFmt: v => `${v.toFixed(1)} ${u.distanceUnit}`,
    xLabel: 'outbound course over ground',
    yLabel: u.distanceUnit,
    tipTitle: 'Course',
  });
}

/* ---------- live weather (Open-Meteo, no key) ---------- */

async function fetchLiveWeather() {
  const btn = $('btn-live-wx');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    // 80 m wind, not 10 m: FPV cruise happens at 30–120 m AGL, where the wind
    // typically runs well above the surface reading. Gusts only exist at 10 m.
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${launch.lat.toFixed(4)}&longitude=${launch.lng.toFixed(4)}`
      + '&current=temperature_2m,relative_humidity_2m,wind_speed_80m,wind_direction_80m,wind_gusts_10m'
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const c = data.current;
    if (!c || !isFinite(c.temperature_2m) || !isFinite(c.wind_speed_80m)
      || !isFinite(c.relative_humidity_2m) || !isFinite(c.wind_direction_80m)) throw new Error('malformed response');
    const patch = {
      tempF: Math.round(c.temperature_2m),
      rhPct: Math.round(c.relative_humidity_2m),
      windMph: Math.round(c.wind_speed_80m),
      gustMph: Math.round(Math.max(c.wind_gusts_10m || 0, c.wind_speed_80m)),
      windFromDeg: ((Math.round(c.wind_direction_80m) % 360) + 360) % 360,
    };
    if (isFinite(data.elevation)) patch.elevFt = Math.round(data.elevation * 3.28084);
    deps.applyEnv(patch);
    wxNote(`Live at launch point: ${patch.windMph} mph from ${patch.windFromDeg}° (80 m altitude) · `
      + `gusts ${Math.round(c.wind_gusts_10m || 0)} mph (10 m) · ${patch.tempF}°F · ${patch.rhPct}% RH.`);
  } catch (err) {
    wxNote(`Live weather unavailable (${err.message}) — manual values kept.`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Live weather here';
  }
}
