// scene-layers.js — the frame, turned into deck.gl layers. Nothing else.
//
// The 2D layers under presentation/map/layers/ each own their overlays across
// renders and hand them back on dispose. deck.gl works the other way round: a
// render pass builds a fresh, immutable description of every layer and hands the
// whole array over at once, and deck decides what to keep. So this file is a
// single pure function per pass rather than five stateful layer objects — but
// the discipline that matters is unchanged, and the arch check enforces it:
// read the frame, draw the frame, raise every edit through `frame.actions`.
// Nothing here reaches for the mission document, the store, the physics or the
// weather, and nothing here writes.
//
// Two things are deliberately *not* the 2D versions of themselves.
//
//   *The return leg is distinct, not dashed.* True dashes on a deck.gl path need
//     `PathStyleExtension` from `@deck.gl/extensions`, which is not among the
//     three deck packages the spike pinned and which this wave may not add. The
//     flight home is drawn narrower and dimmer instead — still visibly not the
//     line the pilot authored, which is the whole job of the dash in 2D.
//
//   *Ground-draped ribbons are not billboarded.* ADR 0004's last integration
//     constraint: a billboarded ribbon spans real world-space height, so a 5 px
//     line lying on the terrain punches metres of geometry through the hillside
//     at low zoom. The route in the air is billboarded (a flat ribbon collapses
//     to a hairline at 70° of pitch, which is most of why anyone pitches); the
//     footprint rings and the unresolved legs lie flat, where flat is correct.

import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';

import { ADVISORY_CLASS_STYLE, advisoryZones } from '../layers/advisory-layer.js';
import {
  DRAPE_LIFT_M, buildRouteGeometry, buildShotGeometry, parseCssRgb, ringPositions,
} from './scene-geometry.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('./scene-geometry.js').PathRun} PathRun
 * @typedef {import('./scene-geometry.js').RouteLeg3} RouteLeg3
 * @typedef {import('./scene-geometry.js').RoutePin} RoutePin
 * @typedef {import('./scene-geometry.js').SceneSubject3} SceneSubject3
 * @typedef {import('./scene-geometry.js').ShotGeometry} ShotGeometry
 */

/** @typedef {[number, number, number]} Rgb */

/**
 * The theme, resolved to numbers deck.gl can hold.
 * @typedef {object} ScenePalette
 * @property {Rgb} route
 * @property {Rgb} routeCritical
 * @property {Rgb} accent
 * @property {Rgb} casing
 * @property {Rgb} unresolved
 * @property {Rgb} ringPlanned
 * @property {Rgb} ringBest
 * @property {Rgb} launch
 * @property {Rgb} worst
 * @property {Rgb} markerBorder
 * @property {Rgb} label
 * @property {Record<string, Rgb>} advisory  forcing class → colour, resolved from
 *   the same table the 2D layer draws by
 */

/** What the scene knows and the builders need, beyond the frame itself. */
/**
 * @typedef {object} SceneContext
 * @property {ScenePalette} palette
 * @property {number} exaggeration
 * @property {(lng: number, lat: number) => number|null} groundZAt
 */

/** Falls back to the dark theme's own values, so a missing variable is still a map. */
const FALLBACK = /** @type {Record<Exclude<keyof ScenePalette, 'advisory'>, Rgb>} */ ({
  route: [255, 120, 79],
  routeCritical: [255, 92, 92],
  accent: [73, 166, 255],
  casing: [7, 16, 24],
  unresolved: [150, 160, 170],
  ringPlanned: [97, 182, 255],
  ringBest: [72, 229, 163],
  launch: [73, 166, 255],
  worst: [241, 189, 69],
  markerBorder: [10, 14, 18],
  label: [10, 14, 18],
});

/**
 * The theme's colours, read off the live element rather than hard-coded.
 *
 * The same custom properties the 2D overlays pass to Leaflet as strings, except
 * deck.gl takes numbers — so they are resolved once per pass, at the point where
 * a theme switch has already landed on the DOM.
 *
 * @param {Element} el  anything inside the themed tree; the root is simplest
 * @returns {ScenePalette}
 */
