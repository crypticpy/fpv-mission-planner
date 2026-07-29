// catalog/weather.js — environment presets.
// Weather presets — the environment only (place + season). Route orientation
// relative to the wind is a mission choice and lives in the Mission controls.
// windFromDeg is the meteorological direction the wind blows FROM, degrees
// clockwise from true north — it orients the map footprint, not the dashboard.
export const WEATHER = [
  {
    id: 'calm', name: 'Calm evening baseline',
    elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windFromDeg: 170,
  },
  // Austin home-field seasonal presets — Camp Mabry climate normals, typical
  // afternoon flying conditions, ~550 ft field elevation. Prevailing winds are
  // southerly off the Gulf except the winter norther.
  {
    id: 'atxspring', name: 'Austin spring (windy season)',
    elevFt: 550, tempF: 82, rhPct: 62, windMph: 11, gustMph: 21, windFromDeg: 170,
  },
  {
    id: 'atxsummer', name: 'Austin summer scorcher',
    elevFt: 550, tempF: 98, rhPct: 44, windMph: 8, gustMph: 14, windFromDeg: 175,
  },
  {
    id: 'atxfall', name: 'Austin fall',
    elevFt: 550, tempF: 82, rhPct: 52, windMph: 7, gustMph: 12, windFromDeg: 165,
  },
  {
    id: 'atxwinter', name: 'Austin winter norther',
    elevFt: 550, tempF: 58, rhPct: 60, windMph: 10, gustMph: 18, windFromDeg: 350,
  },
  {
    id: 'comtn', name: 'Colorado mountains (10,000 ft)',
    elevFt: 10000, tempF: 45, rhPct: 30, windMph: 15, gustMph: 25, windFromDeg: 270,
  },
  {
    id: 'bigbend', name: 'Big Bend desert',
    elevFt: 4500, tempF: 88, rhPct: 25, windMph: 12, gustMph: 18, windFromDeg: 155,
  },
];
