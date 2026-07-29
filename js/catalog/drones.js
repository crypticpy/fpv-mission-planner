// catalog/drones.js — airframes.
// Sources: geprc.com product pages, Oscar Liang reviews (measured weights & flight
// logs), Pyrodrone/WREKD/RDQ listings. etaProp is calibrated so the model
// reproduces the real-world flight logs cited in README.md, not a datasheet value.

export const DRONES = [
  {
    id: 'moz7v2',
    name: 'GEPRC MOZ7 V2 O4 Pro',
    short: 'MOZ7 V2',        // compact label for one-line summaries
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
    // GEPRC publishes 1,148.9 W / 49.35 A per motor, but no thrust curve.
    // Lift is therefore inferred from the calibrated rotor model and marked
    // estimated in the UI rather than presented as thrust-stand data.
    propulsion: {
      motorMaxW: 1148.9,
      motorMaxA: 49.35,
      escMaxA: 65,
      confidence: 'estimated',
      sourceLabel: 'GEPRC motor electrical limits',
      sourceUrl: 'https://geprc.com/product/geprc-speedx2-2809-1280kv-motor/',
    },
    parallelHarnessMassG: 20, // planning allowance: XT60 parallel lead + restraint
    parallelPackCdA: 0.003,   // estimated extra frontal area for the second pack
    wheelbaseMm: 336,
  },
  {
    id: 'cinelog30v3',
    name: 'GEPRC Cinelog30 V3 O4 Pro',
    short: 'Cinelog30 V3',   // compact label for one-line summaries
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
    // GEPRC does not publish the 3850KV variant's electrical table. The value
    // is bracketed by its published 3000KV/4600KV variants (160–180 W).
    propulsion: {
      motorMaxW: 170,
      motorMaxA: 12,
      escMaxA: 45,
      confidence: 'estimated',
      sourceLabel: 'GEPRC adjacent-variant electrical limits',
      sourceUrl: 'https://geprc.com/product/geprc-speedx2-1404-3000kv-4600kv-motor/',
    },
    parallelHarnessMassG: 8,  // planning allowance: XT30 parallel lead + restraint
    parallelPackCdA: 0.001,   // estimated extra frontal area for the second pack
    wheelbaseMm: 128,
  },
];
