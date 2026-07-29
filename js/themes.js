// themes.js — one color contract for UI, charts, status, and map overlays.
// Add a preset here and it automatically appears in the theme selector.

import { get as storeGet, set as storeSet } from './store.js';

export const THEMES = Object.freeze({
  'night-ops': {
    name: 'Night Ops',
    mode: 'night',
    description: 'Low-glare ground station',
    tokens: {
      page: '#0b0e11', surface1: '#151a1f', surface2: '#1d242b',
      ink: '#f5f7f8', ink2: '#c4cbd0', muted: '#89949c',
      grid: '#29323a', baseline: '#3a4650', border: 'rgba(229, 240, 247, 0.13)',
      accent: '#49a6ff', onAccent: '#06111a', button: '#25303a', buttonHover: '#303e49',
      series1: '#49a6ff', series2: '#ff784f', series3: '#38d996', series4: '#f1bd45',
      ringPlanned: '#61b6ff', ringBest: '#48e5a3', windParticle: 'rgba(190, 226, 255, 0.62)',
      statusGood: '#35d07f', statusWarning: '#f1bd45', statusSerious: '#ff875f', statusCritical: '#f05252',
      statusGoodWash: 'rgba(53, 208, 127, 0.12)', overlayScrim: 'rgba(5, 8, 11, 0.76)',
      mapCasing: '#071018', markerBorder: '#ffffff', shadow: 'rgba(0, 0, 0, 0.52)',
      mapFilter: 'invert(0.88)',
    },
  },
  'sun-glare': {
    name: 'Sun Glare',
    mode: 'day',
    description: 'Maximum contrast in direct sun',
    tokens: {
      page: '#ffffff', surface1: '#f4f5f2', surface2: '#e7e9e4',
      ink: '#080b0d', ink2: '#242a2e', muted: '#535c61',
      grid: '#d2d6d1', baseline: '#aab1ad', border: 'rgba(8, 14, 18, 0.22)',
      accent: '#005fcc', onAccent: '#ffffff', button: '#dfe4e1', buttonHover: '#ced6d2',
      series1: '#005fcc', series2: '#b83400', series3: '#00734d', series4: '#7c5700',
      ringPlanned: '#006de5', ringBest: '#008557', windParticle: 'rgba(0, 63, 116, 0.72)',
      statusGood: '#08743f', statusWarning: '#7a5700', statusSerious: '#a43a00', statusCritical: '#b61622',
      statusGoodWash: 'rgba(8, 116, 63, 0.12)', overlayScrim: 'rgba(255, 255, 255, 0.91)',
      mapCasing: '#ffffff', markerBorder: '#ffffff', shadow: 'rgba(10, 18, 22, 0.28)',
      mapFilter: 'none',
    },
  },
  'field-lcd': {
    name: 'Field LCD',
    mode: 'day',
    description: 'Warm daylight instrument panel',
    tokens: {
      page: '#e9ebd9', surface1: '#f7f8e9', surface2: '#dfe3cc',
      ink: '#172019', ink2: '#344037', muted: '#5c695f',
      grid: '#c9cfb9', baseline: '#9fa995', border: 'rgba(23, 32, 25, 0.22)',
      accent: '#006c62', onAccent: '#ffffff', button: '#d4dac5', buttonHover: '#c3ccb5',
      series1: '#006c62', series2: '#a33d16', series3: '#377600', series4: '#795500',
      ringPlanned: '#007d73', ringBest: '#4c8700', windParticle: 'rgba(11, 87, 78, 0.70)',
      statusGood: '#397400', statusWarning: '#7a5900', statusSerious: '#a84717', statusCritical: '#ad2630',
      statusGoodWash: 'rgba(57, 116, 0, 0.12)', overlayScrim: 'rgba(247, 248, 233, 0.91)',
      mapCasing: '#f8ffe9', markerBorder: '#ffffff', shadow: 'rgba(24, 37, 27, 0.27)',
      mapFilter: 'none',
    },
  },
  'race-gate': {
    name: 'Race Gate',
    mode: 'night',
    description: 'Cyan and magenta race feed',
    tokens: {
      page: '#090b16', surface1: '#14172a', surface2: '#1d2138',
      ink: '#f8f6ff', ink2: '#cbc6dc', muted: '#8f89a6',
      grid: '#292d48', baseline: '#414762', border: 'rgba(232, 229, 255, 0.14)',
      accent: '#24d8ff', onAccent: '#001318', button: '#252a46', buttonHover: '#313858',
      series1: '#24d8ff', series2: '#ff4fa3', series3: '#58df86', series4: '#ffd34d',
      ringPlanned: '#31ddff', ringBest: '#65ee91', windParticle: 'rgba(82, 223, 255, 0.62)',
      statusGood: '#58df86', statusWarning: '#ffd34d', statusSerious: '#ff8d5c', statusCritical: '#ff4e6a',
      statusGoodWash: 'rgba(88, 223, 134, 0.12)', overlayScrim: 'rgba(8, 9, 23, 0.78)',
      mapCasing: '#050713', markerBorder: '#ffffff', shadow: 'rgba(0, 0, 0, 0.55)',
      mapFilter: 'invert(0.9) hue-rotate(165deg)',
    },
  },
  'analog-dvr': {
    name: 'Analog DVR',
    mode: 'night',
    description: 'Amber OSD and phosphor green',
    tokens: {
      page: '#10100c', surface1: '#1b1a13', surface2: '#252319',
      ink: '#fff5d6', ink2: '#d8cda9', muted: '#958d72',
      grid: '#312f22', baseline: '#494532', border: 'rgba(255, 239, 189, 0.14)',
      accent: '#ffb627', onAccent: '#1b1000', button: '#302d20', buttonHover: '#403b29',
      series1: '#ffb627', series2: '#ff6b3d', series3: '#82d957', series4: '#55bde8',
      ringPlanned: '#ffc247', ringBest: '#8ee567', windParticle: 'rgba(255, 213, 112, 0.58)',
      statusGood: '#82d957', statusWarning: '#ffc247', statusSerious: '#ff8153', statusCritical: '#ef4f45',
      statusGoodWash: 'rgba(130, 217, 87, 0.11)', overlayScrim: 'rgba(16, 16, 12, 0.79)',
      mapCasing: '#0d0c07', markerBorder: '#fff5d6', shadow: 'rgba(0, 0, 0, 0.55)',
      mapFilter: 'sepia(0.35)',
    },
  },
});

