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

// A thrust ratio, or an em dash when there isn't one. A pilot-added airframe has
// no motor or ESC limits on record, so liftEnvelope() answers `unknown` with an
// infinite ceiling — honest inside the model, nonsense on screen. "Infinity:1"
// would read as a promise; "—" reads as the truth, which is that we don't know.
export const ratio = (x) => (x != null && isFinite(x) ? `${x.toFixed(2)}:1` : '—');

const COMPASS =['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
// The model plans on 80 m wind; the pilot standing at the launch point feels
// roughly half of it. Rule of thumb, labeled as one wherever it prints.
export const surfaceMph = (aloftMph) => aloftMph / 2;

// A lift ceiling is momentum theory's guess unless the pilot pasted a bench
// table, in which case calling it "estimated" in a don't-fly verdict is a lie
// about the one number they measured themselves.
export const liftSource = (flight) => (flight?.estimated === false ? 'measured' : 'estimated');

// §6.1's three tiers in the pilot's words. Used wherever a number's provenance
// is shown: a datasheet figure is neither a guess nor something anyone measured,
// and reading it as "estimated" undersells it while "measured" oversells it.
const CONFIDENCE_WORDS = {
  measured: 'measured',
  datasheet: 'from the datasheet',
  estimated: 'estimated',
  unknown: 'unknown',
};
export const confidenceWord = (c) => CONFIDENCE_WORDS[c] || 'estimated';

export function flightLabel(flight) {
  // No propulsion block on the airframe: the energy side of the plan is real,
  // the lift ceiling is simply unmodeled, and saying so beats inventing a verdict.
  if (flight.code === 'unknown') return 'LIFT UNKNOWN';
  if (flight.code === 'no_lift') return 'WILL NOT FLY';
  if (flight.code === 'no_control_margin') return 'NO CONTROL MARGIN';
  if (flight.code === 'marginal') return 'MARGINAL';
  return 'VIABLE';
}

/**
 * The §6.2 hero band: "(7.9–8.8, from your 11 flights)". `band` is drift.js's
 * `{ loKm, hiKm, nFlights }` already converted to display units by the caller,
 * which is why this takes plain numbers.
 *
 * Returns '' when the two ends round to the same figure — a range of "8.4–8.4"
 * claims a precision the fit doesn't have, and the bare headline already says
 * that much.
 */
export function bandPhrase(lo, hi, nFlights) {
  if (lo == null || hi == null || !isFinite(lo) || !isFinite(hi)) return '';
  const a = f1(lo);
  const b = f1(hi);
  if (a === b) return '';
  const n = nFlights > 0 ? `, from your ${nFlights} flight${nFlights === 1 ? '' : 's'}` : '';
  return `(${a}–${b}${n})`;
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
