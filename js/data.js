// data.js — airframes, batteries, payloads, and mission scenarios.
// Sources: geprc.com product pages, Oscar Liang reviews (measured weights & flight
// logs), Pyrodrone/WREKD/RDQ listings. etaProp is calibrated so the model
// reproduces the real-world flight logs cited in README.md, not a datasheet value.

export const DRONES = [
  {
    id: 'moz7v2',
    name: 'GEPRC MOZ7 V2 O4 Pro',
    tag: '7.5" long range · 6S · XT60',
    dryMassG: 843,          // Oscar Liang measured (claim is 750g — optimistic)
    propDiaIn: 7.5,         // HQ 7.5×3.7×3 stock props
    numRotors: 4,
    ducted: false,
    s: 6,
    connector: 'XT60',
    etaProp: 0.55,          // calibrated: ~16 min / 15+ km on 6S 6000mAh Li-Ion in wind
    cdA: 0.042,             // m², clean airframe
    avionicsW: 10,          // O4 Pro + H743 FC + GPS + RX
    maxSpeedMs: 30.5,       // ~110 km/h reviewer top speed
    motor: 'SPEEDX2 2809 1280KV',
    wheelbaseMm: 336,
  },
  {
    id: 'cinelog30v3',
    name: 'GEPRC Cinelog30 V3 O4 Pro',
    tag: '3" ducted cinewhoop · 4S · XT30',
    dryMassG: 192,          // Oscar Liang measured (claim 187g)
    propDiaIn: 2.99,        // HQProp DT76MMX3 V2 (76 mm)
    numRotors: 4,
    ducted: true,
    s: 4,
    connector: 'XT30',
    etaProp: 0.37,          // calibrated: 8:10 claim on 720mAh, 7–7.5 min real on 850
    cdA: 0.018,             // m², ducts are draggy for the size
    avionicsW: 9,           // O4 Pro + F722 AIO
    maxSpeedMs: 19,         // ~68 km/h practical ceiling for the duct
    motor: 'SPEEDX2 1404 3850KV',
    wheelbaseMm: 128,
  },
];

// estimated:true fields are reasoned estimates (no published measurement found);
// everything else is from vendor pages or reviews. IR values are fresh-pack
// planning numbers — bump them as packs age.
export const BATTERIES = [
  {
    id: 'nav5000',
    name: 'Lumenier NAV 5000 6S Li-Ion',
    short: 'NAV 5000',
    chem: 'liion', s: 6, p: 1,
    capAh: 5.0,
    massG: 499,             // confirmed: Lumenier/GetFPV/RDQ all agree
    irPackMilliOhm: 118,    // 6 × 19.6 mΩ cell DCIR @25°C (Lumenier cell test report)
    maxContA: 35,           // published pack rating (90 A burst)
    connector: 'XT60',
    fits: ['moz7v2'],
    estimated: ['irPackMilliOhm'],
    priceUsd: 96,
  },
  {
    id: 'nav10000',
    name: 'Lumenier NAV 10000 6S Li-Ion',
    short: 'NAV 10000',
    chem: 'liion', s: 6, p: 2,
    capAh: 10.0,
    massG: 975,             // confirmed: Lumenier/GetFPV/RDQ all agree
    irPackMilliOhm: 59,     // 6S2P halves per-cell DCIR (cell test report math)
    maxContA: 70,           // estimated: published 35 A is the 1P figure; 2P doubles it
    connector: 'XT60',
    fits: ['moz7v2'],
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 150,
  },
  {
    id: 'ovonic2200',
    name: 'Ovonic 6S 2200mAh 50C LiPo',
    short: 'Ovonic 2200',
    chem: 'lipo', s: 6, p: 1,
    capAh: 2.2,
    massG: 330,             // estimated: Amazon's "100g" spec is bogus; comparable 6S 2200 packs run 320–362g
    irPackMilliOhm: 50,     // estimated: ~7–10 mΩ/cell for a budget 50C 2200 cell, ×6
    maxContA: 40,           // label 110A; budget-LiPo derating (~18C true continuous)
    connector: 'XT60',
    fits: ['moz7v2'],
    estimated: ['massG', 'irPackMilliOhm', 'maxContA'],
    priceUsd: 31,
  },
  {
    id: 'cnhl2200',
    name: 'CNHL G+Plus 2200mAh 6S 70C LiPo',
    short: 'CNHL 2200',
    chem: 'lipo', s: 6, p: 1,
    capAh: 2.2,
    massG: 396,             // Amazon and ChinaHobbyLine spec pages agree
    irPackMilliOhm: 25,     // estimated: ~3–5 mΩ/cell scaled from sibling G+Plus load test
    maxContA: 65,           // label 154A; sibling G+Plus pack load-tested at ~43% of its claim
    connector: 'XT60',
    fits: ['moz7v2'],
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 40,
  },
  {
    id: 'gnb1100',
    name: 'GNB LiHV 4S 1100mAh 60C',
    short: 'GNB 1100',
    chem: 'lihv', s: 4, p: 1,
    capAh: 1.1,
    massG: 88,              // Pyrodrone/WREKD confirmed
    irPackMilliOhm: 20,     // estimated: small-format 4S LiHV class
    maxContA: 40,           // label 66A; GNB C-ratings are optimistic — derated
    connector: 'XT30',
    fits: ['cinelog30v3'],
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 24,
  },
  {
    id: 'gnb850lr',
    name: 'GNB LiHV 4S 850mAh 60C Long Range',
    short: 'GNB 850 LR',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.85,
    massG: 73,              // WREKD/Pyrodrone confirmed
    irPackMilliOhm: 26,     // estimated: lighter high-density cells run higher IR
    maxContA: 30,
    connector: 'XT30',
    fits: ['cinelog30v3'],
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 22,
  },
  {
    id: 'gnb720',
    name: 'GNB LiHV 4S 720mAh 100C',
    short: 'GNB 720',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.72,
    massG: 72,              // WREKD/Pyrodrone confirmed
    irPackMilliOhm: 16,     // estimated: racing-oriented cells, lower IR
    maxContA: 45,
    connector: 'XT30',
    fits: ['cinelog30v3'],
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 21,
  },
];

