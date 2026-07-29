// catalog/payloads.js — HD camera payloads.
// Ready-to-record camera weights include the battery and built-in mounting
// fingers where the manufacturer publishes them that way. DJI Action 2 is the
// self-contained camera unit; HERO10 Bones includes its protective lens cover
// and is powered by the aircraft. Camera drag is not published, so these three
// CdA classes remain planning estimates based on the camera envelope.
const CAMERA_CDA = {
  naked: 0.0015,
  compact: 0.004,
  standard: 0.008,
  large: 0.010,
};

export const PAYLOADS = [
  { id: 'none', name: 'No HD camera', massG: 0, cdA: 0 },
  { id: 'naked', name: 'Naked GoPro · ~32 g', massG: 32, cdA: CAMERA_CDA.naked },
  { id: 'gopro', name: 'Generic full-size action camera · ~155 g', massG: 155, cdA: CAMERA_CDA.standard },

  // GoPro HERO Black flagships, from HERO7 through the current HERO13.
  { id: 'gopro-hero7-black', name: 'GoPro HERO7 Black · 116 g', massG: 116, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero8-black', name: 'GoPro HERO8 Black · 126 g', massG: 126, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero9-black', name: 'GoPro HERO9 Black · 158 g', massG: 158, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero10-black', name: 'GoPro HERO10 Black · 153 g', massG: 153, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero11-black', name: 'GoPro HERO11 Black · 154 g', massG: 154, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero12-black', name: 'GoPro HERO12 Black · 154 g', massG: 154, cdA: CAMERA_CDA.standard },
  { id: 'gopro-hero13-black', name: 'GoPro HERO13 Black · 159 g', massG: 159, cdA: CAMERA_CDA.standard },

  // GoPro specialty and current-line cameras.
  { id: 'gopro-hero10-bones', name: 'GoPro HERO10 Black Bones · 60 g', massG: 60, cdA: CAMERA_CDA.compact },
  { id: 'gopro-hero11-mini', name: 'GoPro HERO11 Black Mini · 133 g', massG: 133, cdA: CAMERA_CDA.compact },
  { id: 'gopro-hero-2024', name: 'GoPro HERO (2024) · 86 g', massG: 86, cdA: CAMERA_CDA.compact },
  { id: 'gopro-lit-hero', name: 'GoPro LIT HERO · 93 g', massG: 93, cdA: CAMERA_CDA.compact },
  { id: 'gopro-max', name: 'GoPro MAX · 154 g', massG: 154, cdA: CAMERA_CDA.standard },
  { id: 'gopro-max2', name: 'GoPro MAX2 · 195 g', massG: 195, cdA: CAMERA_CDA.large },
  { id: 'gopro-mission-1', name: 'GoPro MISSION 1 · 207 g', massG: 207, cdA: CAMERA_CDA.large },
  { id: 'gopro-mission-1-pro', name: 'GoPro MISSION 1 PRO · 207 g', massG: 207, cdA: CAMERA_CDA.large },

  // Complete DJI Osmo Action line through the current Action 6.
  { id: 'dji-osmo-action', name: 'DJI Osmo Action · 124 g', massG: 124, cdA: CAMERA_CDA.standard },
  { id: 'dji-action-2', name: 'DJI Action 2 camera unit · 56 g', massG: 56, cdA: CAMERA_CDA.compact },
  { id: 'dji-osmo-action-3', name: 'DJI Osmo Action 3 · 145 g', massG: 145, cdA: CAMERA_CDA.standard },
  { id: 'dji-osmo-action-4', name: 'DJI Osmo Action 4 · 145 g', massG: 145, cdA: CAMERA_CDA.standard },
  { id: 'dji-osmo-action-5-pro', name: 'DJI Osmo Action 5 Pro · 146 g', massG: 146, cdA: CAMERA_CDA.standard },
  { id: 'dji-osmo-action-6', name: 'DJI Osmo Action 6 · 149 g', massG: 149, cdA: CAMERA_CDA.standard },
];
