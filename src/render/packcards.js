// render/packcards.js — the Batteries page's library of physical packs (E-02).
// One card per stored copy of the selected pack model, plus a Catalog-spec card
// for flying the model as recorded. The cards are the face of the hidden
// #sel-pack-instance select, the same seam the E-01 aircraft cards use on
// #sel-drone: Fly writes the select and fires its change event, so selection,
// persistence and the footnote under the plan all run through the fold's own
// handler. Authoring stays in the fold below — a card shows a pack, it does
// not edit one.
//
// Under the cards, the parallel-pairing strip surfaces pairingCheck() for the
// packs on this shelf: anchored on the pack the plan is flying when one is
// chosen ("what can ride shotgun with this one"), every pair otherwise. The
// verdict is honest by construction — it exists only when both packs carry a
// measured resistance, and the render adds no numbers of its own.
import { packCard } from '../components/pack-card.js';
import {
  instancesForBattery, selectedInstanceId, highCycleCount, pairingCheck,
} from '../packinstances.js';
import { catalogBattery } from '../state.js';
import { CHEMISTRY } from '../domain/physics.js';
import { f0, f1 } from './format.js';
import { $ } from './dom.js';

const VERDICT_WORD = {
  ready: 'Parallel ready', caution: 'Caution', avoid: 'Avoid', unknown: 'Unknown',
};

// A comparison across a big bench-temperature gap is weaker than its delta
// suggests (resistance rises as a pack cools); past this skew the row says so.
const TEMP_SKEW_NOTE_C = 10;

function flySelect(instanceId) {
  const sel = /** @type {HTMLSelectElement} */ ($('sel-pack-instance'));
  sel.value = instanceId || '';
  sel.dispatchEvent(new Event('change'));
}

function instanceStats(inst) {
  const cycles = Number.isFinite(inst.cycleCount) ? `${f0(inst.cycleCount)} cycles` : null;
  const ir = Number.isFinite(inst.irPackMilliOhm)
    ? `IR ${f1(inst.irPackMilliOhm)} mΩ${Number.isFinite(inst.irTempC) ? ` at ${f0(inst.irTempC)} °C` : ''}`
    : 'no IR measured';
  return [cycles, ir].filter(Boolean).join(' · ');
}

function pairSentence(a, b, check) {
  const names = `${a.label} + ${b.label}`;
  if (check.verdict === 'unknown') {
    return `${names} — measure both packs’ resistance and this becomes a verdict.`;
  }
  let s = `${names} — ΔIR ${f1(check.deltaMilliOhm)} mΩ (${f0(check.deltaPct)}%).`;
  if (check.harderId && check.verdict !== 'ready') {
    const harder = check.harderId === a.id ? a : b;
    s += ` ${harder.label} would carry about ${f0(check.extraSharePct)}% more than its share.`;
  }
  if (check.tempSkewC != null && check.tempSkewC >= TEMP_SKEW_NOTE_C) {
    s += ` The readings were taken ${f0(check.tempSkewC)} °C apart — a cold pack reads high,`
      + ' so this delta is softer than it looks.';
  }
  return s;
}

function renderPairing(list, selectedId) {
  const strip = $('pack-pairing');
  const host = $('pack-pairing-rows');
  strip.hidden = list.length < 2;
  if (strip.hidden) { host.replaceChildren(); return; }
  const anchor = list.find(i => i.id === selectedId) || null;
  const pairs = anchor
    ? list.filter(i => i.id !== anchor.id).map(o => [anchor, o])
    : list.flatMap((a, i) => list.slice(i + 1).map(b => [a, b]));
  host.replaceChildren(...pairs.map(([a, b]) => {
    const check = pairingCheck(a, b);
    const row = document.createElement('div');
    row.className = 'pairrow';
    const chip = document.createElement('span');
    chip.className = `pairverdict ${check.verdict}`;
    chip.textContent = VERDICT_WORD[check.verdict];
    const text = document.createElement('span');
    text.textContent = pairSentence(a, b, check);
    row.append(chip, text);
    return row;
  }));
}

export function renderPackCards() {
  const host = $('pack-cards');
  const batt = catalogBattery();
  // No pack fits this rig at all — the NO PACK verdict already says so, and
  // there is no shelf to draw copies of.
  if (!batt) {
    host.replaceChildren();
    $('pack-pairing').hidden = true;
    return;
  }
  const list = instancesForBattery(batt.id);
  const selectedId = selectedInstanceId(batt.id);
  const modelLine = `${batt.s}S ${CHEMISTRY[batt.chem].label} · ${f0(batt.capAh * 1000)} mAh`;
  const planningOnSpec = !list.some(i => i.id === selectedId);
  const cards = [
    packCard({
      label: 'Catalog spec',
      model: modelLine,
      stats: `IR ${f1(batt.irPackMilliOhm)} mΩ as recorded for the model`,
      warn: '',
      measured: false,
      planned: planningOnSpec,
      onFly: () => { flySelect(null); },
    }),
    ...list.map(inst => packCard({
      label: inst.label,
      model: modelLine,
      stats: instanceStats(inst),
      warn: highCycleCount(batt.chem, inst.cycleCount)
        ? `${f0(inst.cycleCount)} cycles is a lot for a ${CHEMISTRY[batt.chem].label} pack — `
          + 'expect less than the label capacity, and re-measure its resistance.'
        : '',
      measured: Number.isFinite(inst.irPackMilliOhm),
      planned: inst.id === selectedId,
      onFly: () => { flySelect(inst.id); },
    })),
  ];
  host.replaceChildren(...cards);
  renderPairing(list, selectedId);
}
