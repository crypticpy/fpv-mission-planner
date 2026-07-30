// catalog/classes.js — airframe class templates.
//
// What this table is for: §6.1's "zero required physics fields". A pilot can
// weigh their rig and count its rotors; nobody can type `etaProp`. Picking a
// class fills every physics field with a starting value and hands the
// calibration code (calibrate.js) the sanity range that decides whether a
// solved fit is believable.
//
// Provenance, in the same spirit as drones.js and batteries.js: exactly two
// rows are anchored to real flight logs — `cinewhoop3` from the Cinelog30 V3
// (etaProp 0.37 / cdA 0.018) and `lr7` from the MOZ7 V2 (0.55 / 0.042), the
// two calibrated built-ins. Every other row is interpolation or extrapolation
// from those two anchors plus general FPV domain knowledge, and says so:
// `confidence: 'estimated'`, with the reasoning written out on the record.
// They are honest starting points to be replaced by a logged flight, not
// measurements.
//
// The efficiency ladder behind the estimates, stated once:
//   - etaProp folds figure of merit, motor/ESC losses, and hover profile drag
//     into one number, so it rises with prop diameter (lower disc loading,
//     better Reynolds number, larger and more efficient motors).
//   - Ducts cost efficiency and add drag: the 3" ducted anchor sits at 0.37
//     while an unducted 4" — barely a size step up — is put near 0.47.
//   - cdA does not follow size cleanly for the same reason. The ducted 3"
//     (0.018 m²) is draggier than a naked 4" (0.016 m²) despite being
//     smaller; the ladder above 5" is frontal area plus the camera/gimbal
//     hanging off the front.
//
// `ranges` is warn-don't-block territory (§6.1: people build weird things) and
// the clamp calibrate.js checks a solved value against. Roughly ±25% around
// the nominal for etaProp, 0.5×–2× for drag and mass.

