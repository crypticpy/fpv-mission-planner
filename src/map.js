// map.js — Map view: vendored Leaflet base map, draggable launch point, and a
// wind-shaped mission footprint swept from the same physics as the dashboard.
// The footprint is the out-and-back turnaround envelope: how far out you can
// fly on each course and still make it home — not general reachability.

import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { planMission } from './domain/physics.js';
import { loadMapState, saveMapState } from './store.js';
import { lineChart, legend } from './charts.js';
import { adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2 } from './sweep.js';
import { destination, wrapLng } from './domain/geo.js';
import { plannedCourseDeg } from './terrain.js';

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

const $ = id => document.getElementById(id);

// Injected by app.js: { missionInputs, units, beginner, requestRender, goLive,
// onLaunchMove } plus the route port — { routeWaypoints, onAddWaypoint,
// onMoveWaypoint, onRemoveWaypoint, onClearRoute } — which is how this file
// reads and edits a route it no longer owns (see the route-mode section below).
let deps = null;
let map = null;
let marker = null;
let satLayer = null, osmLayer = null;
let footReal = null, footBest = null, footCase = null;
let legLine = null;    // the outbound leg the dashboard plans, and the terrain profile follows
let legBlocked = null; // the part of it the radio can't see past (Phase 4 item 6)
let routeLayers = [];  // the drawn route: casing, out legs, return leg, waypoint pins
let windControl = null;
let launch = null;       // { lat, lng } of the launch point
let justDragged = false; // swallow the synthetic click Leaflet fires after a drag
let justSpotClick = false; // same guard for a saved-spot marker hit
let justWpClick = false;   // …and for a waypoint pin, which deletes on click
let needsFit = false;    // fit map to footprint on next render
let tileErrorShown = false;

export function setupMapView(d) { deps = d; }

/** Called on switch to the Map tab, after the container is un-hidden. */
export function showMapView() {
  if (!map) initMap();
  map.invalidateSize({ pan: false });
  startParticles();
}

/** Called on switch back to the Planner tab — stop burning frames off-screen. */
export function pauseMapView() {
  stopParticles();
}

/** Cheap reflow for height-only resizes (mobile URL bar, keyboard) — no re-render. */
export function resizeMapView() {
  if (map) map.invalidateSize({ pan: false });
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
  map.on('click', e => {
    if (justDragged || justSpotClick || justWpClick) return;
    // In route mode a click is a waypoint, not a new launch point: the pilot is
    // drawing a line out of a spot they have already chosen.
    if (routeActive()) addWaypoint(e.latlng);
    else moveLaunch(e.latlng);
  });
  map.on('moveend zoomend baselayerchange', persist);
  satLayer.on('tileerror', onTileError);
  osmLayer.on('tileerror', onTileError);
  drawSpotMarkers(); // saved spots may have been handed over before the map existed

  $('btn-locate').addEventListener('click', locate);
  $('btn-fit').addEventListener('click', () => { needsFit = true; deps.requestRender(); });
  $('btn-live-wx').addEventListener('click', () => deps.goLive({ ...launch }));
  $('btn-route').addEventListener('click', () => setRouteMode(!routeModeOn()));
  $('btn-route-clear').addEventListener('click', () => {
    // Clearing is not leaving route mode — the pilot is starting the line again,
    // and the mode has to survive the route going empty under it.
    routeOn = true;
    deps.onClearRoute();
  });
  initParticles();
}

function persist() {
  saveMapState({
    lat: launch.lat, lng: launch.lng,
    zoom: map.getZoom(),
    baseLayer: map.hasLayer(osmLayer) ? 'streets' : 'satellite',
  });
}

function moveLaunch(latlng, { notify = true } = {}) {
  launch = { lat: latlng.lat, lng: wrapLng(latlng.lng) };
  marker.setLatLng(launch);
  needsFit = true;
  // The route survives (ADR 0002). Moving the pin used to throw the waypoints
  // away; it is now a `setLaunch` command on the mission document — raised by
  // the render pass this triggers, which is the one place every launch change in
  // the app passes through — and the waypoints keep their absolute coordinates.
  // What the document drops is the *resolved* altitude behind each leg, because
  // the new site's elevation is not the old one's.
  persist();
  deps.requestRender();
  if (notify) deps.onLaunchMove?.({ ...launch }); // live weather refetches for the new spot
}

