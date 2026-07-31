# Orthographic 3D terrain — engine verdict

**Question.** The round-2 asset manifest specifies an *Orthographic 3D* planning
view and is explicit that this is a new rendering requirement: "Do not label a
normal perspective view 'Orthographic.'" A standalone `OrbitView({orthographic:
true})` gives us the projection. It does not give us terrain. So: where does the
terrain mesh come from — **Option A**, `@deck.gl/geo-layers` `TerrainLayer`
against a terrain-RGB/terrarium tile source, or **Option B**, our own mesh over
a self-sampled elevation grid?

**Verdict: Option B — SimpleMeshLayer over a height grid we decode ourselves.**

Not on performance. On real hardware the two are indistinguishable, and Option A
is actually *faster* on a software rasteriser. Option B wins on three things
that turned out to be structural rather than a matter of tuning:

1. Option A's mesh parse **fetches code from unpkg.com at runtime**, and neither
   of the two fixes that look like they should stop it does. This is an
   offline-first PWA.
2. Option A's tiled mode — the mode that makes it "a tile source" at all —
   **cannot address the OSM pyramid under a non-geospatial viewport**. It
   requests zero tiles. Only the single-image mode works, which is to say the
   part of Option A we would actually use is the part that isn't tiled.
3. Option A's mesh is **opaque to the application**. We measured that deck's
   picking pass is not depth-correct against terrain, on two different GPUs. The
   fix requires knowing the ground height analytically. Option B has that grid
   in hand; Option A has it only inside a Martini mesh we did not build.

Option A is also 13× the bundle cost (+33.9 kB gzip vs +2.5 kB) and needs a new
build step to ship a worker file nothing in the module graph references.

Everything below is measured. Where something could not be measured, it says so.

---

## What was built

`spike/ortho/` — same shape as `spike/occlusion/`: a tile fetcher, a vite
config, a Playwright spec that asserts and prints, and a Node measure script.

| file | what it is |
| --- | --- |
| `scene.mjs` | the fixture, shared by Node, the browser and the spec: origin, 5 km box, terrarium maths, the 6-waypoint mission, camera, probes |
| `generate-tiles.mjs` | downloads the real terrarium tiles for the box; also self-hosts the loaders.gl terrain worker |
| `dem.js` | terrarium decode → a height grid, from tiles or from Open-Meteo |
| `mesh.js` | height grid → indexed triangle mesh |
| `layers.js` | the deck layers: route, stems, waypoints, probes, and all three terrain paths |
| `main.js` | the Deck host, the orbit driver, and the `window.spike` measurement surface |
| `ortho.spec.js` | 10 tests |
| `measure.mjs` | bundle deltas and the DEM budget |

Run it: `npm run spike:ortho` (build → test → measure).

Test area is **Mount Hood, 45.3736 / −121.696**, a 5 km box. Real terrain, real
tiles, a summit with a published elevation to check the decode against.

---

## Measurements

### The projection is genuinely parallel

The whole point of the exercise, so it is asserted rather than eyeballed. A
600 m vertical stem is measured in screen pixels at the near corner of the box
and again at the far corner:

| projection | near | far | delta |
| --- | --- | --- | --- |
| `orthographic: true` | 84.48 px | 84.48 px | **0.000 px** |
| perspective | 78.16 px | 80.11 px | 1.943 px (2.49%) |

Parallel to the limit of float precision. Worth noting the second row: at a
planning framing, `OrbitView`'s *perspective* mode is already within 2.5% of
parallel. Nobody would catch that by looking. **The contract is what matters
here, not the visual difference** — a planner that promises constant scale and
delivers 2.5% drift is making a measurement claim it does not keep, and that is
exactly the claim the manifest is asking us not to fake.

### The mesh is the real mountain

192 × 192 grid decoded from z14 terrarium tiles, 26.18 m spacing:

- **12 tile requests, 1376 kB**
- fetch 621 ms · decode 41 ms · sample 3 ms
- mesh **36,864 verts / 72,962 triangles, built in 4.4 ms**
- first frame at **68.9 ms**
- decoded elevation range 1783.2 – 3426.5 m; **USGS summit is 3429 m** (2.5 m
  under, which is a 26 m grid missing the exact peak, not a decode error)

Mesh build is not a cost worth optimising: 4.4 ms for the whole mountain.

### Frame time while orbiting

360° sweep, 90 frames, 1280 × 720.

**Apple M5 Max (ANGLE Metal), headed:**

| path | mean | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| B — SimpleMeshLayer | 12.50 ms | 8.3 ms | 9.2 ms | 390.4 ms |
| B — SolidPolygonLayer | 8.33 ms | 8.3 ms | 9.2 ms | 9.5 ms |
| A — TerrainLayer | 8.34 ms | 8.4 ms | 9.2 ms | 14.7 ms |

All three are pinned to vsync at 120 Hz. The p50/p95 columns are identical
across all three paths; SimpleMeshLayer's mean is dragged by a single 390 ms
first frame (shader compile and buffer upload), which is a startup cost, not a
frame cost. **On real hardware, rendering performance does not discriminate
between the options.**

**SwiftShader (headless CI), same test:**

| path | mean | p95 | max |
| --- | --- | --- | --- |
| B — SimpleMeshLayer | 31.12 ms | 32.5 ms | 37.7 ms |
| B — SolidPolygonLayer | 32.84 ms | 33.8 ms | 34.5 ms |
| A — TerrainLayer | 16.72 ms | 18.0 ms | 25.9 ms |

Option A is ~2× faster when the GPU is a CPU — its Martini mesh is adaptively
simplified where ours is a uniform grid, and vertex count is what a software
rasteriser actually pays for. That gap closes to nothing on a real GPU. It is
recorded because it is the one performance argument in Option A's favour and it
should not be quietly dropped: **if the ortho view ever has to run on a device
without hardware WebGL, revisit this.** Our own mesh can be decimated; that is a
known technique and a smaller change than adopting Option A.

### Bundle cost

Four single-file closures, each built with code-splitting off so the whole
dependency graph lands in one file, gzip level 9. Baseline is
`@deck.gl/core` + `@deck.gl/layers`, which the app already ships.

| closure | raw | gzip | Δ gzip |
| --- | --- | --- | --- |
| base | 817.2 kB | 206.6 kB | — |
| B — `@deck.gl/mesh-layers` | 827.9 kB | 209.1 kB | **+2.5 kB** |
| A — `@deck.gl/geo-layers` | 953.2 kB | 240.5 kB | **+33.9 kB** |
| A — geo-layers + `@loaders.gl/terrain` | 969.4 kB | 245.3 kB | **+38.7 kB** |

Plus, for Option A offline, a **45.2 kB** worker file served as a static asset
(below). The spike's own build was measured with `manualChunks` too, but vite 8's
rolldown backend merges and drops chunk names at will — several configured
buckets never appear in the output — so the per-option figures above come from
separate builds rather than from the chunk table.

### The DEM download for one planning box

The field-pack rehearsal: `generate-tiles.mjs` walks exactly the tile rectangle
a per-region pack would, against the same endpoint the app already ships.

| zoom | tiles | m/px | bytes |
| --- | --- | --- | --- |
| z12 | 1 | 26.9 | 133.8 kB |
| z13 | 4 | 13.4 | 502.1 kB |
| z14 | 12 | 6.7 | **1375.8 kB** |
| z15 | 42 | 3.4 | 4368.5 kB |
| all | 59 | | 6380.2 kB |

**z14 alone — 12 tiles, 1.34 MB — is enough for a planning mesh** at 6.7 m/px.
z15 quadruples the download for detail no orthographic overview resolves. A 5 km
region pack is ~1.4 MB, not ~6.4 MB, if the pack is scoped to the render need.

---

## Why Option A loses

### It fetches code from a CDN at runtime

`TerrainLayer` parses its DEM with `@loaders.gl/terrain`, which resolves its
worker from `https://unpkg.com/@loaders.gl/terrain@4.4.3/dist/terrain-worker.js`
at first parse. Four modes were tested, each on a fresh page, counting
off-origin requests:

