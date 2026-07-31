// The layers the spike page draws, and the three terrain paths it compares.
//
// Everything here is COORDINATE_SYSTEM.CARTESIAN in local metres east/north of
// scene.mjs's ORIGIN, with Z in metres MSL. That is forced: OrbitView's viewport
// is non-geospatial, so a layer handed [lng, lat, alt] under it is drawn at
// roughly (-121, 45) metres from the origin — a spot about 130 metres from the
// mountain's south-west corner and 3 km below the ground. The failure is silent
// and it looks like "the route did not render".
//
// The two optional packages are reached through dynamic import() rather than a
// top-level one. That is not lazy-loading theatre: it is what makes the bundle
// measurement honest. Rollup emits each as its own async chunk, so measure.mjs
// can state what Option A costs and what Option B costs without either number
// being contaminated by the other.

import {
  LineLayer,
  PathLayer,
  PolygonLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
} from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';

import { buildMesh, buildQuads } from './mesh.js';
import { groundAt } from './dem.js';
import {
  HALF_SPAN_M,
  LEGS,
  MISSION,
  OCCLUSION_PROBES,
  PALETTE,
  TERRARIUM_DECODER,
  TILE_SIZE,
  lngOfTileX,
  latOfTileY,
  lngLatToOffset,
  tileRange,
} from './scene.mjs';

const CARTESIAN = {
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  // Also set on the Deck itself. Repeated here because the picking pass builds
  // its parameters from `layer.props.parameters`, not from the deck-level ones —
  // see main.js. Whether that is enough to make picking depth-correct is one of
  // the things the spec measures rather than assumes.
  parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
};

/* -------------------------------------------------------------- the mission */

/**
 * Route, altitude stems, waypoint markers and ground feet.
 *
 * The stems are the reason a self-owned terrain grid matters beyond drawing: a
 * stem has to start on the ground, and "the ground" is a query against whatever
 * built the mesh. In the MapLibre scene that query is
 * `map.queryTerrainElevation`; here it is our own grid. A production
 * orthographic view has to answer it from the same surface it is drawing or the
 * stems float.
 *
 * @param {{ grid: import('./dem.js').Grid, exaggeration: number }} opts
 */
