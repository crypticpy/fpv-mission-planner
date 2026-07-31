import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm } from '../src/domain/geo.js';
import { CLASS_SEVERITY } from '../src/domain/wind/terrain-forcing.js';
import {
  ADVISORY_CLASS_STYLE,
  advisoryZones,
  cellCorners,
  gridOutline,
} from '../src/presentation/map/layers/advisory-layer.js';
import { ageText, legendRows } from '../src/presentation/map/advisory-panel.js';

/* What the mountain-flow advisory looks like, tested without a map.
 *
 * Every failure this file catches is a silent one. A colour that drifts from the
 * severity the rail gives the same finding does not throw — it just tells the
 * pilot two different things on one screen. A cell drawn half a cell off its
 * centre does not throw either; it moves a lee slope onto the ridge next door.
 * And shading a `low` cell would put a green wash over ground the model said
 * nothing about, which is the one claim ADR 0008 forbids outright. */

/* ---------- class → colour ---------- */

test('every forcing class is drawable, and none that the domain does not know', () => {
  assert.deepEqual(
    Object.keys(ADVISORY_CLASS_STYLE).sort(),
    Object.keys(CLASS_SEVERITY).sort());
});

test('the drawn severity is the domain severity, class for class', () => {
  // The layer may not import the domain module that decides this (ADR 0004), so
  // the table is a mirror — and a mirror is only honest while something checks it.
  for (const [classId, severity] of Object.entries(CLASS_SEVERITY)) {
    assert.equal(ADVISORY_CLASS_STYLE[classId].severity, severity, classId);
  }
});

test('one finding is one colour: ridge and gap are drawn identically', () => {
  // They share W-WIND-ACCEL. Two shades would invite a distinction the model
  // never claimed.
  assert.equal(ADVISORY_CLASS_STYLE.ridge.cssVar, ADVISORY_CLASS_STYLE.gap.cssVar);
  assert.deepEqual(ADVISORY_CLASS_STYLE.ridge.rgb, ADVISORY_CLASS_STYLE.gap.rgb);
  assert.equal(ADVISORY_CLASS_STYLE.ridge.fillOpacity, ADVISORY_CLASS_STYLE.gap.fillOpacity);
});

test('low forcing is the one class that is never shaded', () => {
  for (const [classId, style] of Object.entries(ADVISORY_CLASS_STYLE)) {
    assert.equal(style.fill, classId !== 'low', classId);
  }
  assert.equal(ADVISORY_CLASS_STYLE.low.fillOpacity, 0);
});

test('missing data is the one class drawn with a dashed edge', () => {
  for (const [classId, style] of Object.entries(ADVISORY_CLASS_STYLE)) {
    assert.equal(style.dashed, classId === 'unknown', classId);
  }
});

test('every colour carries literal channels for the engine that cannot read a token', () => {
  for (const [classId, style] of Object.entries(ADVISORY_CLASS_STYLE)) {
    assert.ok(style.cssVar.startsWith('--'), classId);
    assert.equal(style.rgb.length, 3, classId);
    for (const channel of style.rgb) {
      assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255, classId);
    }
  }
});

/* ---------- a cell, as a polygon ---------- */

const CENTRE = { lat: 30.2672, lng: -97.7431 };

test('a cell is four corners around its centre, NW first and open', () => {
  const [nw, ne, se, sw] = cellCorners(CENTRE, 200);
  assert.equal(cellCorners(CENTRE, 200).length, 4, 'a polygon closes itself');

  assert.ok(nw.lat > CENTRE.lat && nw.lng < CENTRE.lng, 'north-west');
  assert.ok(ne.lat > CENTRE.lat && ne.lng > CENTRE.lng, 'north-east');
  assert.ok(se.lat < CENTRE.lat && se.lng > CENTRE.lng, 'south-east');
  assert.ok(sw.lat < CENTRE.lat && sw.lng < CENTRE.lng, 'south-west');
});

test('the polygon measures one cell on a side', () => {
  const size = 240;
  const [nw, ne, se] = cellCorners(CENTRE, size);
  // Within a metre over 240: the two-step offset is the sampler's own, and the
  // sphere is not a plane.
  assert.ok(Math.abs(distanceKm(nw, ne) * 1000 - size) < 1, 'the north edge');
  assert.ok(Math.abs(distanceKm(ne, se) * 1000 - size) < 1, 'the east edge');
});