| mode | meshed | off-origin requests |
| --- | --- | --- |
| default (bundled `TerrainWorkerLoader`) | yes | unpkg.com/@loaders.gl/terrain@4.4.3 |
| import `TerrainLoader` explicitly | yes | unpkg.com/@loaders.gl/terrain@4.4.3 |
| `loadOptions: { worker: false }` | yes | **none** |
| `loadOptions.terrain.workerUrl` → self-hosted | yes | **none** |

The second row is the trap. `TerrainLoader` looks like the main-thread loader —
it is the one with a `parse` function — but it is defined as
`{...TerrainWorkerLoader, parse: parseTerrain}` and therefore **inherits
`worker: true`**. Importing it changes nothing. The two fixes that work are
turning the worker off (parse moves to the main thread) or self-hosting the
file and pointing `loadOptions.terrain.workerUrl` at it — a **45.2 kB** asset,
versioned against `@loaders.gl/terrain`, that nothing in the module graph
references and so nothing checks. `generate-tiles.mjs` copies it, so the spike
pays that cost once and can quote it.

This is survivable. It is also a permanent, silent, easy-to-regress footgun in
an app whose entire premise is working at a trailhead with no signal, bought in
exchange for a mesh we can build in 4.4 ms.

### Tiled mode does not work under an OrbitViewport

