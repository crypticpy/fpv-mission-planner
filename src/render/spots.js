// render/spots.js — the Map tab's saved launch points: the roster, saving the
// current pin and rig, and flying to one.
import {
  PAYLOADS, allBatteries, loadSpots, saveSpot, deleteSpot,
} from '../data.js';
import { allDrones, compatible } from '../registry.js';
import { loadMapState, saveMapState } from '../store.js';
import { setLaunchPoint, renderSpotMarkers } from '../map.js';
import { distanceKm } from '../domain/geo.js';
import { launchPoint } from '../weather.js';
import { state, units } from '../state.js';
import { f0, f1 } from './format.js';
import { $ } from './dom.js';
import { populateControls } from './controls.js';
import { goLive } from './live.js';
import { pushLaunch, pushLoadout } from '../mission-commands.js';

/* ---------- saved launch spots ----------
   The Map tab's roster of named launch points. A spot carries the elevation
   cached when it was saved plus a snapshot of the rig flown there; flying to one
   restores as much of that as still exists, and says so when it doesn't. */

function setSpotsNote(msg) {
  const el = $('spots-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/** Snapshot of the five loadout controls a spot remembers. */
function currentLoadout() {
  return {
    droneId: state.droneId,
    batteryId: state.batteryId,
    parallelPacks: state.parallelPacks,
    payloadId: state.payloadId,
    extraG: state.extraG,
  };
}

/** A snapshot is only applicable while every id in it still resolves. */
function loadoutIsLive(l) {
  if (!l) return false;
  const d = allDrones().find(x => x.id === l.droneId);
  return !!d
    && allBatteries().some(b => b.id === l.batteryId && compatible(d, b))
    && PAYLOADS.some(p => p.id === l.payloadId);
}

function loadoutLabel(l) {
  if (!l) return 'no saved rig';
  const d = allDrones().find(x => x.id === l.droneId);
  const b = allBatteries().find(x => x.id === l.batteryId);
  if (!d || !b) return 'saved rig no longer exists';
  return `${d.short || d.name} + ${b.short || b.name}${l.parallelPacks ? ' ×2' : ''}`;
}

function spotMeta(spot) {
  const u = units();
  const away = distanceKm(launchPoint(), { lat: spot.lat, lng: spot.lng });
  const where = away < 0.05
    ? 'the current pin'
    : `${f1(u.distanceFromKm(away))} ${u.distanceUnit} from current pin`;
  // Elevation is feet throughout the app — the physics converts, the UI doesn't.
  const elev = spot.elevFt == null ? null : `${f0(spot.elevFt)} ft`;
  return [where, elev, loadoutLabel(spot.loadout)].filter(Boolean).join(' · ');
}

export function renderSpots() {
  const host = $('spots-list');
  const spots = loadSpots();
  host.replaceChildren();
  if (!spots.length) {
    const empty = document.createElement('p');
    empty.className = 'spots-empty';
    empty.textContent = 'No saved spots yet — position the pin, name it, save it.';
    host.appendChild(empty);
  }
  for (const spot of spots) {
    const row = document.createElement('div');
    row.className = 'spot-row';
    const text = document.createElement('div');
    text.className = 'spot-text';
    const name = document.createElement('span');
    name.className = 'spot-name';
    name.textContent = spot.name;
    const meta = document.createElement('span');
    meta.className = 'spot-meta';
    meta.textContent = spotMeta(spot);
    text.append(name, meta);
    if (spot.notes) {
      const notes = document.createElement('span');
      notes.className = 'spot-notes';
      notes.textContent = spot.notes;
      text.appendChild(notes);
    }
    const actions = document.createElement('div');
    actions.className = 'spot-actions';
    const fly = document.createElement('button');
    fly.type = 'button';
    fly.className = 'map-btn';
    fly.textContent = 'Fly here';
    fly.addEventListener('click', () => flyToSpot(spot));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link-btn';
    del.textContent = 'delete';
    del.addEventListener('click', () => {
      deleteSpot(spot.id);
      setSpotsNote(`Deleted “${spot.name}”.`);
      renderSpots();
    });
    actions.append(fly, del);
    row.append(text, actions);
    host.appendChild(row);
  }
  renderSpotMarkers(spots, flyToSpot);
}

/**
 * Fly here: the launch point always moves. Cached elevation applies unless live
 * weather owns the environment (it will fetch the real one for the new point),
 * and the loadout applies only if every id in the snapshot still resolves —
 * a half-restored rig is a plan for an aircraft the pilot never picked.
 */
function flyToSpot(spot) {
  const pt = { lat: spot.lat, lng: spot.lng };
  const live = state.weatherId === 'live';
  const saved = loadMapState();
  // Persist first: weather.js reads the launch point from storage, and the map
  // may not be initialized yet when a spot is chosen.
  saveMapState({ ...pt, zoom: saved?.zoom ?? 13, baseLayer: saved?.baseLayer ?? 'satellite' });

  const notes = [`Flying ${spot.name}.`];
  if (spot.elevFt != null && !live) state.env.elevFt = spot.elevFt;

  if (spot.loadout && loadoutIsLive(spot.loadout)) {
    const l = spot.loadout;
    const batt = allBatteries().find(b => b.id === l.batteryId);
    Object.assign(state, {
      droneId: l.droneId, batteryId: l.batteryId, parallelPacks: l.parallelPacks,
      payloadId: l.payloadId, extraG: l.extraG,
    });
    // A stale manufacturer filter would hide the restored pack and update()
    // would silently swap it out from under the plan.
    if (state.manufacturerId !== 'all' && batt.manufacturerId !== state.manufacturerId) {
      state.manufacturerId = 'all';
    }
    notes.push(`Loadout: ${loadoutLabel(l)}.`);
  } else if (spot.loadout) {
    notes.push('Saved loadout no longer exists — kept your current rig.');
  }
  if (spot.elevFt != null && live) notes.push('Live weather will set the elevation for this point.');
  setSpotsNote(notes.join(' '));

  // Document first, pin second — the same order map.js's moveLaunch keeps
  // (raise, then render). setLaunchPoint renders synchronously on its way
  // through, so the commands it must reflect have to already be on the
  // document; raised afterwards they would leave this pass planned at the spot
  // the pilot just left. The pin move deliberately skips map.js's onLaunchMove,
  // so live weather is refetched exactly once, here (ADR 0002).
  pushLaunch(pt);
  pushLoadout();
  setLaunchPoint(pt);
  populateControls();
  if (live) goLive(pt);
}

export function bindSpots() {
  $('spot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('spot-name').value.trim();
    if (!name) { setSpotsNote('Name the spot first — that’s how you’ll find it later.'); return; }
    const pt = launchPoint();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const id = `spot-${slug || Date.now().toString(36)}`;
    // Same name = same id: saveSpot upserts, so tell the pilot which happened.
    const replacing = loadSpots().some(s => s.id === id);
    const stored = saveSpot({
      id,
      name,
      lat: pt.lat, lng: pt.lng,
      elevFt: state.env.elevFt,
      notes: $('spot-notes').value,
      loadout: currentLoadout(),
      savedAt: Date.now(),
    });
    if (!stored) { setSpotsNote('Could not save this spot — the launch point looks invalid.'); return; }
    $('spot-name').value = '';
    $('spot-notes').value = '';
    setSpotsNote(`${replacing ? 'Updated' : 'Saved'} “${stored.name}” — ${loadoutLabel(stored.loadout)}.`);
    renderSpots();
  });
}