test('the corners sit symmetrically about the centre they came from', () => {
  const [nw, ne, se, sw] = cellCorners(CENTRE, 300);
  // A centimetre: the east–west legs are great circles, so the north pair sits a
  // hair south of a rhumb-line box. Nothing a cell boundary can be read to.
  assert.ok(Math.abs((nw.lat + sw.lat) / 2 - CENTRE.lat) < 1e-7);
  assert.ok(Math.abs((ne.lat + se.lat) / 2 - CENTRE.lat) < 1e-7);
  assert.ok(Math.abs((nw.lng + ne.lng) / 2 - CENTRE.lng) < 1e-7);
});

/* ---------- the sampled area's own edge ---------- */

/**
 * A grid laid out the way sample-grid.js lays one out: row 0 northernmost, col 0
 * westernmost, row-major.
 */
function gridOf(rows, cols, cellSizeM = 200) {
  // One cell of spacing, in degrees: the meridian is the easy one, and the
  // parallel shrinks with the cosine — a fixture that forgets that leaves its
  // columns closer together than the cell size it declares.
  const latStep = (cellSizeM / 1000) / 111;
  const lngStep = latStep / Math.cos((CENTRE.lat * Math.PI) / 180);
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        lat: CENTRE.lat - row * latStep,
        lng: CENTRE.lng + col * lngStep,
        elevM: 300 + row * 10 + col,
      });
    }
  }
  return { rows, cols, cellSizeM, cells };
}

function fieldOf(classIds) {
  const byClass = { uplift: 0, lee: 0, ridge: 0, gap: 0, low: 0, unknown: 0 };
  for (const id of classIds) byClass[id] += 1;
  return {
    cells: classIds.map((classId) => ({
      wStarMs: classId === 'unknown' ? null : 0.4,
      classId,
      severity: CLASS_SEVERITY[classId],
    })),
    meta: {
      counts: {
        total: classIds.length,
        classified: classIds.length - byClass.unknown,
        unknown: byClass.unknown,
        shapeUnavailable: 0,
        byClass,
      },
    },
  };
}

const advisoryOf = (grid, classIds, status = 'ready') => ({
  status, grid, forcing: fieldOf(classIds), regime: null, sensitivity: null, provenance: {},
});

test('the outline is the outer edge of the cells, not a box around their centres', () => {
  const grid = gridOf(2, 3);
  const [nw, ne, se, sw] = gridOutline(grid);

  for (const cell of grid.cells) {
    assert.ok(nw.lat > cell.lat && nw.lng < cell.lng + 1e-9, 'north-west of every centre');
    assert.ok(se.lat < cell.lat && se.lng > cell.lng - 1e-9, 'south-east of every centre');
  }
  // Three cells across, two down, at 200 m each.
  assert.ok(Math.abs(distanceKm(nw, ne) * 1000 - 600) < 6, 'three cells wide');
  assert.ok(Math.abs(distanceKm(nw, sw) * 1000 - 400) < 6, 'two cells deep');
});

/* ---------- which cells are drawn at all ---------- */

test('an advisory short of ready draws nothing', () => {
  const grid = gridOf(1, 2);
  assert.equal(advisoryZones(advisoryOf(grid, ['lee', 'low'], 'pending')), null);
  assert.equal(advisoryZones(advisoryOf(grid, ['lee', 'low'], 'unavailable')), null);
  assert.equal(advisoryZones(null), null);
  assert.equal(advisoryZones(undefined), null);
});

test('a ready advisory with nothing behind it draws nothing either', () => {
  assert.equal(advisoryZones({ status: 'ready', grid: null, forcing: null }), null);
  assert.equal(advisoryZones({ status: 'ready', grid: gridOf(1, 2), forcing: null }), null);
});

