// render/comparison.js — the pack shoot-out: radius and time bars for every
// compatible pack, plus the full-detail table behind them.
import { planMission, CHEMISTRY } from '../physics.js';
import { barChart } from '../charts.js';
import {
  state, beginner, units, compatibleBatteries, loadoutBattery, manufacturer, missionInputs,
} from '../state.js';
import { SERIES, f0, f1, mmss, flightLabel } from './format.js';
import { $ } from './dom.js';
import { packCache } from './dashboard.js';

// Out-leg → home-leg burn. The home leg is the one that strands you, so it
// carries the emphasis; an average would hide it entirely.
function burnCell(r, u) {
  if (!r.legs.out || !r.legs.back) return '—';
  const outBurn = u.burnFromWhPerKm(r.legs.out.whPerKm);
  const backBurn = u.burnFromWhPerKm(r.legs.back.whPerKm);
  const frag = document.createDocumentFragment();
  const homeWorse = backBurn >= outBurn;
  const out = document.createElement(homeWorse ? 'span' : 'strong');
  out.textContent = f1(outBurn);
  const back = document.createElement(homeWorse ? 'strong' : 'span');
  back.textContent = f1(backBurn);
  frag.append(out, ' → ', back, ` ${u.burnUnit}`);
  return frag;
}

export function renderComparison() {
  const u = units();
  const batts = compatibleBatteries();
  const runs = batts.map(b => {
    const effective = loadoutBattery(b);
    return { b, effective, r: planMission({ ...missionInputs(b), lite: true, _pCache: packCache(b) }) };
  });
  barChart($('chart-cmp-radius'), {
    items: runs.map(({ b, r }, i) => ({
      label: `${state.parallelPacks ? '2× ' : ''}${b.short || b.name}`, value: u.distanceFromKm(r.radiusKm),
      color: SERIES[i % SERIES.length], note: 'mission radius', invalid: r.flight.code === 'no_lift',
    })),
    valueFmt: v => `${f1(v)} ${u.distanceUnit}`,
  });
  barChart($('chart-cmp-time'), {
    items: runs.map(({ b, r }, i) => ({
      label: `${state.parallelPacks ? '2× ' : ''}${b.short || b.name}`, value: r.timeMin,
      color: SERIES[i % SERIES.length], note: 'flight time', invalid: r.flight.code === 'no_lift',
    })),
    valueFmt: v => mmss(v),
  });

  // table view — hidden in beginner mode, so don't build 16 columns per pack
  if (beginner()) return;
  const tbody = $('cmp-table').querySelector('tbody');
  tbody.replaceChildren();
  for (const { b, effective, r } of runs) {
    const tr = document.createElement('tr');
    tr.classList.toggle('row-invalid', r.flight.code === 'no_lift');
    const cells = [
      manufacturer(b.manufacturerId)?.name || 'Custom',
      `${state.parallelPacks ? '2× ' : ''}${b.name}${b.custom ? ' ·custom' : ''}`,
      [b.cellMaker, b.cellModel].filter(Boolean).join(' '),
      effective.config || `${effective.s}S${effective.p || 1}P`,
      CHEMISTRY[b.chem].label + ` ${b.s}S`,
      `${f0(effective.capAh * 1000)} mAh`,
      `${f1(r.energy.packWh)} Wh`,
      `${f0(effective.massG)} g`,
      `${f0(r.massKg * 1000)} g`,
      `${r.discLoadingGcm2.toFixed(2)} g/cm²`,
      `${r.flight.thrustToWeight.toFixed(2)}:1`,
      flightLabel(r.flight),
      `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit}`,
      mmss(r.timeMin),
      burnCell(r, u),
      effective.priceUsd ? `$${effective.priceUsd}` : '—',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (c instanceof Node) td.appendChild(c);
      else td.textContent = c || '—';
      if (i >= 5) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}
