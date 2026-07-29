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
    cruiseMs: 18,           // realistic hands-on cruise: Oscar Liang flies 60–70 km/h
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
    cruiseMs: 9,            // realistic cinewhoop cruise ~30–35 km/h
    motor: 'SPEEDX2 1404 3850KV',
    wheelbaseMm: 128,
  },
];

// Pack builders/brands are separate from cell makers. This lets one custom
// builder (for example DIY500AMP) expose several cell recipes under one filter.
export const MANUFACTURERS = [
  { id: 'lumenier', name: 'Lumenier', kind: 'brand', url: 'https://www.getfpv.com/' },
  { id: 'ovonic', name: 'Ovonic', kind: 'brand', url: 'https://www.ampow.com/' },
  { id: 'cnhl', name: 'CNHL', kind: 'brand', url: 'https://chinahobbyline.com/' },
  { id: 'gnb', name: 'GNB / Gaoneng', kind: 'brand', url: 'https://www.gaoneng.shop/' },
  { id: 'custom', name: 'Ungrouped custom', kind: 'custom-builder' },
  {
    id: 'diy500amp',
    name: 'DIY500AMP',
    kind: 'custom-builder',
    url: 'https://diy500amp.com/products/6s2p-21700-tabless-drone-edf-jet-battery-pack-0-3mm-copper-high-performance',
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
    manufacturerId: 'lumenier',
    cellMaker: 'Lumenier',
    cellModel: 'INR21700-50SE',
    config: '6S1P',
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
    manufacturerId: 'lumenier',
    cellMaker: 'Lumenier',
    cellModel: 'INR21700-50SE',
    config: '6S2P',
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
    manufacturerId: 'ovonic',
    cellMaker: 'Ovonic',
    cellModel: '50C pouch',
    config: '6S1P',
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
    manufacturerId: 'cnhl',
    cellMaker: 'CNHL',
    cellModel: 'G+Plus 70C pouch',
    config: '6S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 40,
  },
  {
    id: 'gnb5500',
    name: 'GNB 6S 5500mAh 70C LiPo',
    short: 'GNB 5500',
    chem: 'lipo', s: 6, p: 1,
    capAh: 5.5,
    massG: 656,             // GNB product page: 656 g ±20 g
    irPackMilliOhm: 12,     // estimated: fresh large-format 6S LiPo planning value
    maxContA: 80,           // conservative system-level derating; label claim is 385 A
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '70C pouch',
    config: '6S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 94,
  },
  {
    id: 'gnb7000',
    name: 'GNB 6S 7000mAh 70C LiPo',
    short: 'GNB 7000',
    chem: 'lipo', s: 6, p: 1,
    capAh: 7.0,
    massG: 797,             // GNB product page: 797 g ±25 g
    irPackMilliOhm: 10,     // estimated: fresh large-format 6S LiPo planning value
    maxContA: 90,           // conservative system-level derating; label claim is 490 A
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '70C pouch',
    config: '6S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 114,
  },
  {
    id: 'diy500amp-eve40pl',
    name: 'DIY500AMP 6S2P · EVE 40PL',
    short: 'EVE 40PL',
    chem: 'liion', s: 6, p: 2,
    capAh: 8.0,
    massG: 859,             // 12 × 67 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 17,     // 6S2P math from ≤5 mΩ/cell + construction allowance
    maxContA: 80,           // conservative: 40 A/cell planning load
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'EVE',
    cellModel: 'INR21700/40PL',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'maxContA', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-jp40',
    name: 'DIY500AMP 6S2P · Ampace JP40',
    short: 'JP40',
    chem: 'liion', s: 6, p: 2,
    capAh: 8.0,
    massG: 895,             // 12 × 70 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 14,
    maxContA: 90,           // 2 × 45 A unconditional cell rating
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'Ampace',
    cellModel: 'JP40 / 21700A',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-eve50pl',
    name: 'DIY500AMP 6S2P · EVE 50PL',
    short: 'EVE 50PL',
    chem: 'liion', s: 6, p: 2,
    capAh: 10.0,
    massG: 871,             // 12 × 68 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 17,
    maxContA: 100,          // derated below the 2 × 70 A datasheet ceiling
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'EVE',
    cellModel: 'INR21700/50PL',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'maxContA', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-tenpower50xg',
    name: 'DIY500AMP 6S2P · Tenpower 50XG',
    short: '50XG',
    chem: 'liion', s: 6, p: 2,
    capAh: 10.0,
    massG: 907,             // 12 × 71 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 14,
    maxContA: 80,           // 2 × 40 A unconditional cell rating
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'Tenpower',
    cellModel: 'INR21700-50XG',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-rs50',
    name: 'DIY500AMP 6S2P · Reliance RS50',
    short: 'RS50',
    chem: 'liion', s: 6, p: 2,
    capAh: 10.0,
    massG: 859,             // 12 × 67 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 14,
    maxContA: 100,          // derated below the temperature-limited cell ceiling
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'Reliance',
    cellModel: 'INR21700-RS50',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'maxContA', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-jp50p1',
    name: 'DIY500AMP 6S2P · Ampace JP50P1',
    short: 'JP50P1',
    chem: 'liion', s: 6, p: 2,
    capAh: 10.0,
    massG: 919,             // 12 × 72 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 14,
    maxContA: 80,           // 2 × 40 A unconditional cell rating
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'Ampace',
    cellModel: 'JP50P1',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-linkdata55p',
    name: 'DIY500AMP 6S2P · LinkData 55P',
    short: 'LinkData 55P',
    chem: 'liion', s: 6, p: 2,
    capAh: 11.0,
    massG: 901,             // estimated 70.5 g/cell + 55 g pack hardware
    irPackMilliOhm: 20,     // conservative pending a matched manufacturer datasheet
    maxContA: 60,           // conservative pending unconditional cell rating
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'LinkData',
    cellModel: 'INR21700S-55P',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'maxContA', 'priceUsd'],
    priceUsd: 195,
  },
  {
    id: 'diy500amp-linkdata65p',
    name: 'DIY500AMP 6S2P · LinkData 65P',
    short: 'LinkData 65P',
    chem: 'liion', s: 6, p: 2,
    capAh: 13.0,
    massG: 897,             // 12 × 70.2 g cells + 55 g estimated pack hardware
    irPackMilliOhm: 16,
    maxContA: 80,           // conservative below the 2 × 52 A datasheet ceiling
    connector: 'XT60',
    fits: ['moz7v2'],
    manufacturerId: 'diy500amp',
    cellMaker: 'LinkData',
    cellModel: 'INR21700S-65P',
    config: '6S2P',
    estimated: ['massG', 'irPackMilliOhm', 'maxContA', 'priceUsd'],
    priceUsd: 195,
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
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '60C LiHV pouch',
    config: '4S1P',
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
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '60C LR LiHV pouch',
    config: '4S1P',
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
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '100C LiHV pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 21,
  },
];