test('a grid that disagrees with its own dimensions is not drawable', () => {
  // The classes are addressed row-major by index. A count that does not match
  // rows × cols means those indices name different cells in the two arrays,
  // which would paint findings onto the wrong ground rather than fail.
  const grid = gridOf(2, 2);
  assert.equal(advisoryZones(advisoryOf(grid, ['lee', 'low', 'low'])), null, 'short field');
  assert.equal(advisoryZones({
    status: 'ready',
    grid: { ...grid, cells: grid.cells.slice(0, 3) },
    forcing: fieldOf(['lee', 'low', 'low', 'low']),
  }), null, 'short grid');
});

test('hazard, advisory and unknown cells are filled; low cells are not', () => {
  const grid = gridOf(2, 3);
  const zones = advisoryZones(advisoryOf(grid,
    ['lee', 'low', 'ridge', 'gap', 'uplift', 'unknown']));

  assert.deepEqual(zones.fills.map((f) => f.index), [0, 2, 3, 4, 5]);
  assert.deepEqual(zones.fills.map((f) => f.classId),
    ['lee', 'ridge', 'gap', 'uplift', 'unknown']);
});

test('a filled cell carries the ground it was classified from', () => {
  const grid = gridOf(2, 2);
  const zones = advisoryZones(advisoryOf(grid, ['low', 'low', 'low', 'lee']));
  const fill = zones.fills[0];

  assert.equal(fill.index, 3);
  assert.equal(fill.lat, grid.cells[3].lat);
  assert.equal(fill.lng, grid.cells[3].lng);
  assert.equal(fill.elevM, grid.cells[3].elevM);
  assert.deepEqual(fill.corners, cellCorners(grid.cells[3], grid.cellSizeM));
});

test('a cell with no elevation is still drawn — missing is not clear', () => {
  const grid = gridOf(1, 2);
  grid.cells[1].elevM = null;
  const zones = advisoryZones(advisoryOf(grid, ['low', 'unknown']));

  assert.equal(zones.fills.length, 1);
  assert.equal(zones.fills[0].classId, 'unknown');
  assert.equal(zones.fills[0].elevM, null, 'and it says so rather than standing in a number');
});

test('an area the model found quiet still gets its boundary drawn', () => {
  // Nothing shaded and nothing said would be indistinguishable from an advisory
  // that never ran, which is the confusion the outline exists to prevent.
  const zones = advisoryZones(advisoryOf(gridOf(2, 2), ['low', 'low', 'low', 'low']));
  assert.deepEqual(zones.fills, []);
  assert.equal(zones.outline.length, 4);
});

/* ---------- the key to all of it ---------- */

test('the legend keys the marks that are on screen, in severity order', () => {
  const rows = legendRows(advisoryOf(gridOf(2, 3),
    ['lee', 'low', 'ridge', 'gap', 'uplift', 'unknown']));

  assert.deepEqual(rows.map((r) => r.classId), ['lee', 'ridge', 'uplift', 'unknown']);
  // ridge and gap are one row under one swatch, counted together.
  assert.deepEqual(rows.map((r) => r.count), [1, 2, 1, 1]);
});

test('a class with no cells is left out, and low never appears at all', () => {
  const rows = legendRows(advisoryOf(gridOf(1, 3), ['low', 'low', 'lee']));
  assert.deepEqual(rows.map((r) => r.classId), ['lee']);
  assert.deepEqual(rows.map((r) => r.count), [1]);
});

test('no field, no legend', () => {
  assert.deepEqual(legendRows(null), []);
  assert.deepEqual(legendRows({ status: 'pending', forcing: null }), []);
});

/* ---------- how old the answer is ---------- */

test('an absent timestamp is stated, never rendered as fresh', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.equal(ageText(null, now), 'not recorded');
  assert.equal(ageText('', now), 'not recorded');
  assert.equal(ageText('not a date', now), 'not recorded');
});

test('age is reported in the coarsest unit that still says something', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.equal(ageText('2026-07-30T11:58:00Z', now), '2 min ago');
  assert.equal(ageText('2026-07-30T06:00:00Z', now), '6 h ago');
  assert.equal(ageText('2026-07-27T12:00:00Z', now), '3 days ago');
  // A clock a few seconds behind the provider's is not evidence of anything.
  assert.equal(ageText('2026-07-30T12:00:30Z', now), 'just now');
});
