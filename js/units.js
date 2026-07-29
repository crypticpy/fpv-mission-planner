// units.js — the single display/input boundary between the SI physics model
// and the measurement system selected in the UI.

const MILES_PER_KM = 0.621371;
const SQMI_PER_SQKM = MILES_PER_KM * MILES_PER_KM;
const MS_PER_MPH = 0.44704;
const KPH_PER_MPH = 1.609344;

export const UNIT_SYSTEMS = {
  imperial: {
    id: 'imperial',
    label: 'Imperial · mi / mph',
    distanceUnit: 'mi',
    speedUnit: 'mph',
    burnUnit: 'Wh/mi',
    areaUnit: 'mi²',
    distanceFromKm: km => km * MILES_PER_KM,
    areaFromKm2: km2 => km2 * SQMI_PER_SQKM,
    speedFromMs: ms => ms / MS_PER_MPH,
    speedFromMph: mph => mph,
    speedToMph: mph => mph,
    burnFromWhPerKm: whPerKm => whPerKm / MILES_PER_KM,
    input: {
      manualSpeed: { min: 10, max: 65, step: 1 },
      wind: { min: 0, max: 50, step: 1 },
      gust: { min: 0, max: 70, step: 1 },
    },
  },
  metric: {
    id: 'metric',
    label: 'Metric · km / km/h',
    distanceUnit: 'km',
    speedUnit: 'km/h',
    burnUnit: 'Wh/km',
    areaUnit: 'km²',
    distanceFromKm: km => km,
    areaFromKm2: km2 => km2,
    speedFromMs: ms => ms * 3.6,
    speedFromMph: mph => mph * KPH_PER_MPH,
    speedToMph: kph => kph / KPH_PER_MPH,
    burnFromWhPerKm: whPerKm => whPerKm,
    input: {
      manualSpeed: { min: 15, max: 105, step: 1 },
      wind: { min: 0, max: 80, step: 1 },
      gust: { min: 0, max: 110, step: 1 },
    },
  },
};

export function unitSystem(id) {
  return UNIT_SYSTEMS[id] || UNIT_SYSTEMS.imperial;
}