export function readPalette(el) {
  const cs = getComputedStyle(el);
  /** @param {string} name @param {Exclude<keyof ScenePalette, 'advisory'>} key */
  const c = (name, key) => parseCssRgb(cs.getPropertyValue(name), FALLBACK[key]);
  return {
    route: c('--series-2', 'route'),
    routeCritical: c('--status-critical', 'routeCritical'),
    accent: c('--accent', 'accent'),
    casing: c('--map-casing', 'casing'),
    unresolved: c('--muted', 'unresolved'),
    ringPlanned: c('--ring-planned', 'ringPlanned'),
    ringBest: c('--ring-best', 'ringBest'),
    launch: c('--series-1', 'launch'),
    worst: c('--status-warning', 'worst'),
    markerBorder: c('--marker-border', 'markerBorder'),
    label: c('--on-accent', 'label'),
    advisory: advisoryColors(cs),
  };
}

/**
 * The zone colours, off the same table the 2D layer draws by, so the two engines
 * cannot come to different conclusions about what a class looks like. Each
 * class's own literal channels are the fallback — carrying them beside the token
 * is exactly what they are recorded for.
 *
 * @param {CSSStyleDeclaration} cs
 * @returns {Record<string, Rgb>}
 */
function advisoryColors(cs) {
  /** @type {Record<string, Rgb>} */
  const out = {};
  for (const [classId, style] of Object.entries(ADVISORY_CLASS_STYLE)) {
    out[classId] = parseCssRgb(cs.getPropertyValue(style.cssVar), style.rgb);
  }
  return out;
}

/**
 * One pass: the frame in, the whole layer array out.
 *
 * Array order is z-order in the sense deck means it — later layers win the
 * blend, though every one of them is still depth-tested against the terrain,
 * which is the point of interleaved mode.
 *
 * @param {MapFrame} frame
 * @param {SceneContext} ctx
 * @returns {object[]}
 */
export function buildSceneLayers(frame, ctx) {
  const { palette } = ctx;
  const layers = [];

  // Under everything: the zones are about the ground, and the plan is drawn on
  // top of the ground in both engines.
  layers.push(...advisoryLayers(frame, ctx));
  layers.push(...footprintLayers(frame, ctx));

  const route = frame.snapshot.route;
  const geometry = (frame.routeMode && route && !route.empty)
    ? buildRouteGeometry({
      points: route.points,
      waypointCount: route.waypointCount,
      returnMode: route.returnMode,
      worstIndex: route.worst?.index,
      waypoints: frame.waypoints,
    }, {
      // Keyed by segment id, and `segments[i].to === waypoints[i].id` is a
      // schema invariant — so a SegmentAnalysis's `index` is the index of the
      // waypoint its leg ends at, which is what the geometry resolves against.
      segments: frame.snapshot.segments ?? {},
      exaggeration: ctx.exaggeration,
      groundZAt: ctx.groundZAt,
      launchElevMslM: frame.env?.elevM ?? null,
    })
    : { vertices: [], runs: [], legs: [], pins: [], count: 0 };

  const routeColor = route?.fits === false ? palette.routeCritical : palette.route;
  layers.push(...routeLayers(geometry, routeColor, palette, frame.selectedSegmentId ?? null));

  /* What the flight is filming, over the flight itself. The shot lines and the
   * frustum are drawn off the same `legs` the route was, so a leg and the shot
   * leaving it can never start in two different places. */
  layers.push(...shotLayers(buildShotGeometry({
    legs: geometry.legs,
    subjects: frame.subjects ?? [],
    selectedSegmentId: frame.selectedSegmentId ?? null,
  }, {
    segments: frame.snapshot.segments ?? {},
    exaggeration: ctx.exaggeration,
    groundZAt: ctx.groundZAt,
  }), palette));

  /* The launch pin last-but-one and the numbers last: in a pitched view the pins
   * are what the pilot points at, and a pin behind a ribbon is a pin they cannot
   * click. Depth still decides what a *hill* hides. */
  layers.push(launchLayer(frame, ctx));
  layers.push(...pinLayers(geometry.pins, palette));

  return layers;
}