`OrbitView` produces an `OrbitViewport` with `isGeospatial === false` (asserted).
`TerrainLayer`'s tiled mode delegates to `TileLayer`, which branches on exactly
that flag to decide how to convert the viewport into tile indices. Under a
non-geospatial viewport it never asks for a covering tile:

```
[option A / tiled] 0 tile requests from TileLayer
[option A / tiled] asked for: []
[option A / tiled] the terrarium tiles covering this box at z14 are x 2652-2654, y 5868-5871
[option A / tiled] sub-layers: ["terrain","terrain-tiles"]
```

No error, no warning — the sub-layer is constructed and simply renders nothing.
The spec asserts the zero, so if a future deck.gl release fixes this we find out.

Non-tiled mode does work: given an `elevationData` image and `bounds` in world
coordinates it renders, producing `terrain` + `terrain-mesh` sub-layers over
`[6873, 6874] m` from a 65,536-pixel DEM. But that is one pre-stitched image we
would have to assemble ourselves — at which point we are doing Option B's work
and then handing the result to a heavier layer that hides it from us.

### The mesh is opaque where we need it not to be

Two depth findings, both reproduced on SwiftShader *and* Apple Metal:

**Draw-pass occlusion works, but only if you ask.** A standalone `Deck` on WebGL
gets no depth state. deck's `LayersPass` applies its default draw parameters
(`depthWriteEnabled: true, depthCompare: 'less-equal'`) only when
`device.type === 'webgpu'`; on WebGL it inherits luma.gl's pipeline defaults,
which do not include a depth test. Every existing deck usage in this app is
interleaved via `MapboxOverlay`, where MapLibre has already configured depth —
so this has never come up, and a standalone view will hit it on day one. The fix
is one line on the `Deck` and on every layer:

```js
parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' }
```

Verified by pixel readback rather than by eye, deliberately: a back-to-front
triangle order looks correctly occluded without any depth test at all. A probe
marker 600 m *below* the surface reads `[248,237,226]` (terrain) instead of its
own `[255,64,64]`; a marker 600 m above reads `[64,255,128]`.

**Picking is not depth-correct.** With the draw pass occluding correctly, at the
same pixel:

```
deck.pickObject at the buried marker returns probe-buried
pickMultipleObjects returns ["probes#0", "terrain#0"]
```

deck's `pickingFBO` does have a `depth16unorm` attachment, so this is deck.gl
behaviour, not a missing buffer. **A click on a mountainside can select a
waypoint hidden inside the mountain.** In a planning tool whose job is telling
you where the ground is, that is the wrong failure.

