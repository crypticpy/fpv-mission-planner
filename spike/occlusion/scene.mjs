// Fixture geometry for the ADR 0004 rendering spike.
//
// One module, three consumers: the tile generator (node), the spike page
// (browser, via vite) and the Playwright spec (node). Every number the proofs
// depend on is here, so the page cannot drift from what the spec asserts.
//
// The surfaces are the tests/terrain-gate.test.mjs shapes — a flat-topped ridge
// 140 m above launch between 1.3 and 1.7 km out, and a valley falling 90 m
// below launch at 1.5 km — lifted from a 1-D function of "distance along the
// route" into a 2-D function of an east/north offset from Austin. The ridge is
// given a finite north/south extent (a 1.2 km wall, not an infinite one) purely
// so the occlusion proof gets its own control: the same path, at the same
// altitude and nearly the same range, must be VISIBLE where it passes the end
// of the wall and HIDDEN where the wall intervenes. "Not drawn at all" and
// "correctly occluded" are otherwise the same picture.

/** Austin, matching tests/terrain-gate.test.mjs. */
export const ORIGIN = Object.freeze({ lat: 30.2672, lng: -97.7431 });

/** Launch-site ground elevation, MSL. Same constant as the terrain gate. */
export const BASE_ELEV_M = 168;

/** Flat-topped ridge crest, MSL. */
export const RIDGE_CREST_M = BASE_ELEV_M + 140;

// A local flat projection, exactly invertible, centred on ORIGIN. Over the
// +/-8 km the fixture spans, the error against a real geodesic is centimetres —
// and it does not matter at all, because the *same* function defines both the
// terrain the tiles encode and the path coordinates the page draws. The one
// property that must hold is invertibility, so the tile generator can ask "what
// is the offset of this pixel" and get back what the page put there.
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** East/north offset in km from ORIGIN -> [lng, lat]. */
export function offsetToLngLat(dxKm, dyKm) {
  return [
    ORIGIN.lng + (dxKm * 1000) / M_PER_DEG_LNG,
    ORIGIN.lat + (dyKm * 1000) / M_PER_DEG_LAT,
  ];
}

/** [lng, lat] -> east/north offset in km from ORIGIN. */
export function lngLatToOffset(lng, lat) {
  return {
    dxKm: ((lng - ORIGIN.lng) * M_PER_DEG_LNG) / 1000,
    dyKm: ((lat - ORIGIN.lat) * M_PER_DEG_LAT) / 1000,
  };
}

/**
 * Ground elevation, MSL, as a function of the offset from ORIGIN.
 *
 * Both are deliberately sharp-ish in x and cheap to evaluate: the generator
 * calls these ~5.6 million times per surface.
 */
export const SURFACES = Object.freeze({
  ridge: (dxKm, dyKm) => (
    dxKm >= 1.3 && dxKm <= 1.7 && Math.abs(dyKm) <= 0.6 ? RIDGE_CREST_M : BASE_ELEV_M
  ),
  valley: (dxKm) => BASE_ELEV_M - 90 * Math.exp(-((dxKm - 1.5) ** 2) / 0.05),
});

/**
 * The DEM pyramid the generator writes and the style declares.
 *
 * `bounds` keeps MapLibre from requesting the thousands of tiles a 70-degree
 * pitch would otherwise put inside the frustum; everything the probes touch is
 * far inside it. maxZoom 14 is ~8 m/DEM-pixel at this latitude, which resolves
 * the 400 m ridge into ~50 samples — plenty, and it caps the tile count at a
 * few hundred instead of a few thousand.
 */
export const TILES = Object.freeze({
  minZoom: 11,
  maxZoom: 14,
  halfSpanKm: 8,
  size: 256,
});

/**
 * `[west, south, east, north]` for the generated pyramid — the same numbers the
 * generator loops over and the style's `bounds` declares.
 */
export const DEM_BOUNDS = Object.freeze([
  ...offsetToLngLat(-TILES.halfSpanKm, -TILES.halfSpanKm),
  ...offsetToLngLat(TILES.halfSpanKm, TILES.halfSpanKm),
]);

/** Pure magenta: the path colour. Nothing in the terrain palette is near it. */
export const PATH_COLOR = Object.freeze([255, 0, 255]);

/** A pixel counts as "the path" only if it is unambiguously magenta. */
export function isPathPixel(r, g, b) {
  return r >= 200 && g <= 70 && b >= 200;
}

/**
 * The background layer's colour — everything the terrain does not cover.
 *
 * The terrain is painted by a raster layer of the very same terrarium tiles the
 * DEM reads, so a ground pixel's red channel is `floor((elev + 32768) / 256)`,
 * which is 128-130 for every elevation this fixture produces and can therefore
 * never be mistaken for magenta. It also means "not sky" is an exact test for
 * "terrain covers this pixel", which is what lets a probe say the path is
 * hidden *by terrain* rather than merely missing.
 */
export const SKY_COLOR = Object.freeze([0x8f, 0xb8, 0xde]);

/** Within rounding of the background colour, i.e. no terrain and no path here. */
export function isSkyPixel(r, g, b) {
  return (
    Math.abs(r - SKY_COLOR[0]) <= 4
    && Math.abs(g - SKY_COLOR[1]) <= 4
    && Math.abs(b - SKY_COLOR[2]) <= 4
  );
}