export const PAYLOADS = [
  { id: 'none', name: 'No HD camera', massG: 0, cdA: 0 },
  { id: 'naked', name: 'Naked GoPro (~32 g)', massG: 32, cdA: 0.0015 },
  { id: 'gopro', name: 'Full GoPro (~155 g)', massG: 155, cdA: 0.008 },
];

// windMode: which way the outbound leg points relative to the wind.
export const SCENARIOS = [
  {
    id: 'calm', name: 'Calm evening baseline',
    elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windMode: 'headOut',
  },
  {
    id: 'txriver', name: 'Texas river follow',
    elevFt: 500, tempF: 95, rhPct: 55, windMph: 8, gustMph: 13, windMode: 'cross',
  },
  // Austin home-field seasonal presets — Camp Mabry climate normals, typical
  // afternoon flying conditions, ~550 ft field elevation.
  {
    id: 'atxspring', name: 'Austin spring (windy season)',
    elevFt: 550, tempF: 82, rhPct: 62, windMph: 11, gustMph: 21, windMode: 'cross',
  },
  {
    id: 'atxsummer', name: 'Austin summer scorcher',
    elevFt: 550, tempF: 98, rhPct: 44, windMph: 8, gustMph: 14, windMode: 'headOut',
  },
  {
    id: 'atxfall', name: 'Austin fall',
    elevFt: 550, tempF: 82, rhPct: 52, windMph: 7, gustMph: 12, windMode: 'headOut',
  },
  {
    id: 'atxwinter', name: 'Austin winter norther',
    elevFt: 550, tempF: 58, rhPct: 60, windMph: 10, gustMph: 18, windMode: 'headOut',
  },
  {
    id: 'comtn', name: 'Colorado mountain mission',
    elevFt: 10000, tempF: 45, rhPct: 30, windMph: 15, gustMph: 25, windMode: 'headOut',
  },
  {
    id: 'bigbend', name: 'Big Bend cliff dives',
    elevFt: 4500, tempF: 88, rhPct: 25, windMph: 12, gustMph: 18, windMode: 'headOut',
  },
];

const LS_KEY = 'fpv-custom-batteries';

export function loadCustomBatteries() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(b => b && b.id && b.capAh > 0 && b.massG > 0
      && b.s >= 1 && Array.isArray(b.fits) && ['liion', 'lipo', 'lihv'].includes(b.chem)) : [];
  } catch { return []; }
}

export function saveCustomBattery(batt) {
  const list = loadCustomBatteries().filter(b => b.id !== batt.id);
  list.push(batt);
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function deleteCustomBattery(id) {
  localStorage.setItem(LS_KEY, JSON.stringify(loadCustomBatteries().filter(b => b.id !== id)));
}

export function allBatteries() {
  return [...BATTERIES, ...loadCustomBatteries()];
}