/* ---------- route mode (Phase 4 item 7; M1b moved the route itself out) ------ */
//
// The waypoints are no longer held here. They live in the mission document
// (ADR 0002), which is why they now survive a reload and a launch-point move:
// this file raises `addWaypoint` / `moveWaypoint` / `removeWaypoint` through its
// injected deps and reads the result back through `deps.routeWaypoints()`. Every
// number derived from them still lives in src/domain/route.js, every sentence about
// them in src/render/route.js — this file draws and handles the pointer.
//
// The *mode* stays here, because it is a view preference rather than part of the
// plan: which pilot has the route tool open says nothing about the mission.
// It is tri-state. `null` means "follow the document" — a restored mission with
// waypoints comes back with its route visible, which is the whole point of
// persisting it, and an empty one does not put the map into an editing mode
// nobody asked for. The first deliberate route gesture latches a real boolean,
// and from there the pilot's choice sticks for the session.

let routeOn = null;

/** The route port, tolerant of a boot render before the mission document exists. */
const routeWaypoints = () => deps.routeWaypoints?.() ?? [];

const routeModeOn = () => (routeOn === null ? routeWaypoints().length > 0 : routeOn);

/* Route mode is an expert affordance, so beginner mode has none of it: not the
   button, not the crosshair, and not the click that drops a waypoint. Asking
   here rather than latching the flag off means a pilot who drops to beginner to
   show someone the plan gets their route back when they switch out again — and
   in the meantime a map click still moves the launch pin, which is the only
   thing a beginner-mode click has ever meant. */
const routeActive = () => routeModeOn() && !deps.beginner();

/**
 * What the route panel and the drawing pass both read. The waypoints carry their
 * document ids so a pin can name itself in the command it raises; src/domain/route.js
 * and src/render/route.js read nothing but lat/lng off them.
 */
export function routeState() {
  return {
    on: routeActive(),
    launch: launch ? { ...launch } : null,
    waypoints: routeWaypoints().map(w => ({ ...w })),
  };
}

export function setRouteMode(on) {
  routeOn = !!on;
  deps.requestRender();
}

function addWaypoint(latlng) {
  routeOn = true;
  deps.onAddWaypoint({ lat: latlng.lat, lng: wrapLng(latlng.lng) });
}

function removeWaypoint(id) {
  routeOn = true;
  deps.onRemoveWaypoint(id);
}

function moveWaypoint(id, latlng) {
  routeOn = true;
  deps.onMoveWaypoint(id, { lat: latlng.lat, lng: wrapLng(latlng.lng) });
}

/* The weather rail moves the launch point too; it handles its own refetch, so
   this skips the onLaunchMove notification. Before the map first initializes
   there is nothing to sync — initMap reads the saved point. */
export function setLaunchPoint(latlng) {
  if (map) moveLaunch(latlng, { notify: false });
}

/* ---------- saved spots ---------- */

let spotMarkers = [];
let spotSpec = null;      // { spots, onSelect } — replayed if the map isn't up yet
let spotSignature = null; // rebuild the markers only when the roster actually moved

/**
 * Show the saved-spot roster as small secondary pins. Safe to call on every
 * render pass and before the map exists; clicking one calls onSelect(spot).
 */
export function renderSpotMarkers(spots, onSelect) {
  const list = Array.isArray(spots) ? spots : [];
  const sig = list.map(s => `${s.id}@${s.lat},${s.lng}`).join('|');
  const moved = sig !== spotSignature;
  spotSpec = { spots: list, onSelect };
  spotSignature = sig;
  if (map && moved) drawSpotMarkers();
}

