// thrust.js — read a pasted bench or manufacturer thrust table and keep the one
// number worth keeping: measured maximum thrust per motor (§6.1's "optional
// pasted thrust table that overrides the momentum-theory lift ceiling"). Pure:
// no DOM, no storage, no physics.
//
// §7.4 is explicit that this is not a thrust-curve database. Nothing here is
// interpolated, stored per row, or handed to the flight model — the rows are
// read, the peak thrust is taken, and the rest is thrown away. The lift ceiling
// is the model's shakiest inversion, so a measured figure replaces it; keeping
// the curve would only invite a second flight model nobody asked for.
//
// Tolerant on purpose. Pilots paste out of vendor PDFs, HTML tables and
// spreadsheets, so rows arrive separated by tabs, commas, pipes or runs of
// spaces, with units glued onto the numbers and the header spelled a dozen
// ways. Every failure is soft and comes back as a sentence: the form shows what
// was understood and never blocks a save on it.

// A bare number, with an optional unit stuck to it ("420", "1.842kg", "50%").
const TOKEN = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-zµ%°/]*)$/i;

// Column vocabulary. Only `thrust` is wanted; the rest are named so a labeled
// column is never mistaken for one — a current column of three-digit values
// would otherwise read as grams.
const HEADER_WORDS = [
  [/thrust|pull|lift|force/, 'thrust'],
  [/throttle|duty/, 'throttle'],
  [/rpm|speed/, 'rpm'],
  [/amp|current/, 'current'],
  [/watt|power|input/, 'power'],
  [/volt/, 'voltage'],
  [/effic|g\/w|gf\/w/, 'efficiency'],
  [/temp/, 'temp'],
];

// Mass units a thrust table is ever published in, as grams.
const MASS_UNITS = {
  g: 1, gf: 1, gram: 1, grams: 1, gm: 1,
  kg: 1000, kgf: 1000, kgs: 1000,
  lb: 453.592, lbs: 453.592, lbf: 453.592,
  oz: 28.3495, ozf: 28.3495,
};

// A thrust figure outside this is not one: 5 g is below any motor worth
// benching, and 100 kg per motor is a typo or a units mix-up.
const MIN_G = 5;
const MAX_G = 100000;

const fail = (message) => ({
  ok: false, maxThrustG: null, nRows: 0, columnIndex: null, columnCount: 0,
  unit: null, source: null, message,
});

/** Split a row into fields: tabs, commas, pipes, semicolons or runs of spaces. */
function splitRow(line) {
  const hard = line.split(/[\t,;|]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
  return hard.length > 1 ? hard : line.split(/\s+/).filter(Boolean);
}

/** One field → `{ value, unit }`, or null when it isn't a number at all. */
function readCell(field) {
  const m = TOKEN.exec(field.replace(/[()[\]]/g, '').trim());
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, unit: m[2].toLowerCase() } : null;
}

/**
 * Which column holds thrust, and in what unit. Four ways of knowing, in
 * descending order of how much the table actually told us:
 *
 *   'header'      — a column labeled thrust / pull / lift
 *   'unit'        — a column whose numbers carry g, kg, lb or oz
 *   'two-column'  — throttle then thrust, the commonest bare paste
 *   'one-column'  — the thrust column on its own
 *
 * Anything else is refused rather than guessed at: picking the largest column
 * out of five unlabeled ones would happily return an RPM figure as grams.
 */
function findThrustColumn(headers, rows, columnCount) {
  if (headers) {
    for (let i = 0; i < headers.length && i < columnCount; i++) {
      const word = HEADER_WORDS.find(([re]) => re.test(headers[i].text));
      if (word && word[1] === 'thrust') {
        return { index: i, unit: headers[i].unit || null, source: 'header' };
      }
    }
  }
  for (let i = 0; i < columnCount; i++) {
    const units = rows.map(r => r[i].unit).filter(Boolean);
    if (units.length && units.length === rows.length && units.every(u => u === units[0] && u in MASS_UNITS)) {
      return { index: i, unit: units[0], source: 'unit' };
    }
  }
  if (columnCount === 2) return { index: 1, unit: null, source: 'two-column' };
  if (columnCount === 1) return { index: 0, unit: null, source: 'one-column' };
  return null;
}

/** Header text plus whatever unit was written beside it: "Thrust (kg)". */
function readHeader(line) {
  const fields = splitRow(line);
  if (fields.length && fields.every(f => readCell(f))) return null; // all numbers: a data row
  return fields.map(f => ({
    text: f.toLowerCase(),
    unit: (/\(?\s*([a-z]+)\s*\)?\s*$/i.exec(f)?.[1] || '').toLowerCase(),
  }));
}

/**
 * Parse `text` as a thrust table.
 *
 * Returns `{ ok, maxThrustG, nRows, columnIndex, columnCount, unit, source,
 * message }`. `maxThrustG` is per motor, in grams, whatever the table was
 * written in. `message` is the sentence to show the pilot either way — what was
 * understood, or what to change so it can be.
 */
export function parseThrustTable(text) {
  const src = typeof text === 'string' ? text : '';
  const lines = src.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return fail('');

  let headers = null;
  const rows = [];
  for (const line of lines) {
    const fields = splitRow(line);
    const cells = fields.map(readCell);
    if (cells.length && cells.every(Boolean)) { rows.push(cells); continue; }
    // The first non-numeric line is the header; later ones are footnotes and
    // unit rows, and are dropped rather than argued with.
    if (!headers) headers = readHeader(line);
  }
  if (!rows.length) {
    return fail('No rows of numbers in there — paste the table itself, one row per throttle step.');
  }

  // The modal row width is the table; anything narrower or wider is a footnote,
  // a total, or a wrapped line.
  const widths = new Map();
  for (const r of rows) widths.set(r.length, (widths.get(r.length) || 0) + 1);
  const columnCount = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const kept = rows.filter(r => r.length === columnCount);

  const col = findThrustColumn(headers, kept, columnCount);
  if (!col) {
    return fail(`Found ${kept.length} rows of ${columnCount} numbers, but nothing says which column is `
      + 'thrust — keep the header row (a column named "thrust"), write the unit on the numbers '
      + '(420 g), or paste just the throttle and thrust columns.');
  }

  const unit = col.unit && col.unit in MASS_UNITS ? col.unit : 'g';
  const scale = MASS_UNITS[unit];
  const peak = Math.max(...kept.map(r => r[col.index].value));
  const maxThrustG = peak * scale;
  if (!(maxThrustG >= MIN_G) || maxThrustG > MAX_G) {
    return fail(`That column peaks at ${peak}${unit === 'g' ? ' g' : ' ' + unit}, which is not a thrust `
      + 'figure for one motor — check the units, and that the column really is thrust.');
  }

  const how = col.source === 'header' ? `the labeled thrust column`
    : col.source === 'unit' ? `the column written in ${unit}`
    : col.source === 'two-column' ? 'the second column (throttle, then thrust)'
    : 'the single column pasted';
  return {
    ok: true,
    maxThrustG,
    nRows: kept.length,
    columnIndex: col.index,
    columnCount,
    unit,
    source: col.source,
    message: `Read ${kept.length} row${kept.length === 1 ? '' : 's'} from ${how} — `
      + `peak ${Math.round(maxThrustG).toLocaleString('en-US')} g of thrust per motor.`,
  };
}
