// catalog/cameras.js — camera profile presets (ADR 0011 §2).
// Each entry is a scene.cameraProfile-shaped record ({ name, sensorWidthMm,
// sensorHeightMm, focalLengthMm, stabilized }) plus a catalog `id` for
// selection, the same pattern payloads.js and weather.js use. Sensor
// dimensions are the published physical sensor size for the class named;
// focal lengths are nominal actual (not 35mm-equivalent) lens numbers for a
// representative field of view in that class — planning estimates, not a
// specific SKU's measured figure. `stabilized` means built-in EIS/OIS on the
// camera itself, not a gimbal mount.
export const CAMERAS = [
  {
    id: 'gopro-action', name: 'GoPro HERO-class action camera',
    sensorWidthMm: 6.17, sensorHeightMm: 4.63, focalLengthMm: 3.0, stabilized: true,
  },
  {
    id: 'dji-o3-air-unit', name: 'DJI O3 Air Unit-class FPV camera',
    sensorWidthMm: 7.7, sensorHeightMm: 5.8, focalLengthMm: 2.3, stabilized: true,
  },
  {
    id: 'one-inch-compact', name: '1-inch compact cinema camera',
    sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalLengthMm: 8.8, stabilized: true,
  },
  {
    id: 'micro-four-thirds', name: 'Micro Four Thirds cinema camera',
    sensorWidthMm: 17.3, sensorHeightMm: 13.0, focalLengthMm: 12.5, stabilized: false,
  },
  {
    id: 'apsc-mirrorless', name: 'APS-C mirrorless camera',
    sensorWidthMm: 23.5, sensorHeightMm: 15.6, focalLengthMm: 16.0, stabilized: false,
  },
  {
    id: 'full-frame-mirrorless', name: 'Full-frame mirrorless camera',
    sensorWidthMm: 36.0, sensorHeightMm: 24.0, focalLengthMm: 24.0, stabilized: false,
  },
];
