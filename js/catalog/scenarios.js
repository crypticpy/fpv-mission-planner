// catalog/scenarios.js — flight scenarios.
// Flight scenarios — how you fly, not where. speedFactor scales the airframe's
// realistic cruise speed (cruiseMs); overheadFactor multiplies cruise power for
// the stick work the pattern demands beyond steady straight-line flight.
export const SCENARIOS = [
  {
    id: 'longrange', name: 'Long-range cruise',
    speedFactor: 1.0, overheadFactor: 1.05,
    desc: 'Steady out-and-back at your normal cruise pace. Minimal stick work.',
  },
  {
    id: 'river', name: 'River / terrain follow',
    speedFactor: 0.55, overheadFactor: 1.12,
    desc: 'Slow cinematic tracking with constant small corrections.',
  },
  {
    id: 'cliffdive', name: 'Cliff dives & proximity',
    speedFactor: 0.85, overheadFactor: 1.40,
    desc: 'Dives, climb-outs, and throttle punches burn well beyond steady cruise.',
  },
  {
    id: 'training', name: 'Training laps',
    speedFactor: 0.9, overheadFactor: 1.25,
    desc: 'Pattern work and drills — frequent throttle changes, always near home.',
  },
];
