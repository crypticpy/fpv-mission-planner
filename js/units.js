// units.js — the single display/input boundary between the SI physics model
// and the measurement system selected in the UI.

const MILES_PER_KM = 0.621371;
const SQMI_PER_SQKM = MILES_PER_KM * MILES_PER_KM;
const MS_PER_MPH = 0.44704;
const KPH_PER_MPH = 1.609344;

/**
 * The min/max/step a rail input takes in this system.
 *
 * @typedef {object} UnitRange
 * @property {number} min
 * @property {number} max
 * @property {number} step
 */

/**
 * One measurement system: the labels the UI prints, the conversions in and out
 * of the model's internal units (km, m/s, Wh/km, metres), and the input ranges
 * the rail's number fields and sliders take.
 *
 * @typedef {object} UnitSystem
 * @property {string} id
 * @property {string} label
 * @property {string} distanceUnit
 * @property {string} speedUnit
 * @property {string} burnUnit
 * @property {string} areaUnit
 * @property {string} altUnit
 * @property {(m: number) => number} altFromM
 * @property {(km: number) => number} distanceFromKm
 * @property {(d: number) => number} distanceToKm
 * @property {(km2: number) => number} areaFromKm2
 * @property {(ms: number) => number} speedFromMs
 * @property {(mph: number) => number} speedFromMph
 * @property {(v: number) => number} speedToMph
 * @property {(whPerKm: number) => number} burnFromWhPerKm
 * @property {{ manualSpeed: UnitRange, wind: UnitRange, gust: UnitRange }} input
 */

/** @type {Record<string, UnitSystem>} */
export const UNIT_SYSTEMS = {
  imperial: {
    id: 'imperial',
    label: 'Imperial · mi / mph',
    distanceUnit: 'mi',
    speedUnit: 'mph',
    burnUnit: 'Wh/mi',
    areaUnit: 'mi²',
    // Altitudes and elevations, which this app has always shown in feet on the
    // imperial side (the rail's elevation field, the density-altitude tile) — the
    // terrain profile reads them out of the model in metres and needs the pair.
    altUnit: 'ft',
    altFromM: m => m / 0.3048,
    distanceFromKm: km => km * MILES_PER_KM,
    distanceToKm: mi => mi / MILES_PER_KM,
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
    altUnit: 'm',
    altFromM: m => m,
    distanceFromKm: km => km,
    distanceToKm: km => km,
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

/**
 * @param {string} id
 * @returns {UnitSystem}
 */
export function unitSystem(id) {
  return UNIT_SYSTEMS[id] || UNIT_SYSTEMS.imperial;
}
