// render/spot-detail.js — one saved spot's own page (L-02) and its forecast
// planner (L-03): the spot's facts and current sky, then three days of wind,
// gust, rain and light to scrub through at surface or flying height, ending in
// "Plan at this time". Lives beside the roster inside the spots card — while a
// spot is open the list and save form hide, the back link brings them back.
//
// The page fetches its own sky for the spot's coordinates (the same
// fetchLiveEnv live mode uses, aimed at the spot instead of the pin), cached
// per spot for the session, and says so honestly when the fetch fails.
// spots.js imports openSpotDetail from here; this module never imports
// spots.js back — app.js hands flyToSpot and loadoutLabel in through
// bindSpotDetail, so the dependency only runs one way.
import { loadSpots } from '../data.js';
import { fetchLiveEnv, goldenHour, nearestHourIndex } from '../weather.js';
import { levelWindPatch } from '../windprofile.js';
import { forecastChart } from '../components/forecast-chart.js';
import { hourSummary, clockTime, forecastOutlook, setForecastHour } from './forecast.js';
import { state } from '../state.js';
import { f0 } from './format.js';
import { $ } from './dom.js';

// injected by app.js: { flyToSpot, loadoutLabel, openPlan }
let deps = null;
export function bindSpotDetail(d) { deps = d; }

/* ---------- page state (ephemeral on purpose, like the scrubber's) ---------- */

let openId = null;   // which spot's page is open; null = the roster is showing
let dayIdx = 0;      // which forecast day tab
let altM = 80;       // 10 = surface, 80 = flying height — the two the mockup names
let hourIdx = null;  // selected hour within the day; null = pick a default
let fetchCtl = null; // aborts the in-flight sky fetch when the page closes

/** Per-spot sky for this session: id → { status, data?, message? }. */
const skies = new Map();

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function ensureSky(spot) {
  const have = skies.get(spot.id);
  if (have && have.status !== 'error') return;
  if (fetchCtl) fetchCtl.abort();
  const ctl = new AbortController();
  fetchCtl = ctl;
  skies.set(spot.id, { status: 'loading' });
  fetchLiveEnv({ lat: spot.lat, lng: spot.lng }, { signal: ctl.signal })
    .then((data) => { skies.set(spot.id, { status: 'ready', data }); })
    .catch((err) => {
      // An abort means the page moved on — clear the half-entry so reopening
      // this spot fetches again instead of waiting on a promise that died.
      if (ctl.signal.aborted) { skies.delete(spot.id); return; }
      skies.set(spot.id, { status: 'error', message: err && err.message ? err.message : 'fetch failed' });
    })
    .then(() => { if (openId === spot.id) renderSpotDetail(); });
}

/* ---------- the forecast day, resolved to a height ---------- */

/**
 * One day's hours with the wind read off the chosen level — the same
 * levelWindPatch live planning uses, so the chart and the plan can never
 * disagree about what 10 m wind means. A missing level is a null reading (a
 * gap in the chart), never a silently substituted height.
 */
function dayHoursAt(forecast, day, alt) {
  return forecast.hours
    .filter((h) => ymd(h.time) === day.date)
    .map((h) => {
      const lvl = alt === 80 ? null : levelWindPatch(h.levels, alt, h.gust10Mph);
      return {
        time: h.time,
        windMph: alt === 80 ? h.windMph : (lvl ? lvl.windMph : null),
        windFromDeg: alt === 80 ? h.windFromDeg : (lvl ? lvl.windFromDeg : null),
        gustMph: alt === 80 ? h.gustMph : (lvl ? lvl.gustMph : null),
        tempF: h.tempF,
        precipPct: h.precipPct,
      };
    });
}

/** Today lands on the hour nearest now; a future day starts at midday. */
function defaultHour(hs, day) {
  if (!hs.length) return 0;
  if (day.date === ymd(new Date())) {
    const i = nearestHourIndex({ hours: hs }, new Date());
    return i < 0 ? 0 : i;
  }
  return Math.min(12, hs.length - 1);
}

function dayLabel(day) {
  if (day.date === ymd(new Date())) return 'Today';
  const [y, m, d] = day.date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short' });
}

/* ---------- actions ---------- */