/**
 * The mountain-flow zones, on the ground they are about (M5).
 *
 * Which cells are shaded and in what colour is decided in
 * layers/advisory-layer.js and imported rather than restated: the 2D and 3D
 * pictures of one advisory disagreeing about a cell would be worse than either
 * of them alone.
 *
 * The one thing decided here is height. Every corner takes the terrain's own
 * elevation, the way ringPositions does — a cell quad is small, and hanging it
 * off the ground at each corner keeps it on the hillside instead of slicing
 * through it, which is the objection that keeps a filled footprint out of this
 * scene. The cell's sampled `elevM` stands in only while the DEM tile under a
 * corner is still loading.
 *
 * @param {MapFrame} frame
 * @param {SceneContext} ctx
 */
function advisoryLayers(frame, ctx) {
  if (frame.advisoryVisible === false) return [];
  const zones = advisoryZones(frame.snapshot.advisories);
  if (!zones?.fills.length) return [];

  const data = zones.fills.map((fill) => ({
    classId: fill.classId,
    polygon: fill.corners.map((corner) => [
      corner.lng, corner.lat, cornerZ(corner, fill.elevM, ctx),
    ]),
  }));

  /** @param {{ classId: string }} d */
  const rgb = (d) => ctx.palette.advisory[d.classId] ?? [137, 148, 156];
  /** @param {{ classId: string }} d */
  const missing = (d) => ADVISORY_CLASS_STYLE[d.classId]?.dashed === true;

  return [new PolygonLayer({
    id: 'advisory-zones',
    data,
    getPolygon: (d) => d.polygon,
    filled: true,
    stroked: true,
    extruded: false,
    getFillColor: (d) => [
      ...rgb(d), Math.round((ADVISORY_CLASS_STYLE[d.classId]?.fillOpacity ?? 0.3) * 255),
    ],
    /* A dashed outline needs PathStyleExtension, which is not among the deck
     * packages the spike pinned. A cell with no elevation is outlined brighter
     * and wider instead — still visibly not one of the classified cells, which
     * is the whole job of the dash in 2D. */
    getLineColor: (d) => [...rgb(d), missing(d) ? 235 : 150],
    getLineWidth: (d) => (missing(d) ? 2 : 1),
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 1,
    // A wash over the terrain: the pilot picks routes and pins, not ground.
    pickable: false,
  })];
}

/**
 * One corner's altitude: the terrain's if it has been sampled, the cell's own
 * elevation if it has not, and the same drape lift every ground-hugging overlay
 * in this scene carries.
 *
 * @param {LatLng} at
 * @param {number|null} elevM
 * @param {SceneContext} ctx
 * @returns {number}
 */
function cornerZ(at, elevM, ctx) {
  const ground = ctx.groundZAt(at.lng, at.lat);
  const fallback = typeof elevM === 'number' && Number.isFinite(elevM)
    ? elevM * ctx.exaggeration
    : 0;
  return (ground ?? fallback) + DRAPE_LIFT_M;
}

/**
 * The turnaround envelope, on the ground where it belongs.
 *
 * The 2D planned ring carries a translucent fill; this one does not. A deck.gl
 * polygon is planar between its vertices, so a filled envelope over hills would
 * be a sheet slicing through them — a picture that says something about terrain
 * that is not true. The rings alone say exactly what the sweep computed.
 *
 * @param {MapFrame} frame
 * @param {SceneContext} ctx
 */
function footprintLayers(frame, ctx) {
  const { footprint } = frame.snapshot;
  if (!footprint) return [];

  const anyReal = footprint.byCourse.some((r) => r > 0);
  const anyBest = footprint.bestByCourse.some((r) => r > 0);
  if (!anyReal && !anyBest) return [];

  /* The sweep's own launch point, not the pin's — the same rule the 2D layer
   * follows, so a ring can never be drawn around a place it was not computed
   * for. */
  const from = footprint.launch;
  const out = [];

  const best = ringPositions(from, footprint.bestCourses, footprint.bestRadii, ctx.groundZAt);
  if (best.length > 1) {
    out.push(new PathLayer({
      id: 'footprint-best',
      data: [{ path: best }],
      getPath: (d) => d.path,
      getColor: [...ctx.palette.ringBest, 220],
      widthUnits: 'pixels',
      getWidth: 2.5,
      widthMinPixels: 2,
      billboard: false,
      pickable: false,
    }));
  }

  if (anyReal) {
    const planned = ringPositions(from, footprint.courses, footprint.radii, ctx.groundZAt);
    if (planned.length > 1) {
      out.push(new PathLayer({
        id: 'footprint-planned-casing',
        data: [{ path: planned }],
        getPath: (d) => d.path,
        getColor: [...ctx.palette.casing, 150],
        widthUnits: 'pixels',
        getWidth: 6,
        widthMinPixels: 5,
        billboard: false,
        pickable: false,
      }));
      out.push(new PathLayer({
        id: 'footprint-planned',
        data: [{ path: planned }],
        getPath: (d) => d.path,
        getColor: [...ctx.palette.ringPlanned, 255],
        widthUnits: 'pixels',
        getWidth: 3,
        widthMinPixels: 2.5,
        billboard: false,
        pickable: false,
      }));
    }
  }

  return out;
}