export const PAYLOADS = [
  { id: 'none', name: 'No HD camera', massG: 0, cdA: 0 },
  { id: 'naked', name: 'Naked GoPro (~32 g)', massG: 32, cdA: 0.0015 },
  { id: 'gopro', name: 'Full GoPro (~155 g)', massG: 155, cdA: 0.008 },
];

// Weather presets — the environment only (place + season). Route orientation
// relative to the wind is a mission choice and lives in the Mission controls.
export const WEATHER = [
  {
    id: 'calm', name: 'Calm evening baseline',
    elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5,
  },
  // Austin home-field seasonal presets — Camp Mabry climate normals, typical
  // afternoon flying conditions, ~550 ft field elevation.
  {
    id: 'atxspring', name: 'Austin spring (windy season)',
    elevFt: 550, tempF: 82, rhPct: 62, windMph: 11, gustMph: 21,
  },
  {
    id: 'atxsummer', name: 'Austin summer scorcher',
    elevFt: 550, tempF: 98, rhPct: 44, windMph: 8, gustMph: 14,
  },
  {
    id: 'atxfall', name: 'Austin fall',
    elevFt: 550, tempF: 82, rhPct: 52, windMph: 7, gustMph: 12,
  },
  {
    id: 'atxwinter', name: 'Austin winter norther',
    elevFt: 550, tempF: 58, rhPct: 60, windMph: 10, gustMph: 18,
  },
  {
    id: 'comtn', name: 'Colorado mountains (10,000 ft)',
    elevFt: 10000, tempF: 45, rhPct: 30, windMph: 15, gustMph: 25,
  },
  {
    id: 'bigbend', name: 'Big Bend desert',
    elevFt: 4500, tempF: 88, rhPct: 25, windMph: 12, gustMph: 18,
  },
];

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

const LS_KEY = 'fpv-custom-batteries';
const MFR_LS_KEY = 'fpv-custom-manufacturers';

export function loadCustomManufacturers() {
  try {
    const raw = JSON.parse(localStorage.getItem(MFR_LS_KEY) || '[]');
    return Array.isArray(raw)
      ? raw.filter(m => m && m.id && m.name).map(m => ({
          ...m, custom: true, kind: 'custom-builder',
          url: typeof m.url === 'string' && /^https?:\/\//i.test(m.url) ? m.url : null,
        }))
      : [];
  } catch { return []; }
}

export function saveCustomManufacturer(manufacturer) {
  const list = loadCustomManufacturers().filter(m => m.id !== manufacturer.id);
  list.push({ ...manufacturer, custom: true, kind: 'custom-builder' });
  localStorage.setItem(MFR_LS_KEY, JSON.stringify(list));
}

export function deleteCustomManufacturer(id) {
  localStorage.setItem(MFR_LS_KEY, JSON.stringify(loadCustomManufacturers().filter(m => m.id !== id)));
}

export function allManufacturers() {
  return [...MANUFACTURERS, ...loadCustomManufacturers()];
}

export function loadCustomBatteries() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(b => b && b.id && b.capAh > 0 && b.massG > 0
      && b.s >= 1 && Array.isArray(b.fits) && ['liion', 'lipo', 'lihv'].includes(b.chem))
      .map(b => ({
        ...b,
        manufacturerId: b.manufacturerId || 'custom',
        config: b.config || `${b.s}S${b.p || 1}P`,
      })) : [];
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
