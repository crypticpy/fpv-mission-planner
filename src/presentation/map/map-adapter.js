// map-adapter.js — what a map engine has to be able to do, and nothing else.
//
// ADR 0004: the map becomes an adapter behind a stable interface plus a layer
// registry, so 2D and 3D are two consumers of the same snapshot rather than two
// monoliths. This file is that interface. It imports nothing — not Leaflet, not
// the app — and it is the only description of the engine the layers are allowed
// to know about.
//
// The surface is deliberately the smallest one that draws today's map, derived
// from what src/map.js actually did rather than from what a map library offers:
// polygons and polylines with a stroke style, markers built out of an HTML dot,
// one docked control, three events, and a view state that can be read and
// restored. Anything a single layer needs and no other does belongs on that
// layer, not here — a contract that grows to fit each new drawing is not a
// contract.
//
// Two rules keep it honest:
//
//   Coordinates are `{lat, lng}` plain objects in both directions. No engine
//     type ever crosses this line, which is what lets a layer be unit-tested
//     without a DOM and re-pointed at a different engine without an edit.
//
//   Every draw returns a handle that can remove itself. Layers own what they
//     drew and hand it back on dispose; the adapter keeps no registry of
//     overlays, so nothing can be orphaned by a layer that forgets one.

/** @typedef {{ lat: number, lng: number }} LatLng */

/** A rectangle in geographic space, corner to corner. */
/** @typedef {{ southWest: LatLng, northEast: LatLng }} LatLngBounds */

/** Which base map is showing. The two the app ships, named rather than indexed. */
/** @typedef {'satellite'|'streets'} BaseLayerId */

/**
 * Everything about where the map is looking, and the whole of what gets
 * persisted between sessions.
 * @typedef {object} MapViewState
 * @property {LatLng} center
 * @property {number} zoom
 * @property {BaseLayerId} baseLayer
 */

/**
 * A stroke, and optionally a fill. Values are passed to the engine as-is —
 * including CSS custom properties like `var(--ring-planned)`, which is how the
 * overlays stay theme-aware without this layer knowing what a theme is.
 * @typedef {object} ShapeStyle
 * @property {string} color
 * @property {number} weight
 * @property {number} [opacity]
 * @property {string} [dashArray]
 * @property {boolean} [fill]
 * @property {string} [fillColor]
 * @property {number} [fillOpacity]
 * @property {string} [className]  a hook for CSS the engine does not own
 */

/**
 * What a shape can be asked to report. A shape with no handlers is inert and
 * takes no pointer events at all, which is what every overlay on this map was
 * until route segments became selectable — so the default stays "not there".
 * @typedef {object} ShapeHandlers
 * @property {() => void} [onClick]
 */

/**
 * A drawn shape. `bounds` is null for a shape with no extent — an engine cannot
 * frame a polygon that collapsed to a point, and neither can the caller.
 * @typedef {object} ShapeOverlay
 * @property {() => LatLngBounds|null} bounds
 * @property {() => void} remove
 */

/**
 * A pin. The engine is told the markup and the box, never a class of its own
 * invention: every marker on this map is a `<div>` styled by app.css, so the
 * anchor is the caller's arithmetic and the appearance is the caller's CSS.
 * @typedef {object} MarkerSpec
 * @property {LatLng} at
 * @property {string} className        outer element's class
 * @property {string} html             inner markup
 * @property {[number, number]} sizePx
 * @property {[number, number]} anchorPx  which pixel of the box sits on `at`
 * @property {string} [title]
 * @property {boolean} [draggable]
 * @property {number} [zIndexOffset]   negative to sit under the other pins
 * @property {(at: LatLng) => void} [onDragEnd]
 * @property {() => void} [onClick]
 */

/**
 * A placed marker. `moveTo` is for following a value that changed elsewhere —
 * a drag has already moved the pin by the time `onDragEnd` fires.
 * @typedef {object} MarkerOverlay
 * @property {(at: LatLng) => void} moveTo
 * @property {() => void} remove
 */