/**
 * The three scenes, each a complete description of what the page must build.
 *
 * `camera.pitch`/`zoom` are not arbitrary: for the occlusion scene they set the
 * eye altitude, and the eye altitude is what decides whether the sightline over
 * the crest clears the path behind it. See the note on that scene.
 *
 * `graze` (the two above-* scenes only) drives the strongest assertion the
 * spike makes. Re-rendering the same path `marginM` below a known terrain
 * height must make it vanish at `buriedProbe`, and `marginM` above must bring
 * it back — while `clearProbe` stays visible in both frames to prove the layer
 * rendered at all. Whether a pixel survives is decided entirely by MapLibre's
 * terrain depth buffer, so agreement pins deck.gl's absolute MSL scale against
 * MapLibre's own terrain without trusting either library's projection maths.
 *
 * `marginM` is 60 rather than something tighter because the ribbon is
 * billboarded at a fixed 14 screen pixels: at these cameras that quad spans
 * roughly 70 m of world height, so a path 30 m under the surface still leaks
 * its topmost row. 60 m clears it. The measurement is sharper than the margin
 * suggests — at exactly `surfaceM` the terrain cuts the ribbon clean in half,
 * which the spec also asserts.
 */
export const SCENES = Object.freeze({
  // Proof 1a — explicit MSL Z renders ABOVE a ridge, not at sea level.
  // Camera south of the ridge looking north, so the path runs left-to-right
  // across the screen and an altitude error shows up purely as a vertical
  // offset at the same screen column.
  'above-ridge': {
    surface: 'ridge',
    camera: { center: offsetToLngLat(1.5, 0.3), zoom: 14.2, bearing: 0, pitch: 70 },
    path: { altM: RIDGE_CREST_M + 120, fromKm: [0.2, 0], toKm: [2.8, 0], steps: 130 },
    probes: [
      // Directly over the ridge crest: 120 m of air under the path, 428 m of air
      // under it if deck.gl were to ignore Z and drop the line to sea level.
      { id: 'crest', atKm: [1.5, 0], expect: 'visible' },
      // …and over the flat ground west of the ridge, where the same constant-MSL
      // path is 200 m up.
      { id: 'flat', atKm: [0.6, 0], expect: 'visible' },
    ],
    // See the note on `graze` above. Straddling the 308 m crest turns "above the
    // terrain" into an absolute measurement against MapLibre's own depth buffer,
    // with the flat column as an in-frame positive control.
    graze: { surfaceM: RIDGE_CREST_M, marginM: 60, buriedProbe: 'crest', clearProbe: 'flat' },
  },

  // Proof 1b — the same, over a valley. The interesting failure here is not sea
  // level but *draping*: a renderer that clamps the path to the terrain surface
  // would drop it 130 m at the valley floor.
  'above-valley': {
    surface: 'valley',
    camera: { center: offsetToLngLat(1.5, 0.3), zoom: 14.2, bearing: 0, pitch: 70 },
    path: { altM: BASE_ELEV_M + 90, fromKm: [0.2, 0], toKm: [2.8, 0], steps: 130 },
    probes: [
      // Over the deepest point: 180 m of air under the path. A renderer that
      // draped the line on the terrain would drop it the full 180 m here while
      // leaving the `rim` probe 90 m up — the two probes together separate
      // "draped" from "at sea level" from "correct".
      { id: 'floor', atKm: [1.5, 0], expect: 'visible' },
      { id: 'rim', atKm: [0.6, 0], expect: 'visible' },
    ],
    // Straddles the 168 m rim instead of the floor, so that the same frame that
    // buries the path at the rim still shows it flying 60 m over the floor.
    graze: { surfaceM: BASE_ELEV_M, marginM: 60, buriedProbe: 'rim', clearProbe: 'floor' },
  },

  // Proof 2 — occlusion. Camera west of the wall looking east, pitched.
  //
  // Geometry, all MSL: the eye sits ~765 m above the launch plane (zoom 16 at
  // 30.27N is 2.07 m/px; MapLibre's camera-to-centre distance is 1.5 * viewport
  // height, so 1080 px * 2.07 = 2236 m, times cos(70) for the vertical leg) and
  // ~2.1 km west of centre. The sightline that grazes the crest (308 m at
  // dx=1.7) therefore falls at (308-933)/3.8 = -165 m/km, putting it at 267 m
  // where the path is. The path flies at 188 m — 79 m under that sightline, and
  // 120 m under the crest. It cannot be seen through the wall.
  //
  // Laterally the wall's shadow at the path's range is ~0.64 km either side of
  // centre, so dy=0 is deep inside it and dy=+/-1.5 km is clearly outside.
  occlusion: {
    surface: 'ridge',
    camera: { center: offsetToLngLat(0, 0), zoom: 16, bearing: 90, pitch: 70 },
    path: { altM: BASE_ELEV_M + 20, fromKm: [1.95, -2.5], toKm: [1.95, 2.5], steps: 250 },
    probes: [
      { id: 'behind-wall', atKm: [1.95, 0], expect: 'occluded' },
      { id: 'past-south-end', atKm: [1.95, -1.5], expect: 'visible' },
      { id: 'past-north-end', atKm: [1.95, 1.5], expect: 'visible' },
    ],
  },
});

/**
 * The path vertices for a scene, as deck.gl wants them: [lng, lat, mslM].
 *
 * `altOverrideM` is how the spec renders its controls — the same geometry at
 * sea level, or grazing the terrain surface — without a second scene.
 */
export function pathPositions(scene, altOverrideM) {
  const { fromKm, toKm, steps } = scene.path;
  const altM = altOverrideM ?? scene.path.altM;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const dx = fromKm[0] + (toKm[0] - fromKm[0]) * t;
    const dy = fromKm[1] + (toKm[1] - fromKm[1]) * t;
    const [lng, lat] = offsetToLngLat(dx, dy);
    out.push([lng, lat, altM]);
  }
  return out;
}