/**
 * The flown line, in up to five passes.
 *
 * Split by whether the height is a claim: resolved legs are drawn in the air, at
 * the altitude the analysis solved, billboarded so they stay legible under
 * pitch. Unresolved legs lie on the ground in the muted colour, because a leg
 * whose MSL never resolved must never be readable as a confirmed altitude — the
 * one rule in this whole scene that is about safety rather than looks.
 *
 * The line itself is drawn one datum per leg rather than as merged runs, and
 * that is what makes it selectable: deck.gl hands a pick back the datum under
 * the cursor, so a leg has to *be* a datum for a click to name it. The casing
 * stays merged — it is the only continuous stroke left, and a wider unbroken
 * line under the leg joins is what keeps them looking like one route.
 *
 * @param {{ runs: PathRun[], legs: RouteLeg3[] }} geometry
 * @param {Rgb} color
 * @param {ScenePalette} palette
 * @param {string|null} selectedSegmentId
 */
function routeLayers(geometry, color, palette, selectedSegmentId) {
  const casing = geometry.runs.filter((r) => r.resolved);
  const air = geometry.legs.filter((l) => l.resolved);
  const ground = geometry.legs.filter((l) => !l.resolved);
  const chosen = selectedSegmentId
    ? geometry.legs.filter((l) => l.segmentId === selectedSegmentId)
    : [];
  const out = [];

  /** @param {{ phase: 'out'|'home' }} d */
  const width = (d) => (d.phase === 'home' ? 2.5 : 4);

  if (casing.length) {
    out.push(new PathLayer({
      id: 'route-casing',
      data: casing,
      getPath: (d) => d.path,
      getColor: [...palette.casing, 160],
      widthUnits: 'pixels',
      getWidth: (d) => width(d) + 3.5,
      widthMinPixels: 4,
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: false,
    }));
  }

  /* Over the casing, under the line: the selected leg reads as the same route
   * with a light behind it rather than as a different route. Split by where it
   * is drawn for the same reason the line is — ADR 0004's last constraint is
   * that a billboarded ribbon lying on terrain punches through the hillside. */
  for (const [id, data, billboard] of /** @type {const} */ ([
    ['route-selected', chosen.filter((l) => l.resolved), true],
    ['route-selected-ground', chosen.filter((l) => !l.resolved), false],
  ])) {
    if (!data.length) continue;
    out.push(new PathLayer({
      id,
      data,
      getPath: (d) => d.path,
      getColor: [...palette.accent, 230],
      widthUnits: 'pixels',
      getWidth: (d) => width(d) + 6,
      widthMinPixels: 7,
      billboard,
      jointRounded: true,
      capRounded: true,
      pickable: false,
    }));
  }

  if (air.length) {
    out.push(new PathLayer({
      id: 'route-air',
      data: air,
      getPath: (d) => d.path,
      // The flight home is the line taken when something goes wrong, not one
      // anybody drew: dimmer and narrower, the same distinction the 2D dash makes.
      getColor: (d) => [...color, d.phase === 'home' ? 215 : 255],
      widthUnits: 'pixels',
      getWidth: width,
      widthMinPixels: 2,
      billboard: true,
      jointRounded: true,
      capRounded: true,
      // The pick is what opens the inspector; scene.js reads `kind` and
      // `segmentId` off the datum and raises `frame.actions.selectSegment`.
      pickable: true,
    }));
  }

  if (ground.length) {
    out.push(new PathLayer({
      id: 'route-unresolved',
      data: ground,
      getPath: (d) => d.path,
      getColor: [...palette.unresolved, 190],
      widthUnits: 'pixels',
      getWidth: (d) => width(d) - 0.5,
      widthMinPixels: 1.5,
      // Flat: this one is drawn on the terrain, and ADR 0004's billboard caveat
      // is exactly about ribbons that lie there.
      billboard: false,
      jointRounded: true,
      capRounded: true,
      pickable: true,
    }));
  }

  return out;
}