function drawSpotMarkers() {
  for (const m of spotMarkers) m.remove();
  spotMarkers = [];
  if (!spotSpec) return;
  for (const s of spotSpec.spots) {
    const icon = L.divIcon({
      // 12 px dot + 2 px border, and Leaflet's containers are content-box —
      // the anchor has to be half the rendered box or the dot sits off its point.
      className: 'spot-marker', html: '<div class="spot-dot"></div>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    });
    const m = L.marker([s.lat, s.lng], {
      icon, title: `${s.name} — fly here`, zIndexOffset: -200, // never over the launch pin
    }).addTo(map);
    m.on('click', () => {
      // Leaflet can still surface a map click behind a marker hit; the guard
      // keeps that from re-dropping the launch pin a pixel off the spot.
      justSpotClick = true;
      setTimeout(() => { justSpotClick = false; }, 0);
      spotSpec.onSelect?.(s);
    });
    spotMarkers.push(m);
  }
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

/* ---------- footprint sweep ---------- */

// Half-sweep 0…180° off the wind axis, refined across the collapse cliff by
// sweep.js; the other half is its mirror image (the wind decomposition depends
// only on cos and |sin| of the offset).
function sweep(cruiseMode, cache) {
  const base = deps.missionInputs();
  const windFrom = base.env.windFromDeg;
  return adaptiveHalfSweep((alpha) => planMission({
    ...base, cruiseMode, courseDeg: windFrom + alpha, lite: true, _pCache: cache,
  }).radiusKm);
}

// Last render's sweep cost, for profiling from the console: the base 37 rays per
// sweep plus whatever refinement bought, and the wall time both sweeps took.
let lastSweep = { baseRays: 0, extraRays: 0, ms: 0 };
export function sweepStats() { return { ...lastSweep }; }

/* The planned-cruise ring exactly as it was last drawn, kept for the mission
   brief (Phase 4 item 8) to re-render as an SVG. Handing over the sweep rather
   than letting the brief run its own is what makes the printed footprint the
   *same* shape as the one on screen by identity — two sweeps of the same physics
   would agree, but only until someone changes one of them. Null until the map
   has rendered once, which is also exactly when the brief button is reachable:
   it lives on the map card. */
let lastFootprint = null;
export function footprintState() {
  return lastFootprint ? { ...lastFootprint, launch: { ...lastFootprint.launch } } : null;
}

function footprintLatLngs(courses, radii) {
  const pts = [];
  for (let i = 0; i < courses.length; i++) {
    const r = radii[i];
    const p = r > 0 ? destination(launch.lat, launch.lng, courses[i], r) : [launch.lat, launch.lng];
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    pts.push(p);
  }
  return pts;
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

/**
 * Full overlay + chart render; rPlan is the dashboard planning-case result and
 * `link` the radio analysis of the outbound leg (src/rf.js via render/terrain.js),
 * or null when no terrain profile describes it.
 */
export function renderMapView(rPlan, link = null, route = null) {
  if (!deps) return;
  if (!map) initMap();
  map.invalidateSize({ pan: false });

  const u = deps.units();
  const base = deps.missionInputs();
  const windFrom = base.env.windFromDeg;

  const cache = new Map(); // one powerAtSpeed memo shared across both sweeps
  const t0 = performance.now();
  const halfReal = sweep(base.cruiseMode, cache);
  const halfBest = sweep('range', cache);
  const real = fullCircle(halfReal, windFrom);
  const best = fullCircle(halfBest, windFrom);
  lastSweep = {
    baseRays: 2 * (1 + 180 / 5),
    extraRays: halfReal.extraRays + halfBest.extraRays,
    ms: performance.now() - t0,
  };
  const realByCourse = real.byCourse;
  const bestByCourse = best.byCourse;
  const areaKm2 = polarAreaKm2(real.courses, real.radii);
  lastFootprint = {
    launch: { ...launch },
    windFromDeg: windFrom,
    plannedCourseDeg: plannedCourseDeg(windFrom, base.env.windMode),
    courses: real.courses.slice(),
    radii: real.radii.slice(),
    byCourse: realByCourse.slice(),
    bestByCourse: bestByCourse.slice(),
    areaKm2,
  };

  flow = { toRad: (windFrom + 180) * Math.PI / 180, speedMs: base.env.windAvgMs };

  if (footReal) { footReal.remove(); footReal = null; }
  if (footBest) { footBest.remove(); footBest = null; }
  if (footCase) { footCase.remove(); footCase = null; }
  const anyReal = realByCourse.some(r => r > 0);
  const anyBest = bestByCourse.some(r => r > 0);
  $('map-canvas').classList.toggle('flight-invalid-map', rPlan.flight.code === 'no_lift');
  if (!anyReal && !anyBest) {
    note(rPlan.flight.code === 'no_lift'
      ? `WILL NOT FLY — ${rPlan.massKg * 1000 > 0 ? (rPlan.massKg * 1000).toFixed(0) : '—'} g all-up weight exceeds the ${rPlan.flight.estimated === false ? 'measured' : 'estimated'} ${rPlan.flight.maxHoverMassG.toFixed(0)} g continuous lift ceiling.`
      : 'No viable mission in these conditions — the footprint collapses to the launch point.');
  } else {
    note(anyReal ? null
      : 'No reach at the planned cruise in this wind — the dashed ring is what best-range speed could still manage.');
    footBest = L.polygon(footprintLatLngs(best.courses, best.radii), {
      interactive: false, color: 'var(--ring-best)', weight: 3,
      dashArray: '9 7', fill: false, opacity: 1,
    }).addTo(map);
    if (anyReal) {
      // Theme-aware casing keeps the planned ring readable over any base layer.
      const realPts = footprintLatLngs(real.courses, real.radii);
      footCase = L.polygon(realPts, {
        interactive: false, color: 'var(--map-casing)', weight: 7, opacity: 0.62, fill: false,
      }).addTo(map);
      footReal = L.polygon(realPts, {
        interactive: false, color: 'var(--ring-planned)', weight: 3.5,
        fillColor: 'var(--ring-planned)', fillOpacity: 0.15, opacity: 1,
      }).addTo(map);
    }
  }

  // The one bearing the terrain profile describes (Phase 4 item 5): the outbound
  // leg this plan flies, drawn so the elevation card below is about a line the
  // pilot can see rather than a compass number they have to imagine.
  if (legLine) { legLine.remove(); legLine = null; }
  if (legBlocked) { legBlocked.remove(); legBlocked = null; }
  const plannedCourse = plannedCourseDeg(windFrom, base.env.windMode);
  if (rPlan.radiusKm > 0) {
    const end = destination(launch.lat, launch.lng, plannedCourse, rPlan.radiusKm);
    // Where the terrain cuts the radio before the pack runs out (Phase 4 item 6),
    // the leg is drawn in two pieces: the part the pilot can still see through,
    // and the "energy OK, link blocked" remainder the footprint ring alone would
    // have promised them. Only this one bearing is profiled — the ring is silent
    // about the radio on every other course, which is what the card says too.
    const cutKm = link && link.blocked && link.clearKm < rPlan.radiusKm ? link.clearKm : null;
    const cut = cutKm != null ? destination(launch.lat, launch.lng, plannedCourse, cutKm) : end;
    legLine = L.polyline([[launch.lat, launch.lng], cut], {
      interactive: false, color: 'var(--series-4)', weight: 2.5, dashArray: '2 6', opacity: 0.95,
    }).addTo(map);
    if (cutKm != null) {
      legBlocked = L.polyline([cut, end], {
        interactive: false,
        color: link.losBlockKm != null ? 'var(--status-critical)' : 'var(--status-serious)',
        weight: 3, dashArray: '1 7', opacity: 0.95,
      }).addTo(map);
    }
  }

  drawRoute(route);

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
  if (rPlan.flight.code === 'no_lift') {
    for (const id of ['tile-upwind', 'tile-downwind', 'tile-crosswind', 'tile-area', 'tile-aloft']) {
      setTile(id, '—', 'unavailable · insufficient lift');
    }
  } else {
    setTile('tile-upwind', fmtDist(radiusAtAlpha(halfReal, 0)), `course ${upC}° — into the wind`);
    setTile('tile-downwind', fmtDist(radiusAtAlpha(halfReal, 180)), `course ${downC}° — wind behind`);
    setTile('tile-crosswind', fmtDist(radiusAtAlpha(halfReal, 90)),
      `course ${(upC + 90) % 360}° / ${(upC + 270) % 360}°`);
    setTile('tile-area', `${u.areaFromKm2(areaKm2).toFixed(1)} ${u.areaUnit}`,
      'planned-cruise envelope');
    setTile('tile-aloft', `${rPlan.timeMin.toFixed(1)} min`, 'dashboard planning case');
  }

  // Range vs heading chart, with the dashboard's relative-wind case pinned on it.
  const series = [
    {
      name: 'Planned cruise', color: 'var(--ring-planned)',
      pts: Array.from({ length: 361 }, (_, c) => ({ x: c, y: u.distanceFromKm(realByCourse[c % 360]) })),
    },
    {
      name: 'Theoretical best range', color: 'var(--ring-best)',
      pts: Array.from({ length: 361 }, (_, c) => ({ x: c, y: u.distanceFromKm(bestByCourse[c % 360]) })),
    },
  ];
  const plannedC = plannedCourse;
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
  $('chart-bearing').classList.toggle('flight-invalid', rPlan.flight.code === 'no_lift');
  $('chart-bearing').dataset.flightMessage = rPlan.flight.code === 'no_lift'
    ? 'WILL NOT FLY · footprint unavailable'
    : '';
}

/* ---------- route overlay (Phase 4 item 7) ---------- */

/**
 * Draw the route over the footprint: the out legs solid, the return home dashed
 * because it is the line the aircraft flies when something goes wrong rather than
 * one the pilot drew, and a numbered pin on every waypoint. Colored by the
 * verdict — a route the budget can't cover is drawn in the critical color, so the
 * map agrees with the panel below it without anyone reading the panel.
 *
 * `route` is null whenever there is nothing to draw (mode off, no waypoints, or
 * beginner mode), and this clears back to a bare footprint.
 */
function drawRoute(route) {
  for (const l of routeLayers) l.remove();
  routeLayers = [];
  const on = routeActive();
  const wps = routeWaypoints();
  const btn = $('btn-route');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? 'Route · on' : 'Route';
  $('btn-route-clear').hidden = !on || wps.length === 0;
  $('map-canvas').classList.toggle('route-mode', on);
  if (!route || route.empty) return;

  const ll = (p) => [p.lat, p.lng];
  const color = route.fits === false ? 'var(--status-critical)' : 'var(--series-2)';
  const outPts = route.points.map(ll);
  const homePts = [ll(route.points[route.points.length - 1]), ll(route.points[0])];
  // Same casing trick the planned ring uses: a dark stroke under the line keeps
  // it readable over bright satellite imagery.
  routeLayers.push(L.polyline(outPts, {
    interactive: false, color: 'var(--map-casing)', weight: 7, opacity: 0.6,
  }).addTo(map));
  routeLayers.push(L.polyline(outPts, {
    interactive: false, color, weight: 3.5, opacity: 1,
  }).addTo(map));
  routeLayers.push(L.polyline(homePts, {
    interactive: false, color, weight: 2.5, dashArray: '7 6', opacity: 0.95,
  }).addTo(map));

  // The pins are indexed the same way the route is: points[0] is the launch, so
  // points[i + 1] and waypoints[i] are the same place — both come off the same
  // document in the same pass.
  route.points.slice(1).forEach((p, i) => {
    const id = wps[i]?.id;
    if (!id) return;
    const worst = route.worst && route.worst.index === i;
    const icon = L.divIcon({
      className: 'route-marker',
      html: `<div class="route-dot${worst ? ' route-dot-worst' : ''}">${i + 1}</div>`,
      iconSize: [20, 20], iconAnchor: [10, 10],
    });
    const m = L.marker(ll(p), {
      icon, draggable: true, title: `Waypoint ${i + 1} — drag to move, click to remove`,
    }).addTo(map);
    m.on('dragend', () => {
      // Same synthetic-click swallow the launch pin uses, and for the same
      // reason twice over: the click behind a drag would delete what was moved.
      justDragged = true;
      justWpClick = true;
      setTimeout(() => { justDragged = false; justWpClick = false; }, 0);
      moveWaypoint(id, m.getLatLng());
    });
    m.on('click', () => {
      if (justDragged) return; // the click a drag leaves behind is not a delete
      // Leaflet can still surface the map click behind a marker hit, and in route
      // mode that would drop a new waypoint on the one just deleted.
      justWpClick = true;
      setTimeout(() => { justWpClick = false; }, 0);
      removeWaypoint(id);
    });
    routeLayers.push(m);
  });
}

/* ---------- wind particles ---------- */
// Screen-space particle drift with a trailing-wake fade (the earth.nullschool
// technique, simplified): the wind field is uniform at the point scale this
// tool plans at, so every particle advects along the same vector, at a speed
// proportional to the wind. Purely decorative — pointer-events: none.

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let windCanvas = null, windCtx = null;
let particles = [];
let rafId = 0;
let flow = { toRad: 0, speedMs: 0 }; // direction the air moves TOWARD, in radians

function initParticles() {
  if (REDUCED_MOTION) return;
  windCanvas = document.createElement('canvas');
  windCanvas.className = 'wind-particles';
  map.getContainer().appendChild(windCanvas);
  windCtx = windCanvas.getContext('2d');
}

function spawnParticle(w, h) {
  return {
    x: Math.random() * w, y: Math.random() * h,
    life: 40 + Math.random() * 100,           // frames until respawn elsewhere
    jitter: 0.7 + Math.random() * 0.6,        // per-particle gustiness
  };
}

function resizeParticleCanvas() {
  const el = map.getContainer();
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth, h = el.clientHeight;
  if (windCanvas.width !== Math.round(w * dpr) || windCanvas.height !== Math.round(h * dpr)) {
    windCanvas.width = Math.round(w * dpr);
    windCanvas.height = Math.round(h * dpr);
    windCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(360, Math.round(w * h / 3200));
    particles = Array.from({ length: n }, () => spawnParticle(w, h));
  }
}

function particleTick() {
  rafId = requestAnimationFrame(particleTick);
  if (document.hidden) return;
  const el = map.getContainer();
  const w = el.clientWidth, h = el.clientHeight;
  if (!w) return; // container hidden
  resizeParticleCanvas();

  // Decay existing trails toward transparent, then draw this frame's segments.
  windCtx.globalCompositeOperation = 'destination-in';
  windCtx.fillStyle = 'rgba(0, 0, 0, 0.93)';
  windCtx.fillRect(0, 0, w, h);
  windCtx.globalCompositeOperation = 'source-over';

  const dirX = Math.sin(flow.toRad), dirY = -Math.cos(flow.toRad);
  const step = (8 + flow.speedMs * 6) / 60; // px per frame — calm still drifts
  windCtx.strokeStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--wind-particle').trim() || 'rgba(190, 226, 255, 0.62)';
  windCtx.lineWidth = 1.2;
  windCtx.beginPath();
  for (const p of particles) {
    const nx = p.x + dirX * step * p.jitter;
    const ny = p.y + dirY * step * p.jitter;
    windCtx.moveTo(p.x, p.y);
    windCtx.lineTo(nx, ny);
    p.x = nx; p.y = ny;
    if (--p.life <= 0 || nx < -4 || nx > w + 4 || ny < -4 || ny > h + 4) {
      Object.assign(p, spawnParticle(w, h));
    }
  }
  windCtx.stroke();
}

function startParticles() {
  if (!windCanvas || rafId) return;
  rafId = requestAnimationFrame(particleTick);
}

function stopParticles() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}