/**
 * A control docked over the map, outside the panning surface.
 * @typedef {object} ControlSpec
 * @property {'topright'|'topleft'|'bottomright'|'bottomleft'} position
 * @property {string} className
 * @property {string} html
 */

/**
 * A placed control. `element` is null before the engine has mounted it, which is
 * a state the caller must tolerate rather than assert away.
 * @typedef {object} ControlOverlay
 * @property {() => HTMLElement|null} element
 * @property {() => void} remove
 */

/**
 * The three things that happen to a map that anything outside it cares about.
 *
 *   `click`      — a click on the map surface, not on a marker. What it means is
 *                  the host's business; the adapter only reports where.
 *   `viewchange` — the pan, the zoom or the base layer settled. The cue to
 *                  persist, and deliberately one event rather than three,
 *                  because every listener has ever wanted all three.
 *   `tileerror`  — imagery failed to load. Fires per tile, so listeners latch.
 *
 * @typedef {'click'|'viewchange'|'tileerror'} MapEventName
 */

/** The event vocabulary, as a value, so a typo is a runtime error not a silence. */
export const MAP_EVENTS = Object.freeze(
  /** @type {MapEventName[]} */ (['click', 'viewchange', 'tileerror']));

/**
 * The engine, as the host and the layers see it.
 * @typedef {object} MapAdapter
 * @property {() => HTMLElement} container the element the map is drawn into
 * @property {() => MapViewState} view
 * @property {(id: BaseLayerId) => void} setBaseLayer  swap the imagery; fires
 *   `viewchange` so the choice persists like a pan does. A no-op when the named
 *   layer is already up
 * @property {(at: LatLng, zoom?: number) => void} center  pan to a point; the
 *   zoom is kept unless one is named, which only the 2D↔3D handover does
 * @property {(bounds: LatLngBounds, opts?: { paddingPx?: number }) => void} fit
 * @property {() => void} resized  the container's box changed; re-measure
 * @property {(points: LatLng[], style: ShapeStyle) => ShapeOverlay} polygon
 * @property {(points: LatLng[], style: ShapeStyle, handlers?: ShapeHandlers) => ShapeOverlay} polyline
 * @property {(spec: MarkerSpec) => MarkerOverlay} marker
 * @property {(spec: ControlSpec) => ControlOverlay} control
 * @property {(event: MapEventName, handler: (payload: LatLng|null) => void) => void} on
 * @property {() => void} destroy
 */

/**
 * What one render pass hands every layer. A layer reads this and draws; it does
 * not reach for the mission document, the store, the weather or the physics, and
 * the arch check enforces that (scripts/arch-check.mjs, ADR 0004).
 *
 * The distinction that matters is between the two launch points. `launch` is the
 * pin — where the pilot has dragged it to, this instant, before any analysis has
 * caught up. `snapshot.footprint.launch` is where the ring was actually swept
 * from. They agree on every settled frame; a layer drawing the ring must use the
 * sweep's own copy, so the ring can never be centred somewhere it wasn't
 * computed for.
 *
 * @typedef {object} MapFrame
 * @property {AnalysisSnapshot} snapshot
 * @property {LatLng} launch
 * @property {RouteWaypoint[]} waypoints  the document's, in order, with their ids
 * @property {SceneSubject[]} subjects    what the shots are framing, in document
 *   order. Beside `waypoints` and for the same reason: the snapshot publishes what
 *   a shot *is* (`segment.shot` — distances, framing, screen direction) but not
 *   where its subject stands, and a marker cannot be drawn from a derived number
 * @property {SavedSpot[]} spots          the saved-spot roster, as last handed over
 * @property {boolean} routeMode          the route tool is on *and* usable
 * @property {boolean} subjectMode        the next map click places a subject
 *   rather than a waypoint. Exclusive with the waypoint meaning of a click, and
 *   frame state rather than layer state so both engines route a click the same way
 * @property {string|null} selectedSegmentId  which leg the inspector is open on;
 *   view state, never mission state — nothing about it is persisted or commanded
 * @property {boolean} advisoryVisible  whether the mountain-flow zones are drawn.
 *   Beside `routeMode` and for the same reason: it is a view preference both
 *   engines have to agree about, and a toggle that reached only one of them
 *   would leave 3D showing what 2D had just hidden
 * @property {UnitSet} units
 * @property {EnvironmentInputs} env      the rail the plan was made against
 * @property {MapFrameActions} actions
 * @property {GestureGuard} gestures
 */