/**
 * What the flight is framing: a marker on every subject, a line from each shot's
 * leg to the subject it points at, and the selected shot's view pyramid.
 *
 * Nothing here is pickable, and that is deliberate rather than unfinished. A pick
 * this scene's bridge does not recognise falls through to `onGroundClick`, which
 * in subject mode drops a *second* subject on top of the one just clicked — so
 * until the bridge learns the `kind`, the honest arrangement is markers that draw
 * and do not swallow the pointer. The payloads carry `kind` and `id` in the same
 * shape the route's do, so wiring them up later is a change to scene.js alone.
 * The subjects stay draggable in 2D, where the gesture already exists.
 *
 * ADR 0004's billboard caveat applies here exactly as it does to the route: a
 * shot line whose ends are both confirmed hangs in the air and is billboarded, a
 * line with an unmeasured subject or an unresolved leg on one end lies flat,
 * because a billboarded ribbon on the terrain punches through the hillside.
 *
 * @param {ShotGeometry} shot
 * @param {ScenePalette} palette
 */
function shotLayers(shot, palette) {
  const out = [];

  /* Under the markers: the pyramid is context for the line, and the line is
   * context for the subject at the end of it. */
  if (shot.frustum) {
    const f = shot.frustum;
    const data = [
      { kind: 'frustum', segmentId: f.segmentId, path: f.outline, edge: false },
      ...f.edges.map((path) => ({ kind: 'frustum', segmentId: f.segmentId, path, edge: true })),
    ];
    out.push(new PathLayer({
      id: 'shot-frustum',
      data,
      getPath: (d) => d.path,
      // The frame's own rectangle reads solid; the four edges back to the camera
      // are scaffolding for it and are drawn at half its weight.
      getColor: (d) => [...palette.accent, d.edge ? 120 : 200],
      widthUnits: 'pixels',
      getWidth: (d) => (d.edge ? 1.2 : 2.2),
      widthMinPixels: 1,
      billboard: f.resolved,
      jointRounded: true,
      capRounded: true,
      pickable: false,
    }));
  }

  for (const [id, data, billboard] of /** @type {const} */ ([
    ['shot-lines', shot.shots.filter((s) => s.resolved), true],
    ['shot-lines-ground', shot.shots.filter((s) => !s.resolved), false],
  ])) {
    if (!data.length) continue;
    out.push(new PathLayer({
      id,
      data,
      getPath: (d) => d.path,
      // The open segment's sightline is the one being read; the rest are there so
      // the pilot can see what else the flight is pointed at.
      getColor: (d) => [...palette.accent, d.selected ? 220 : 90],
      widthUnits: 'pixels',
      getWidth: (d) => (d.selected ? 2.5 : 1.5),
      widthMinPixels: 1,
      billboard,
      jointRounded: true,
      capRounded: true,
      pickable: false,
      updateTriggers: {
        getColor: data.map((d) => d.selected).join(),
        getWidth: data.map((d) => d.selected).join(),
      },
    }));
  }

  out.push(...subjectLayers(shot.subjects, palette));
  return out;
}

/**
 * The subjects themselves: a square-ish dot and its name.
 *
 * Drawn as a wide, thickly stroked scatterplot rather than as a second waypoint
 * pin — at a glance the pilot has to be able to tell what is flown from what is
 * filmed, and in 2D the same distinction is a rounded square against a circle.
 * The framed subject takes the accent, as it does in 2D; the rest are muted, and
 * an unmeasured subject is drawn hollow because its height came off the terrain
 * rather than off anything anybody recorded.
 *
 * @param {SceneSubject3[]} subjects
 * @param {ScenePalette} palette
 */
