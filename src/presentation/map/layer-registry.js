// layer-registry.js — the other half of ADR 0004.
//
// The adapter makes the engine replaceable; the registry makes the *drawing*
// separable. Before this, one render function drew the footprint, the leg line,
// the route, the pins and the spots in one pass, and the only way to change any
// of them was to read all of them. Now each is a `{ id, render, dispose }` that
// owns what it drew and nothing else.
//
// There is almost no machinery here on purpose. The registry holds an ordered
// list, calls `render` down it once per pass, and calls `dispose` up it on
// teardown. Layers do not talk to each other, cannot see each other's overlays,
// and are never asked whether they *want* to render — a layer that has nothing
// to draw this frame draws nothing, which is a decision it makes from its own
// frame rather than one the host makes for it.
//
// Order is z-order. It is the list's order, fixed at registration, because a
// layer that could reorder itself would make the stacking of the map a
// consequence of the order things happened to render in.

/**
 * @typedef {import('./map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('./map-adapter.js').MapFrame} MapFrame
 * @typedef {import('./map-adapter.js').MapLayer} MapLayer
 */

/**
 * @typedef {object} LayerRegistry
 * @property {(frame: MapFrame, adapter: MapAdapter) => void} render
 * @property {(adapter: MapAdapter) => void} disposeAll
 * @property {(id: string) => MapLayer|null} get
 */

/**
 * @param {MapLayer[]} layers  in draw order, bottom first
 * @returns {LayerRegistry}
 */
export function createLayerRegistry(layers) {
  const list = layers.slice();
  const byId = new Map(list.map((l) => [l.id, l]));
  if (byId.size !== list.length) {
    // Two layers under one id means `get` is a coin flip and a future dispose
    // would leak one of them. Cheap to check once, at wiring time.
    throw new Error('createLayerRegistry: layer ids must be unique');
  }

  return {
    render(frame, adapter) {
      for (const layer of list) layer.render(frame, adapter);
    },
    disposeAll(adapter) {
      for (let i = list.length - 1; i >= 0; i--) list[i].dispose(adapter);
    },
    get: (id) => byId.get(id) ?? null,
  };
}