/**
 * Raising an edit, never performing one. Every one of these ends in a command on
 * the mission document (ADR 0002) somewhere outside presentation/ — except
 * `selectSegment`, which changes what the pilot is looking at and nothing else.
 * @typedef {object} MapFrameActions
 * @property {(at: LatLng) => void} moveLaunch
 * @property {(id: string, at: LatLng) => void} moveWaypoint
 * @property {(id: string) => void} removeWaypoint
 * @property {(at: LatLng) => void} placeSubject     drop a new subject here
 * @property {(id: string, at: LatLng) => void} moveSubject
 * @property {(id: string) => void} removeSubject    every segment framing it is
 *   un-pointed in the same reduction; the map does not have to tidy up after it
 * @property {(spot: SavedSpot) => void} selectSpot
 * @property {(segmentId: string|null) => void} selectSegment  null clears
 */

/**
 * The synthetic click a pointer gesture leaves behind. Leaflet fires a map click
 * after a marker drag and can surface one behind a marker hit; without this the
 * click that ends a drag would drop a waypoint on top of what was just moved,
 * and the click that deletes a pin would immediately re-add it.
 *
 * Shared rather than per-layer because the click it suppresses lands on the map,
 * which no layer owns.
 * @typedef {object} GestureGuard
 * @property {() => void} dragEnded      a drag just finished
 * @property {() => void} markerClicked  a marker just took a click
 * @property {() => boolean} afterDrag   …so a pin's own click handler can stand down
 */

/**
 * A saved spot as the roster hands it over. `id` and the coordinates are all the
 * map reads; `name` is the pin's tooltip.
 * @typedef {{ id: string, name: string, lat: number, lng: number }} SavedSpot
 */

/** A document waypoint, resolved to coordinates and carrying its id. */
/** @typedef {{ id: string, lat: number, lng: number }} RouteWaypoint */

/**
 * A thing the flight is filming, as the scene holds it. `elevationMslM` and
 * `radiusM` are the schema's own nullable fields and are carried rather than
 * defaulted — a subject nobody has measured is not a subject at sea level with a
 * one-metre radius, and the 3D scene has to be able to tell the difference.
 * @typedef {object} SceneSubject
 * @property {string} id
 * @property {string} name
 * @property {number} lat
 * @property {number} lng
 * @property {number|null} elevationMslM
 * @property {number|null} radiusM
 */

/**
 * One drawing concern. `render` runs on every pass and owns everything it drew
 * since the last one; `dispose` gives it back.
 * @typedef {object} MapLayer
 * @property {string} id
 * @property {(frame: MapFrame, adapter: MapAdapter) => void} render
 * @property {(adapter: MapAdapter) => void} dispose
 */

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('../../application/analysis/analysis-contracts.js').EnvironmentInputs} EnvironmentInputs
 */

/**
 * The unit formatters the rail is set to, as src/domain/units.js builds them.
 * Named here rather than imported so this file keeps its promise of importing
 * nothing.
 * @typedef {object} UnitSet
 * @property {(km: number) => number} distanceFromKm
 * @property {string} distanceUnit
 * @property {(km2: number) => number} areaFromKm2
 * @property {string} areaUnit
 * @property {(ms: number) => number} speedFromMs
 * @property {string} speedUnit
 */