function subjectLayers(subjects, palette) {
  if (!subjects.length) return [];
  const stamp = subjects.map((s) => `${s.framed}${s.resolved}`).join();
  return [
    new ScatterplotLayer({
      id: 'subjects',
      data: subjects,
      getPosition: (d) => d.position,
      getFillColor: (d) => [
        ...(d.framed ? palette.accent : palette.unresolved),
        d.resolved ? 255 : 110,
      ],
      getLineColor: [...palette.markerBorder, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2.5,
      stroked: true,
      filled: true,
      radiusUnits: 'pixels',
      getRadius: 8,
      radiusMinPixels: 6,
      billboard: true,
      pickable: false,
      updateTriggers: { getFillColor: stamp },
    }),
    new TextLayer({
      id: 'subject-labels',
      data: subjects,
      getPosition: (d) => d.position,
      getText: (d) => d.name,
      getColor: [...palette.label, 255],
      getSize: 11,
      sizeUnits: 'pixels',
      fontWeight: 700,
      // Unlike the waypoint numbers this text is whatever the pilot typed, so the
      // atlas is built from the names in hand rather than from a fixed range —
      // 'auto' is deck's own answer to exactly that, and it keeps a scene with two
      // subjects from rasterising the whole of ASCII.
      characterSet: 'auto',
      getPixelOffset: [0, -16],
      billboard: true,
      pickable: false,
      updateTriggers: { getText: subjects.map((s) => s.name).join('\0') },
    }),
  ];
}

/**
 * The launch pin. Pickable, because it is draggable — scene.js runs the drag off
 * `pickObject`, and `kind` is how the pick tells a pad from a waypoint.
 * @param {MapFrame} frame
 * @param {SceneContext} ctx
 */
function launchLayer(frame, ctx) {
  const z = ctx.groundZAt(frame.launch.lng, frame.launch.lat);
  const elev = frame.env?.elevM;
  const fallback = typeof elev === 'number' && Number.isFinite(elev) ? elev * ctx.exaggeration : 0;
  return new ScatterplotLayer({
    id: 'launch',
    data: [{
      kind: 'launch',
      position: [frame.launch.lng, frame.launch.lat, (z ?? fallback) + 2],
    }],
    getPosition: (d) => d.position,
    getFillColor: [...ctx.palette.launch, 255],
    getLineColor: [...ctx.palette.markerBorder, 255],
    lineWidthUnits: 'pixels',
    getLineWidth: 3,
    stroked: true,
    filled: true,
    radiusUnits: 'pixels',
    getRadius: 9,
    radiusMinPixels: 7,
    // Faces the camera at every pitch, like the CSS dot it stands in for.
    billboard: true,
    pickable: true,
  });
}

/**
 * The numbered waypoints. Two layers, one object: the dot takes the pointer, the
 * number never does — a pick that returned a glyph would be a pick the gesture
 * bridge has to special-case.
 * @param {RoutePin[]} pins
 * @param {ScenePalette} palette
 */
function pinLayers(pins, palette) {
  if (!pins.length) return [];
  return [
    new ScatterplotLayer({
      id: 'waypoints',
      data: pins,
      getPosition: (d) => d.position,
      // The worst pin is the one the reserve runs out on; it is amber in 2D and
      // amber here. An unresolved pin is drawn muted for the same reason its legs
      // are: the height under it is not known.
      getFillColor: (d) => [
        ...(d.worst ? palette.worst : d.resolved ? palette.route : palette.unresolved),
        255,
      ],
      getLineColor: [...palette.markerBorder, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      stroked: true,
      filled: true,
      radiusUnits: 'pixels',
      getRadius: 10,
      radiusMinPixels: 8,
      billboard: true,
      pickable: true,
      // Recolour on a verdict change without rebuilding the buffers.
      updateTriggers: { getFillColor: pins.map((p) => `${p.worst}${p.resolved}`).join() },
    }),
    new TextLayer({
      id: 'waypoint-labels',
      data: pins,
      getPosition: (d) => d.position,
      getText: (d) => d.label,
      getColor: [...palette.label, 255],
      getSize: 12,
      sizeUnits: 'pixels',
      fontWeight: 700,
      // Digits only: the default atlas rasterises the whole ASCII range, and
      // every label this layer will ever draw is a waypoint number.
      characterSet: '0123456789',
      billboard: true,
      pickable: false,
    }),
  ];
}
