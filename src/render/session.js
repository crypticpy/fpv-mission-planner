// render/session.js — the field session planner: how many of each pack the
// pilot is bringing, and what that adds up to at the field.
import { planMission } from '../physics.js';
import { state, compatibleBatteries, missionInputs } from '../state.js';
import { mmss } from './format.js';
import { $ } from './dom.js';
import { packCache } from './dashboard.js';

/* ---------- session planner ---------- */

// Session planner: how many of each compatible pack the pilot is bringing to
// the field today. Ephemeral by design — not part of `state`, never saved to
// localStorage, so it never fights the persisted loadout on reload.
const sessionCounts = new Map(); // batteryId -> pack count (0-8)
let sessionSeeded = false; // seed the selected pack to 1 exactly once, ever

// Same per-pack plan every compatible battery gets in the shoot-out: reuses
// packCache(b) (already warmed by renderComparison this same update() pass)
// via the identical lite/_pCache options, so no new sweep is added here.
function sessionRowsData() {
  return compatibleBatteries().map(b => {
    const count = sessionCounts.get(b.id) || 0;
    const r = planMission({ ...missionInputs(b), lite: true, _pCache: packCache(b) });
    const viable = r.flight.code !== 'no_lift';
    return { b, count, perMin: viable ? r.timeMin : 0, viable };
  });
}

function renderSessionTotals(rows) {
  const totalPacks = rows.reduce((s, x) => s + x.count, 0);
  const totalMin = rows.reduce((s, x) => s + x.perMin * x.count, 0);
  const el = $('sesh-totals');
  if (totalPacks === 0) {
    el.textContent = 'Set how many of each pack you’re bringing.';
    el.classList.add('sesh-empty');
    return;
  }
  el.classList.remove('sesh-empty');
  // Every pack swap/landing costs a couple minutes at the field; round the
  // plan up to a friendly 5-minute figure so it reads like a field plan, not
  // a stopwatch total.
  const fieldMin = Math.ceil((totalMin + totalPacks * 2) / 5) * 5;
  el.textContent = `${totalPacks} pack${totalPacks === 1 ? '' : 's'} → ${mmss(totalMin)} total airtime · plan ~${fieldMin} min at the field`;
}

/**
 * Rebuilds the pack-count rows, unless the pilot is mid-keystroke in one of
 * them — rebuilding would steal focus and the caret. The totals line and the
 * row's own subtotal still update live via the input's own listener, so the
 * skipped rebuild never reads as stale.
 */
export function renderSessionPlanner() {
  if (!sessionSeeded) {
    sessionCounts.set(state.batteryId, 1);
    sessionSeeded = true;
  }
  const rows = sessionRowsData();
  const host = $('sesh-rows');
  const typing = document.activeElement?.classList?.contains('sesh-count')
    && host.contains(document.activeElement);
  if (!typing) {
    host.replaceChildren();
    for (const { b, count, perMin, viable } of rows) {
      const row = document.createElement('div');
      row.className = 'sesh-row';
      row.classList.toggle('sesh-invalid', !viable);
      const name = document.createElement('span');
      name.className = 'sesh-name';
      name.textContent = b.short || b.name;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sesh-count';
      input.min = '0';
      input.max = '8';
      input.step = '1';
      input.value = String(count);
      input.setAttribute('aria-label', `${b.name} pack count`);
      const per = document.createElement('span');
      per.className = 'sesh-per';
      per.textContent = viable ? mmss(perMin) : '—';
      const sub = document.createElement('span');
      sub.className = 'sesh-sub';
      sub.textContent = count > 0 && viable ? mmss(perMin * count) : '—';
      input.addEventListener('input', () => {
        // Browsers don't enforce max on typed values (same clamp as in-extra).
        const v = Math.min(8, Math.max(0, Math.round(+input.value) || 0));
        sessionCounts.set(b.id, v);
        sub.textContent = v > 0 && viable ? mmss(perMin * v) : '—';
        renderSessionTotals(sessionRowsData());
      });
      row.append(name, input, per, sub);
      host.appendChild(row);
    }
  }
  renderSessionTotals(rows);
}