export function missionLayers({ grid, exaggeration }) {
  const zOf = (altM) => altM * exaggeration;
  const feet = MISSION.waypoints.map((w) => ({
    ...w,
    kind: 'foot',
    groundM: groundAt(grid, w.atM[0], w.atM[1]),
  }));

  return [
    new SolidPolygonLayer({
      // A translucent floor at the grid's minimum, so the box reads as a solid
      // block under an orthographic camera rather than as a floating sheet.
      id: 'plinth',
      ...CARTESIAN,
      data: [{ polygon: [
        [-HALF_SPAN_M, -HALF_SPAN_M, grid.minM * exaggeration],
        [HALF_SPAN_M, -HALF_SPAN_M, grid.minM * exaggeration],
        [HALF_SPAN_M, HALF_SPAN_M, grid.minM * exaggeration],
        [-HALF_SPAN_M, HALF_SPAN_M, grid.minM * exaggeration],
      ] }],
      getPolygon: (d) => d.polygon,
      getFillColor: [18, 26, 34, 200],
      pickable: false,
    }),

    new PathLayer({
      id: 'route',
      ...CARTESIAN,
      data: LEGS,
      getPath: (d) => d.path.map(([x, y, z]) => [x, y, zOf(z)]),
      getColor: [...PALETTE.route, 255],
      widthUnits: 'pixels',
      getWidth: 5,
      widthMinPixels: 5,
      // Billboarded for the same reason the occlusion spike billboards: at a
      // 40-degree elevation a flat ribbon is nearly edge-on.
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: true,
    }),

    new LineLayer({
      id: 'stems',
      ...CARTESIAN,
      data: feet,
      getSourcePosition: (d) => [d.atM[0], d.atM[1], d.groundM * exaggeration],
      getTargetPosition: (d) => [d.atM[0], d.atM[1], zOf(d.altM)],
      getColor: [...PALETTE.stem, 230],
      widthUnits: 'pixels',
      getWidth: 2,
      pickable: false,
    }),

    new ScatterplotLayer({
      id: 'feet',
      ...CARTESIAN,
      data: feet,
      getPosition: (d) => [d.atM[0], d.atM[1], d.groundM * exaggeration],
      getFillColor: [...PALETTE.foot, 220],
      getRadius: 4,
      radiusUnits: 'pixels',
      pickable: false,
    }),

    new ScatterplotLayer({
      id: 'waypoints',
      ...CARTESIAN,
      data: MISSION.waypoints.map((w) => ({ ...w, kind: 'waypoint' })),
      getPosition: (d) => [d.atM[0], d.atM[1], zOf(d.altM)],
      getFillColor: [...PALETTE.waypoint, 255],
      getLineColor: [...PALETTE.route, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      stroked: true,
      getRadius: 7,
      radiusUnits: 'pixels',
      pickable: true,
    }),
  ];
}

/* -------------------------------------------------------------- the terrain */

/**
 * Option B rendered with SimpleMeshLayer (@deck.gl/mesh-layers, new dependency).
 *
 * @param {{ grid: import('./dem.js').Grid, exaggeration: number, wireframe: boolean }} o
 */
export async function meshTerrainLayer({ grid, exaggeration, wireframe }) {
  const { SimpleMeshLayer } = await import('@deck.gl/mesh-layers');
  const built = buildMesh(grid, { exaggeration });
  return {
    stats: {
      buildMs: built.buildMs,
      vertexCount: built.vertexCount,
      triangleCount: built.triangleCount,
    },
    layer: new SimpleMeshLayer({
      id: 'terrain',
      ...CARTESIAN,
      data: [{ kind: 'terrain' }],
      mesh: built.mesh,
      // The mesh's own vertex colours are multiplied by this, so white is the
      // only value that lets the hypsometric ramp through. deck's default is
      // black, which renders a perfectly correct, perfectly invisible mountain.
      getColor: [255, 255, 255],
      getPosition: () => [0, 0, 0],
      _instanced: false,
      wireframe,
      material: { ambient: 0.45, diffuse: 0.7, shininess: 24, specularColor: [40, 44, 52] },
      pickable: true,
    }),
  };
}

/**
 * Option B rendered with SolidPolygonLayer — the same surface, zero new
 * dependencies, no normals and therefore no lighting.
 *
 * @param {{ grid: import('./dem.js').Grid, exaggeration: number }} o
 */
export function polygonTerrainLayer({ grid, exaggeration }) {
  const built = buildQuads(grid, { exaggeration });
  return {
    stats: {
      buildMs: built.buildMs,
      vertexCount: built.vertexCount,
      triangleCount: built.triangleCount,
    },
    layer: new SolidPolygonLayer({
      id: 'terrain',
      ...CARTESIAN,
      data: built.data,
      _normalize: false,
      positionFormat: 'XYZ',
      extruded: false,
      filled: true,
      pickable: true,
    }),
  };
}

/**
 * Option A: @deck.gl/geo-layers TerrainLayer.
 *
 * Two shapes, because they behave completely differently under a non-geospatial
 * viewport and only one of them can work:
 *
 *   'single' — one DEM image plus explicit `bounds`. TerrainLayer's non-tiled
 *              branch hands the image to @loaders.gl/terrain, which runs Martini
 *              over it and returns an adaptive mesh. Nothing in that path asks
 *              the viewport anything, so it works anywhere — including here.
 *
 *   'tiled'  — a {z}/{x}/{y} template. TerrainLayer delegates to TileLayer, and
 *              TileLayer's tile indexing branches on `viewport.isGeospatial`. An
 *              OrbitViewport is not geospatial, so it computes *identity* tile
 *              indices from world-space extent instead of Web Mercator ones, and
 *              asks for tiles whose z/x/y have nothing to do with the OSM
 *              pyramid. This mode exists in the spike to record what actually
 *              happens rather than to argue about it.
 *
 * @param {{ variant: 'single'|'tiled', z: number, exaggeration: number,
 *           baseUrl: string, worker: 'cdn'|'local'|'off'|'self', wireframe: boolean }} o
 */
export async function terrainLayerOption({ variant, z, exaggeration, baseUrl, worker, wireframe }) {
  const { TerrainLayer } = await import('@deck.gl/geo-layers');

  // TerrainLayer parses its DEM in a web worker that loaders.gl resolves from
  // unpkg.com at runtime. For an offline-first PWA that is a network dependency
  // on *code*, and it is stubborn. Four modes, so the verdict can report what
  // each actually does rather than what the docs imply:
  //
  //   'cdn'   — untouched default
  //   'local' — swap in the non-worker TerrainLoader. Looks like the fix. Is not:
  //             TerrainLoader is `{...TerrainWorkerLoader, parse}`, so it
  //             inherits `worker: true`.
  //   'off'   — also set `loadOptions.worker = false` (both spellings, since
  //             loaders.gl 4.x moved core options under `core`).
  //   'self'  — point `loadOptions.terrain.workerUrl` at our own copy of the
  //             worker, which generate-tiles.mjs put in public/workers/.
  const loaders = worker === 'cdn'
    ? undefined
    : [(await import('@loaders.gl/terrain')).TerrainLoader];

  const here = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  const loadOptions = {
    off: { worker: false, core: { worker: false } },
    self: { terrain: { workerUrl: `${here}workers/terrain-worker.js` } },
  }[worker];

  const decoder = {
    rScaler: TERRARIUM_DECODER.rScaler * exaggeration,
    gScaler: TERRARIUM_DECODER.gScaler * exaggeration,
    bScaler: TERRARIUM_DECODER.bScaler * exaggeration,
    offset: TERRARIUM_DECODER.offset * exaggeration,
  };

  if (variant === 'tiled') {
    return {
      stats: { buildMs: 0, vertexCount: 0, triangleCount: 0 },
      layer: new TerrainLayer({
        id: 'terrain',
        // `?via=terrainlayer` so the request log can tell TileLayer's tile
        // requests apart from the ones dem.js makes for the mission's own
        // height grid — both hit the same paths otherwise, and "which z/x/y did
        // TileLayer actually ask for" is the entire point of this variant.
        elevationData: `${baseUrl.replace('{z}', String(z))}?via=terrainlayer`,
        elevationDecoder: decoder,
        meshMaxError: 8,
        color: [176, 180, 188],
        wireframe,
        ...(loaders ? { loaders } : null),
        ...(loadOptions ? { loadOptions } : null),
      }),
    };
  }

  // The single covering tile at `z`, and the local-metre rectangle it occupies.
  // TerrainLayer's non-tiled `bounds` is [minX, minY, maxX, maxY] in whatever
  // world the viewport uses — here, metres.
  const { x0, y0 } = tileRange(z);
  const west = lngOfTileX(x0, z);
  const east = lngOfTileX(x0 + 1, z);
  const north = latOfTileY(y0, z);
  const south = latOfTileY(y0 + 1, z);
  const sw = lngLatToOffset(west, south);
  const ne = lngLatToOffset(east, north);

  return {
    stats: {
      buildMs: 0,
      vertexCount: 0,
      triangleCount: 0,
      demPixels: TILE_SIZE * TILE_SIZE,
      coverageM: [Math.round(ne.dxM - sw.dxM), Math.round(ne.dyM - sw.dyM)],
    },
    layer: new TerrainLayer({
      id: 'terrain',
      elevationData: baseUrl
        .replace('{z}', String(z)).replace('{x}', String(x0)).replace('{y}', String(y0)),
      bounds: [sw.dxM, sw.dyM, ne.dxM, ne.dyM],
      elevationDecoder: decoder,
      meshMaxError: 8,
      color: [176, 180, 188],
      wireframe,
      material: { ambient: 0.45, diffuse: 0.7, shininess: 24, specularColor: [40, 44, 52] },
      ...(loaders ? { loaders } : null),
      ...(loadOptions ? { loadOptions } : null),
    }),
  };
}

/**
 * The depth-buffer proof: one marker inside the mountain, one above it.
 *
 * Both are the same size, the same layer and the same draw call, so the only
 * thing that can make them behave differently is the terrain between the buried
 * one and the camera.
 *
 * @param {{ grid: import('./dem.js').Grid, exaggeration: number }} o
 */
export function probeLayer({ grid, exaggeration }) {
  const [x, y] = OCCLUSION_PROBES.atM;
  const surface = groundAt(grid, x, y);
  return new ScatterplotLayer({
    id: 'probes',
    ...CARTESIAN,
    data: [
      {
        kind: 'probe',
        id: 'probe-buried',
        pos: [x, y, (surface - OCCLUSION_PROBES.buriedM) * exaggeration],
        color: [255, 64, 64],
      },
      {
        kind: 'probe',
        id: 'probe-clear',
        pos: [x, y, (surface + OCCLUSION_PROBES.clearM) * exaggeration],
        color: [64, 255, 128],
      },
    ],
    getPosition: (d) => d.pos,
    getFillColor: (d) => d.color,
    getRadius: 10,
    radiusUnits: 'pixels',
    pickable: true,
  });
}

/** A box around the planning area, so the orthographic frame has an edge. */
export function frameLayer({ grid, exaggeration }) {
  const lo = grid.minM * exaggeration;
  const hi = grid.maxM * exaggeration;
  const ring = [
    [-HALF_SPAN_M, -HALF_SPAN_M], [HALF_SPAN_M, -HALF_SPAN_M],
    [HALF_SPAN_M, HALF_SPAN_M], [-HALF_SPAN_M, HALF_SPAN_M],
  ];
  return new PolygonLayer({
    id: 'frame',
    ...CARTESIAN,
    data: [{ polygon: ring.map(([x, y]) => [x, y, lo]) },
      { polygon: ring.map(([x, y]) => [x, y, hi]) }],
    getPolygon: (d) => d.polygon,
    stroked: true,
    filled: false,
    extruded: false,
    getLineColor: [86, 98, 114, 160],
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    pickable: false,
  });
}
