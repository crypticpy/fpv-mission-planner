// render/aircraftcards.js — the Aircraft page's library of airframes (E-01).
// The cards are the face of the hidden #sel-drone select: a card's Use press
// writes the select and fires its change event, so every side effect the old
// dropdown had — the pack re-pick, the swap notice, the loadout command —
// runs through the same handler it always did. Nothing here mutates state.
//
// Each card's ConfidenceBadge is computed exactly the way the calibration
// surfaces compute it for the flying airframe: the calibrated record (the
// overlay, when its switch is on), that record's fit, and the drift of its
// logged cruise legs. The badge on an unselected card answers "what would I
// be flying if I pressed Use" — provenance and error of that rig's numbers,
// not the current one's.
import { aircraftCard } from '../components/aircraft-card.js';
import { modelConfidence } from '../confidence.js';
import { fitForDrone, calibratedDrone } from '../flightlog.js';
import { driftPoints, driftSummary } from '../drift.js';
import { allDrones, allBatteries } from '../registry.js';
import { state, units } from '../state.js';
import { f0 } from './format.js';
import { $ } from './dom.js';

export function renderAircraftCards() {
  const u = units();
  const packs = allBatteries();
  const cards = allDrones().map((d) => {
    const flying = calibratedDrone(d);
    const fit = fitForDrone(d);
    const drift = driftSummary(driftPoints({ drone: flying, solves: fit.solves, batteries: packs }));
    return aircraftCard({
      name: d.name,
      tag: d.tag ?? '',
      specs: `${f0(d.dryMassG)} g dry · cruise ${f0(u.speedFromMs(d.cruiseMs))} ${u.speedUnit}`
        + ` · top ${f0(u.speedFromMs(d.maxSpeedMs))} ${u.speedUnit}`,
      confidence: modelConfidence({ drone: flying, fit, drift }),
      flying: d.id === state.droneId,
      onUse: () => {
        const sel = /** @type {HTMLSelectElement} */ ($('sel-drone'));
        sel.value = d.id;
        sel.dispatchEvent(new Event('change'));
      },
    });
  });
  $('aircraft-cards').replaceChildren(...cards);
}
