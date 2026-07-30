// catalog/batteries.js — battery packs.
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
    id: 'gnb550',
    name: 'GNB LiHV 4S 550mAh 120C',
    short: 'GNB 550',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.55,
    massG: 53,              // MyFPVStore listing: 53 g ±3 g
    irPackMilliOhm: 24,     // estimated: small high-rate 4S LiHV planning value
    maxContA: 35,           // label 66 A; derated for repeatable pack life
    connector: 'XT30',
    fits: ['cinelog30v3'],
    manufacturerId: 'gnb',
    cellMaker: 'GNB',
    cellModel: '120C LiHV pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
  },
  {
    id: 'rdq650',
    name: 'RDQ Series LiHV 4S 650mAh 60C',
    short: 'RDQ 650',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.65,
    massG: 60.6,            // RDQ product page
    irPackMilliOhm: 22,     // estimated: small-format 4S LiHV class
    maxContA: 35,           // label 39 A; modest derating for repeatable use
    connector: 'XT30',
    fits: ['cinelog30v3'],
    manufacturerId: 'rdq',
    cellMaker: 'RDQ',
    cellModel: '60C LiHV pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 22.49,
  },
  {
    id: 'geprc720',
    name: 'GEPRC LiHV 4S 720mAh 100C',
    short: 'GEPRC 720',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.72,
    massG: 72,              // GEPRC product page
    irPackMilliOhm: 18,     // estimated: high-rate 4S LiHV planning value
    maxContA: 40,           // label 72 A; conservatively derated
    connector: 'XT30',
    fits: ['cinelog30v3'],
    manufacturerId: 'geprc',
    cellMaker: 'GEPRC',
    cellModel: '100C LiHV pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 18.99,
  },
  {
    id: 'flywoo750',
    name: 'Flywoo Explorer LiHV 4S 750mAh 80C',
    short: 'Flywoo 750',
    chem: 'lihv', s: 4, p: 1,
    capAh: 0.75,
    massG: 66.9,            // Flywoo product page
    irPackMilliOhm: 20,     // estimated: high-density 4S LiHV planning value
    maxContA: 40,           // label 60 A; conservatively derated
    connector: 'XT30',
    fits: ['cinelog30v3'],
    manufacturerId: 'flywoo',
    cellMaker: 'Flywoo',
    cellModel: 'Explorer 80C LiHV pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 18,           // $35.99 two-pack at time of research
  },
  {
    id: 'tattu850',
    name: 'Tattu R-Line 4S 850mAh 95C',
    short: 'Tattu 850',
    chem: 'lipo', s: 4, p: 1,
    capAh: 0.85,
    massG: 104,             // Tattu dealer listings agree
    irPackMilliOhm: 14,     // estimated: premium high-rate LiPo planning value
    maxContA: 50,           // label 80.75 A; derated below the C-rating claim
    connector: 'XT30',
    fits: ['cinelog30v3'],
    manufacturerId: 'tattu',
    cellMaker: 'Tattu',
    cellModel: 'R-Line 95C pouch',
    config: '4S1P',
    estimated: ['irPackMilliOhm', 'maxContA'],
    priceUsd: 19.99,
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
