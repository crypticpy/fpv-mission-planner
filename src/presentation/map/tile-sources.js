// tile-sources.js — the raster endpoints both map engines draw, and their credits.
//
// Two engines now ask for the same imagery: Leaflet in 2D and MapLibre in the
// lazy 3D scene (ADR 0004). Neither may import the other — leaflet-adapter.js
// carries the vendored Leaflet bundle and scene3d/ carries ~442 kB of WebGL that
// must stay out of the shell — so the URLs and the attribution strings live here,
// in a module with no imports at all, rather than being copied into both.
//
// An attribution is not a comment. Every string below is rendered by whichever
// engine is drawing the tiles: Leaflet through its own attribution control,
// MapLibre through the `attribution` field on each source. Changing an endpoint
// without moving its credit line with it is the failure this file exists to make
// impossible.

/**
 * Esri World Imagery. `maxNativeZoom` (Leaflet) / `maxzoom` (MapLibre) is where
 * the imagery actually stops; both engines are allowed to keep zooming past it
 * on upscaled tiles, which is what makes a launch point placeable on a driveway.
 */
export const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION =
  'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
/** Where Esri's own imagery ends and upscaling begins. */
export const SATELLITE_MAX_NATIVE_ZOOM = 19;

export const STREETS_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const STREETS_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * AWS Terrain Tiles, terrarium-encoded (`elevation_m = R*256 + G + B/256 - 32768`).
 *
 * Public, key-free and the only DEM raster this app can reach without an account.
 * 256 px tiles, and the pyramid genuinely stops at z15 — asking for z16 returns
 * nothing, so `maxzoom` is a fact about the dataset rather than a preference.
 */
export const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_DEM_ATTRIBUTION = 'Terrain: Mapzen/AWS Terrain Tiles';
export const TERRAIN_DEM_MAX_ZOOM = 15;
export const TERRAIN_DEM_TILE_SIZE = 256;

/**
 * One terrarium pixel, as metres above sea level.
 *
 * MapLibre applies this itself (`encoding: 'terrarium'` on the DEM source), so
 * for the 3D scene the formula above stays a comment. The orthographic view
 * decodes the same tiles in the page — a height grid it can query analytically is
 * what makes a pick against terrain trustworthy (ADR 0004 wave C) — and a second
 * transcription of four constants is exactly the kind of difference that would
 * put the two views on different mountains. So the formula has one home, here,
 * beside the endpoint it belongs to.
 *
 * No range checking: the inputs are three bytes off a canvas, every triple is a
 * valid elevation somewhere between −32,768 m and +8,388,607 m, and there is no
 * value in that range this function could reject as wrong. A decode error is not
 * subtle — a wrong encoding puts a summit at −32,000 m.
 *
 * @param {number} r @param {number} g @param {number} b
 * @returns {number} metres MSL
 */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}
