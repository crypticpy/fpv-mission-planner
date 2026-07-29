// render/format.js — the display vocabulary shared by the render modules:
// number and duration formatting, compass points, and the short labels that
// name a state in the pilot's words.

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
export const f0 = (x) => x != null && isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
export const f1 = (x) => x != null && isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : '—';

// Pilots fly the OSD clock, not a decimal minute. Durations render mm:ss, and
// only grow an hours field if something absurd asks for one.
export const mmss = (min) => {
  if (min == null || !isFinite(min) || min < 0) return '—';
  const s = Math.round(min * 60);
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
// The model plans on 80 m wind; the pilot standing at the launch point feels
// roughly half of it. Rule of thumb, labeled as one wherever it prints.
export const surfaceMph = (aloftMph) => aloftMph / 2;

export function flightLabel(flight) {
  if (flight.code === 'no_lift') return 'WILL NOT FLY';
  if (flight.code === 'no_control_margin') return 'NO CONTROL MARGIN';
  if (flight.code === 'marginal') return 'MARGINAL';
  return 'VIABLE';
}

const ESTIMATED_LABELS = {
  massG: 'pack weight',
  capAh: 'capacity',
  irPackMilliOhm: 'pack internal resistance',
  maxContA: 'continuous current limit',
  priceUsd: 'price',
  connector: 'connector',
};

export function estimatedPhrase(keys) {
  const names = keys.map(k => ESTIMATED_LABELS[k] || k);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return list.charAt(0).toUpperCase() + list.slice(1);
}