/**
 * Plan at this time: live weather takes the launch point to this spot, and once
 * the fetch lands the scrubber is set to the audited hour — the exact hand-off
 * the Plan destination's own strip would do, so arriving there shows the same
 * banner, tiles and verdict the pilot just read here. Pieces that are missing
 * degrade honestly: a failed fetch arrives on Plan with live mode's own error
 * showing, an empty day just plans for now.
 */
async function planAtTime(spot, when) {
  state.weatherId = 'live';
  const wait = deps.flyToSpot(spot);
  if (wait) await wait;
  if (when) {
    const outlook = forecastOutlook();
    if (outlook) {
      const i = nearestHourIndex({ hours: outlook.hours }, when);
      if (i >= 0) setForecastHour(i);
    }
  }
  deps.openPlan();
}

/* ---------- rendering ---------- */

export function openSpotDetail(id) {
  openId = id;
  dayIdx = 0;
  altM = 80;
  hourIdx = null;
  const spot = loadSpots().find((s) => s.id === id);
  if (spot) ensureSky(spot);
  renderSpotDetail();
}

function closeSpotDetail() {
  openId = null;
  if (fetchCtl) fetchCtl.abort();
  renderSpotDetail();
}

function chip(label, pressed, onPress) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'filter-chip';
  btn.textContent = label;
  btn.setAttribute('aria-pressed', String(pressed));
  btn.addEventListener('click', onPress);
  return btn;
}

function metaLine(text) {
  const span = document.createElement('span');
  span.className = 'spot-meta';
  span.textContent = text;
  return span;
}

/** The L-03 planner: day tabs, height toggle, the chart and its reading. */
function forecastSection(spot, sky) {
  const section = document.createElement('section');
  section.className = 'spot-forecast';

  const { forecast } = sky.data;
  const days = (forecast && forecast.days) || [];
  if (!days.length) {
    section.appendChild(metaLine('No forecast published for this spot.'));
    return section;
  }
  if (dayIdx >= days.length) dayIdx = 0;
  const day = days[dayIdx];
  const hs = dayHoursAt(forecast, day, altM);
  if (hourIdx == null) hourIdx = defaultHour(hs, day);
  hourIdx = Math.min(hourIdx, Math.max(hs.length - 1, 0));

  const tabs = document.createElement('div');
  tabs.className = 'spot-day-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Forecast day');
  days.forEach((d, i) => {
    const btn = chip(dayLabel(d), i === dayIdx, () => {
      dayIdx = i;
      hourIdx = null; // a new day picks its own default hour
      renderSpotDetail();
    });
    btn.dataset.day = String(i);
    tabs.appendChild(btn);
  });

  const toggle = document.createElement('div');
  toggle.className = 'spot-alt-toggle';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Wind height');
  for (const [alt, label] of [[10, 'Surface · 10 m'], [80, 'Flying height · 80 m']]) {
    const btn = chip(label, altM === alt, () => {
      altM = alt; // keep the hour — the toggle exists to compare heights at it
      renderSpotDetail();
    });
    btn.dataset.alt = String(alt);
    toggle.appendChild(btn);
  }
  section.append(tabs, toggle);

  if (!hs.length) {
    // The stub world and late-evening fetches both produce a day the model has
    // published no hours for yet — say that, don't draw an empty axis.
    section.appendChild(metaLine('No hourly forecast for this day yet.'));
    return section;
  }

  const golden = goldenHour(day);
  const reading = document.createElement('p');
  reading.id = 'spot-reading';
  reading.className = 'fc-reading';
  const readingText = (i) => `${clockTime(hs[i].time)} — ${hourSummary(hs[i])}`;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'spot-hour';
  slider.min = '0';
  slider.max = String(hs.length - 1);
  slider.step = '1';
  slider.setAttribute('aria-label', 'Forecast hour');

  const chartHost = document.createElement('div');
  chartHost.className = 'fc-host';
  const drawChart = () => {
    chartHost.replaceChildren(forecastChart({
      hours: hs,
      golden,
      selected: hourIdx,
      label: clockTime,
      // The chart moves its own cursor while dragging; only the words and the
      // slider need to follow, so a scrub never rebuilds the surface mid-drag.
      onPick: (i) => setHour(i, { redraw: false }),
    }));
  };
  const setHour = (i, { redraw = true } = {}) => {
    hourIdx = i;
    slider.value = String(i);
    slider.setAttribute('aria-valuetext', readingText(i));
    reading.textContent = readingText(i);
    if (redraw) drawChart();
  };
  slider.addEventListener('input', () => setHour(Number(slider.value)));
  drawChart();
  setHour(hourIdx, { redraw: false });

  const goldenLine = document.createElement('p');
  goldenLine.className = 'fc-golden';
  goldenLine.hidden = !golden;
  if (golden) {
    goldenLine.textContent = `Sunset ${clockTime(golden.sunset)} · golden hour from ${clockTime(golden.goldenStart)}`;
  }

  const legend = document.createElement('p');
  legend.className = 'fc-legend';
  for (const [cls, word] of [['wind', `Wind · ${altM} m`], ['gust', 'Gust'], ['rain', 'Rain %'], ['gold', 'Golden hour']]) {
    const item = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = `fc-dot fc-dot-${cls}`;
    item.append(dot, document.createTextNode(word));
    legend.appendChild(item);
  }

  const plan = document.createElement('button');
  plan.type = 'button';
  plan.id = 'btn-spot-plan';
  plan.className = 'map-btn';
  plan.textContent = 'Plan at this time';
  plan.addEventListener('click', () => { planAtTime(spot, hs[hourIdx] ? hs[hourIdx].time : null); });

  section.append(chartHost, slider, reading, goldenLine, legend, plan);
  return section;
}