The fix is to resolve picks against the height field analytically — reject a hit
whose world position is below the ground at that XY. **Option B has that grid
already**; it is the same array the mesh was built from. Option A's Martini mesh
lives inside the layer and is not ours to query.

(Related: the first `pickObject()` after load always returns `null` — the
picking framebuffer has not been rendered yet. A throwaway warm-up pick fixes
it. Small, but it would read as "the first click on the new view does nothing.")

---

## Offline-field compatibility

**Correction to the brief's premise.** There is no M8 field-pack HTTP-response
cache in this worktree. `grep` for `field.?pack` across `src/`, `tests/`,
`docs/` and `sw.js` returns nothing. What M8 actually shipped (ADR 0012 §2) is
`src/infrastructure/persistence/evidence-repository.js`: per-mission IndexedDB
persistence of *derived* terrain data with provenance. That is a different and,
as it happens, better-suited mechanism — see below.

**The service worker will not cache DEM tiles today.** `sw.js` special-cases
`arcgisonline.com` and `openstreetmap.org` (returns early — "let them fail
offline"), network-first-with-fallback for `open-meteo.com`, and
stale-while-revalidate for same-origin. `s3.amazonaws.com` matches none of them
and falls through to browser default: **no caching**. ADR 0012 lists
"Map-tile precaching" and "Bounded offline-region packages" as explicitly out of
scope, the latter because the license research (R-DEM) *has not* cleared a
redistributable source. Any offline terrain story is a new decision, not an
existing capability — and that is true for **both** options equally.

Given that, the options differ on what a future region pack would have to hold:

| | Option A | Option B |
| --- | --- | --- |
| what must be cached | terrarium PNGs *and* a 45.2 kB worker asset | terrarium PNGs, or a decoded grid |
| can be pre-decoded | no — parse happens inside the layer | **yes** — decode once, store the grid |
| storage shape | opaque image tiles | a plain `Float32Array` + bounds |
| fits existing machinery | no | **yes** — see below |

That last row is the strongest structural argument. The app already has a
contract for exactly this shape: `AdvisoryGrid` in
`src/application/terrain/terrain-contracts.js` is a row-major elevation grid
with `rows`, `cols`, `cellSizeM` and per-cell `elevM`, already carried with
provenance and already persisted per mission through `evidence-repository.js`.
Option B's render grid **is** that structure at a different density, and can
ride the same persistence, the same provenance labelling, and the same
"absence is a value, not sea level" discipline (ADR 0008).

Note *at a different density* — the existing advisory grid cannot be reused
as-is. `sample-grid.js` caps it at `GRID_MAX_DIM = 24` (576 cells) with
`GRID_MIN_CELL_SIZE_M = 120`, which over a 5 km box is ~208 m spacing. That is a
physics grid sized to Copernicus GLO-90's real resolution; a render mesh wants
~26 m. The contract shape transfers; the instance does not.

**The Open-Meteo path is not a viable mesh source**, which is worth stating
because "we already have an elevation provider" is the obvious first idea. It is
a point-query API batched 100 points per request, run sequentially. Measured
earlier this session: **24 × 24 = 576 points, 6 requests, 1306 ms**. A 192 × 192
render grid is 36,864 points — 369 requests, extrapolating to roughly 80 s of
sequential HTTP for one mountain. The spec includes a live test of this path; on
the final run it **skipped on HTTP 429**, the free tier having rate-limited this
IP from earlier probing (confirmed independently with `curl`). That is itself
the answer: an API that rate-limits a handful of exploratory runs is not going
to serve a terrain mesh. Recorded as a skip rather than faked.

The DEM tiles, by contrast, are already in the app: `TERRAIN_DEM_URL` in
`src/presentation/map/tile-sources.js` is the same AWS terrarium endpoint this
spike used, at the same z15 max zoom. **Option B introduces no new data source
at all** — it reads bytes the 3D view already downloads, and decodes them with
the same formula already documented in that file.

---

## Risks

**Ours to carry, if we take Option B.**

- *We own the decode.* `elevation_m = R*256 + G + B/256 - 32768` is four lines
  and the spike validates it against a published summit to 2.5 m, but it becomes
  our bug surface. Mitigation: the summit assertion is cheap to keep as a real
  test.
- *Uniform grid, no LOD.* 72,962 triangles for a 5 km box is nothing on a real
  GPU and ~30 ms/frame on a software rasteriser. A 50 km region would need
  decimation or tiling that Option A gets from Martini for free. **This is the
  single thing that would send us back to Option A**, and the trigger is a
  larger planning extent, not this one.
- *Memory.* A 192² Float32 height grid is 144 kB; positions, normals and
  indices for 36,864 verts / 72,962 tris come to ~1.8 MB. Fine for one region,
  worth watching if several are held at once.

**Shared by both options.**

- *The picking-depth bug is deck.gl's, and it will bite whoever ships first.*
  Option B can work around it analytically; Option A cannot without duplicating
  the mesh. Either way, `pickObject` cannot be trusted against terrain, and this
  needs a test, not a comment.
- *Depth parameters must be set explicitly on a standalone Deck.* It fails
  silently and looks plausible. Assert it with a pixel read, as the spike does.
- *`OrbitViewport` is not geospatial.* Every layer in the ortho view must use
  `COORDINATE_SYSTEM.CARTESIAN` in local metres with Z = metres MSL. This is a
  real structural cost: none of the existing geometry builders in
  `scene-geometry.js` produce that today.
- *Terrarium licensing is unresolved* (R-DEM, ADR 0012). Caching tiles for
  offline use is a legal question we have not answered, for either option.

**Method caveats.**

- CI frame times are SwiftShader, not a GPU. Both sets are reported; the headed
  numbers came from an Apple M5 Max via `SPIKE_ORTHO_HEADED=1`.
- The Open-Meteo latency figure is from earlier in the session, before the rate
  limit; the final run's live re-measurement skipped.
- Bundle deltas are single-file closures, not the app's real chunk graph. They
  are an upper bound on marginal cost and are comparable to each other, which is
  what the decision needs.

**One finding that is not about engines.** The fixture's six waypoint altitudes
were first written by eye against a contour map, and the spec's
"every stem clears the ground" assertion caught **two of them underground —
wp-6 by 77 m**. A planning view that cannot tell you where the ground is will
draw a route through a mountain and look completely reasonable doing it. That is
the feature, restated as a bug we committed while building the spike for it.

---

## Integration sketch

Files a production implementation would touch. Nothing outside `spike/ortho/`
was modified by this spike.

**New, under `src/presentation/map/scene3d/`:**

- `ortho-scene.js` — the standalone `Deck` host. Parallel to `scene.js`, not a
  branch inside it. `scene.js` is a *MapLibre* host: it owns a map, terrain, a
  `MapboxOverlay`, and the four ADR 0004 integration constraints listed in its
  header (overlay added after `map.once('idle')`, explicit `map.on('click')` →
  `overlay.pickObject()` bridge, `info.coordinate` never read, explicit
  `maxPitch`). None of those exist in a standalone Deck, and folding a viewport
  with no map into that file would put two engines behind one set of invariants.
  It should return the **same `SceneHandle`** (`ready`, `render`, `view`,
  `setView`, `fit`, `resized`, `destroy`) so `map-view.js` swaps hosts without
  learning a second vocabulary.
- `ortho-terrain.js` — terrarium decode → height grid → `SimpleMeshLayer`, plus
  the `groundAt(x, y)` sampler the picking fix needs. Roughly `dem.js` +
  `mesh.js` from the spike.

**Modified:**

- `src/presentation/map/scene3d/scene-geometry.js` — currently emits lng/lat
  positions with `DRAPE_LIFT_M` for a geospatial viewport. Needs a CARTESIAN
  variant: a local ENU projection about the mission origin, Z in metres MSL.
  `buildRouteGeometry` / `buildShotGeometry` / `ringPositions` / `boundsOf` all
  take a coordinate-space parameter rather than being forked.
- `src/presentation/map/scene3d/scene-layers.js` — `buildSceneLayers` grows the
  same parameter, plus the explicit `parameters: { depthWriteEnabled: true,
  depthCompare: 'less-equal' }` on every layer. `readPalette` is unchanged; the
  spike reused the CSS-variable approach directly.
- `src/presentation/map/map-view.js` — the only consumer of `scene3d/`. Chooses
  which host to lazily `import()`. The dynamic-import boundary is what keeps
  WebGL out of the shell (ADR 0004); the ortho host must stay behind it.
- `package.json` — `@deck.gl/mesh-layers` at `9.3.7` (matching the pinned
  `@deck.gl/core`). **`@deck.gl/geo-layers` is not needed** and should be
  removed from devDependencies when this spike is retired.
- `src/presentation/map/tile-sources.js` — unchanged, but note the decode
  formula now has a second consumer; it may be worth exporting a
  `decodeTerrarium` helper rather than restating it.

**Consulted, not necessarily changed:** `src/application/terrain/terrain-contracts.js`
(the `AdvisoryGrid` shape to model the render grid on),
`src/application/terrain/sample-grid.js` (why the existing grid is too coarse),
`src/infrastructure/persistence/evidence-repository.js` (where a cached grid
would live), `sw.js` (would need a new rule if tiles are ever cached — and a
`CACHE_NAME` bump, currently `fpv-shell-v11`, which
`tests/sw-precache.test.mjs` guards), `src/analysis-host.js` (the only module
ADR 0009 lets reach across both layers).

### Preserving state across the projection toggle

The spike implements and asserts this, and it is simpler than it looks because
the two viewports share their camera vocabulary. `OrbitView` and
`OrbitView({orthographic: true})` take the *same* `OrbitViewState`:
`{ target, zoom, rotationX, rotationOrbit }`. Toggling is a re-render with a
different view instance and the view state passed straight through.

Spike result:

```
[toggle] selection {"kind":"waypoint","id":"wp-4"}, azimuth 118°, 7 layers
         — all preserved across the projection swap
```

Selection, `rotationOrbit`, `rotationX`, `zoom` and the layer list all survive,
and the pixels do change (asserted, so the toggle cannot silently no-op). For
production the same rule generalises: **camera state is a value held by
`map-view.js`, not by the host.** A host is constructed with it and hands it
back through `view()`; nothing about the projection belongs in it. That is
already how `SceneHandle` is shaped — `view()` / `setView()` exist precisely so
`map-view.js` can carry the camera between engines when it swaps 2D for 3D. The
ortho toggle is the same move a third time.

The one thing that does *not* carry across is the 2D↔3D zoom convention: `scene.js`
converts through `toSceneZoom` / `toFlatZoom` (`SCENE_ZOOM_OFFSET = 1`) because
MapLibre and Leaflet number zoom differently. `OrbitViewport`'s `zoom` is a
third numbering again — log2 scale about the target, no tile pyramid behind it —
so it needs its own conversion in `scene-geometry.js` next to the existing pair,
derived from the mission's ground extent rather than from a tile level.

---

## Recommendation, in one paragraph

Take **Option B**. Build the height grid by decoding terrarium tiles we already
fetch, mesh it with `SimpleMeshLayer` (+2.5 kB gzip), and set depth parameters
explicitly on the standalone `Deck`. Resolve picks against the height grid
rather than trusting `pickObject`. Keep the grid in the `AdvisoryGrid` shape so
it can ride `evidence-repository.js` when offline regions become a real
milestone. Do not add `@deck.gl/geo-layers`: its tiled mode cannot address the
pyramid under a non-geospatial viewport, its non-tiled mode requires us to
assemble the DEM image anyway, it pulls a runtime CDN fetch into an offline-first
app, and it costs 13× the bundle for a mesh we build in 4.4 ms. Revisit only if
the planning extent grows enough that a uniform grid needs LOD, or if the view
must run without hardware WebGL — those are the two cases where Martini earns
its weight.