export const CLASSES = [
  {
    id: 'whoop2',
    label: '2" whoop',
    tag: '2" ducted whoop · 1–4S',
    // Estimated: extrapolated below the 3" ducted anchor. Same ducts, worse
    // Reynolds number, and a 1S–2S power system where ESC and motor losses are
    // a bigger slice of the total — call it three quarters of the Cinelog's η.
    etaProp: 0.28,
    cdA: 0.006,               // area-scaled down from the 3" duct (≈(2/3)²)
    avionicsW: 5,             // small analog or 1S digital VTX + AIO
    cruiseMs: 6,
    maxSpeedMs: 13,
    sMin: 1, sMax: 4,
    propDiaIn: 2,
    numRotors: 4,
    ducted: true,
    confidence: 'estimated',
    anchoredBy: null,
    ranges: {
      etaProp: [0.18, 0.38],
      cdA: [0.003, 0.020],
      avionicsW: [2, 12],
      dryMassG: [15, 150],
      propDiaIn: [1.4, 2.5],
      cruiseMs: [2, 12],
      maxSpeedMs: [6, 22],
    },
  },
  {
    id: 'cinewhoop3',
    label: '3" cinewhoop',
    tag: '3" ducted cinewhoop · 4–6S',
    // Anchor: GEPRC Cinelog30 V3, calibrated against its real flight logs
    // (8:10 claimed on 720 mAh, 7–7.5 min measured on an 850) — see
    // catalog/drones.js and README.md's calibration-anchors table.
    etaProp: 0.37,
    cdA: 0.018,
    avionicsW: 9,             // O4 Pro air unit + AIO FC
    cruiseMs: 9,
    maxSpeedMs: 19,
    sMin: 4, sMax: 6,
    propDiaIn: 3,
    numRotors: 4,
    ducted: true,
    confidence: 'calibrated',
    anchoredBy: 'cinelog30v3',
    ranges: {
      etaProp: [0.26, 0.48],
      cdA: [0.008, 0.040],
      avionicsW: [4, 16],
      dryMassG: [110, 340],
      propDiaIn: [2.5, 3.2],
      cruiseMs: [3, 16],
      maxSpeedMs: [8, 28],
    },
  },
  {
    id: 'mid4',
    label: '3.5–4"',
    tag: '3.5–4" unducted · 4–6S',
    // Estimated: the big jump off the 3" anchor is losing the ducts, not the
    // half-inch of prop — an open 4" prop is worth roughly +0.08 η over a
    // shrouded 3", which lands it just under a 5" freestyle.
    etaProp: 0.47,
    cdA: 0.016,               // smaller frame than a 5", and no duct lip
    avionicsW: 9,
    cruiseMs: 12,
    maxSpeedMs: 25,
    sMin: 4, sMax: 6,
    propDiaIn: 4,
    numRotors: 4,
    ducted: false,
    confidence: 'estimated',
    anchoredBy: null,
    ranges: {
      etaProp: [0.34, 0.58],
      cdA: [0.007, 0.036],
      avionicsW: [4, 16],
      dryMassG: [150, 500],
      propDiaIn: [3.2, 4.4],
      cruiseMs: [4, 20],
      maxSpeedMs: [10, 35],
    },
  },
  {
    id: 'freestyle5',
    label: '5" freestyle',
    tag: '5" freestyle · 4–6S',
    // Estimated: interpolated between the unducted 4" reasoning above and the
    // 7" anchor, nearer the 7" — same class of motors, one prop size down.
    etaProp: 0.50,
    cdA: 0.024,               // GoPro on top and a nose-down cruise attitude:
                              // draggier than its wheelbase alone suggests
    avionicsW: 10,
    cruiseMs: 14,
    maxSpeedMs: 33,           // genuinely faster than a 7" LR rig
    sMin: 4, sMax: 6,
    propDiaIn: 5,
    numRotors: 4,
    ducted: false,
    confidence: 'estimated',
    anchoredBy: null,
    ranges: {
      etaProp: [0.38, 0.62],
      cdA: [0.010, 0.050],
      avionicsW: [5, 20],
      dryMassG: [300, 900],
      propDiaIn: [4.5, 5.5],
      cruiseMs: [5, 25],
      maxSpeedMs: [15, 50],
    },
  },
  {
    id: 'lr7',
    label: '7" long range',
    tag: '7–7.5" long range · 6–8S',
    // Anchor: GEPRC MOZ7 V2, calibrated against ~16 min / 15+ km on a 6S
    // 6000 mAh Li-Ion in wind — see catalog/drones.js and README.md.
    etaProp: 0.55,
    cdA: 0.042,
    avionicsW: 10,            // O4 Pro + H743 + GPS + RX
    cruiseMs: 18,
    maxSpeedMs: 30.5,
    sMin: 6, sMax: 8,
    propDiaIn: 7,
    numRotors: 4,
    ducted: false,
    confidence: 'calibrated',
    anchoredBy: 'moz7v2',
    ranges: {
      etaProp: [0.42, 0.70],
      cdA: [0.020, 0.090],
      avionicsW: [5, 25],
      dryMassG: [550, 1500],
      propDiaIn: [6.0, 8.5],
      cruiseMs: [6, 28],
      maxSpeedMs: [15, 45],
    },
  },
  {
    id: 'cinelifter10',
    label: '10"+ cinelifter',
    tag: '10"+ cinelifter · 6–12S',
    // Estimated: extrapolated above the 7" anchor. Big slow props are the most
    // efficient hover the ladder has, but the payload they exist to carry
    // (cine camera, gimbal, mount) is a wall of drag and its own avionics
    // load — so η goes up and cdA goes up much faster.
    etaProp: 0.60,
    cdA: 0.075,
    avionicsW: 18,            // VTX + gimbal + camera power off the pack
    cruiseMs: 13,
    maxSpeedMs: 22,
    sMin: 6, sMax: 12,
    propDiaIn: 10,
    numRotors: 4,
    ducted: false,
    confidence: 'estimated',
    anchoredBy: null,
    ranges: {
      etaProp: [0.45, 0.75],
      cdA: [0.035, 0.160],
      avionicsW: [8, 45],
      dryMassG: [1200, 6000],
      propDiaIn: [8.5, 18],
      cruiseMs: [4, 25],
      maxSpeedMs: [10, 40],
    },
  },
];

/** Look a template up by id. Undefined for an unknown id — callers decide. */
export function classById(id) {
  return CLASSES.find(c => c.id === id);
}