/** The fetch-state region: current sky when it landed, honesty when it didn't. */
function skySection(spot, sky) {
  const wrap = document.createElement('div');
  wrap.id = 'spot-now';
  if (!sky || sky.status === 'loading') {
    wrap.appendChild(metaLine('Checking the sky over this spot…'));
    return wrap;
  }
  if (sky.status === 'error') {
    const err = document.createElement('p');
    err.className = 'spot-fetch-error';
    err.textContent = `Could not fetch this spot’s weather (${sky.message}) — the facts above still stand.`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.id = 'btn-spot-retry';
    retry.className = 'link-btn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => { ensureSky(spot); renderSpotDetail(); });
    wrap.append(err, retry);
    return wrap;
  }
  // Current conditions, worded by the same sentence-maker the scrubber uses.
  // The patch is the 80 m wind live planning would apply — say which height.
  const now = document.createElement('p');
  now.className = 'spot-now-reading';
  now.textContent = `Right now at 80 m — ${hourSummary(sky.data.patch)}`;
  wrap.append(now, forecastSection(spot, sky));
  return wrap;
}

export function renderSpotDetail() {
  const host = $('spot-detail');
  const spot = openId ? loadSpots().find((s) => s.id === openId) : null;
  if (openId && !spot) openId = null; // deleted in another tab — page is gone
  const open = !!spot;
  $('spots-list').hidden = open;
  $('spot-form').hidden = open;
  host.hidden = !open;
  host.replaceChildren();
  if (!open) return;

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'link-btn spot-back';
  back.textContent = '← All spots';
  back.addEventListener('click', closeSpotDetail);

  const head = document.createElement('div');
  head.className = 'spot-detail-head';
  const name = document.createElement('h4');
  name.textContent = spot.name;
  head.appendChild(name);
  // savedAt is when the pilot saved the spot — the app doesn't track flights
  // from here, so the label says saved, not flown.
  const saved = new Date(spot.savedAt);
  const facts = [
    `Saved ${saved.toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
    `${spot.lat.toFixed(4)}, ${spot.lng.toFixed(4)}`,
    spot.elevFt == null ? null : `${f0(spot.elevFt)} ft`,
  ].filter(Boolean).join(' · ');
  head.appendChild(metaLine(facts));
  head.appendChild(metaLine(`Loadout — ${deps.loadoutLabel(spot.loadout)}`));
  if (spot.notes) {
    const notes = document.createElement('p');
    notes.className = 'spot-notes';
    notes.textContent = spot.notes;
    head.appendChild(notes);
  }

  const fly = document.createElement('button');
  fly.type = 'button';
  fly.id = 'btn-spot-fly';
  fly.className = 'map-btn';
  fly.textContent = 'Fly here';
  // Same move the roster's button makes — pin, elevation, rig — with the same
  // note appearing below; the page stays open, the planner still applies.
  fly.addEventListener('click', () => { deps.flyToSpot(spot); });
  const actions = document.createElement('div');
  actions.className = 'spot-detail-actions';
  actions.appendChild(fly);

  host.append(back, head, actions, skySection(spot, skies.get(spot.id)));
}