const CSS_NAMES = Object.freeze({
  page: '--page', surface1: '--surface-1', surface2: '--surface-2',
  ink: '--ink', ink2: '--ink-2', muted: '--muted', grid: '--grid',
  baseline: '--baseline', border: '--border', accent: '--accent',
  onAccent: '--on-accent', button: '--button', buttonHover: '--button-hover',
  series1: '--series-1', series2: '--series-2', series3: '--series-3', series4: '--series-4',
  ringPlanned: '--ring-planned', ringBest: '--ring-best', windParticle: '--wind-particle',
  statusGood: '--status-good', statusWarning: '--status-warning',
  statusSerious: '--status-serious', statusCritical: '--status-critical',
  statusGoodWash: '--status-good-wash', overlayScrim: '--overlay-scrim',
  mapCasing: '--map-casing', markerBorder: '--marker-border', shadow: '--shadow',
  mapFilter: '--map-filter',
});

const dayQuery = window.matchMedia?.('(prefers-color-scheme: light)');
let preference = 'auto';
let activeId = null;
let changeHandler = null;

function resolvedId(value) {
  if (value !== 'auto' && THEMES[value]) return value;
  return dayQuery?.matches ? 'sun-glare' : 'night-ops';
}

export function applyTheme(value, { persist = true, notify = true } = {}) {
  preference = value === 'auto' || THEMES[value] ? value : 'auto';
  const id = resolvedId(preference);
  const theme = THEMES[id];
  const root = document.documentElement;
  for (const [key, cssName] of Object.entries(CSS_NAMES)) {
    root.style.setProperty(cssName, theme.tokens[key]);
  }
  root.dataset.theme = id;
  root.dataset.themeMode = theme.mode;
  root.style.colorScheme = theme.mode === 'day' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.tokens.page);
  const select = document.getElementById('sel-theme');
  if (select) select.value = preference;
  if (persist) storeSet('theme', preference);
  const changed = activeId !== id;
  activeId = id;
  if (notify && changed) changeHandler?.(theme, id);
  return theme;
}

export function setupThemes(onChange) {
  changeHandler = onChange;
  const select = document.getElementById('sel-theme');
  if (select) {
    const groups = {
      day: Object.entries(THEMES).filter(([, t]) => t.mode === 'day'),
      night: Object.entries(THEMES).filter(([, t]) => t.mode === 'night'),
    };
    const auto = new Option('Device · day / night', 'auto');
    select.appendChild(auto);
    for (const [mode, entries] of Object.entries(groups)) {
      const group = document.createElement('optgroup');
      group.label = mode === 'day' ? 'Day themes' : 'Night themes';
      for (const [id, theme] of entries) {
        const option = new Option(`${theme.name} · ${theme.description}`, id);
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    select.addEventListener('change', e => applyTheme(e.target.value));
  }
  preference = storeGet('theme', 'auto');
  applyTheme(preference, { persist: false, notify: false });
  dayQuery?.addEventListener?.('change', () => {
    if (preference === 'auto') applyTheme('auto');
  });
}

export function currentTheme() {
  return { preference, id: activeId, theme: THEMES[activeId] };
}
