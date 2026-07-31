// Vite config for the orthographic-3D spike — separate from the app's, and from
// spike/occlusion's, on purpose.
//
// `npm run build` builds index.html at the repo root with the root config and
// knows nothing about this directory, so dist/ and the generated service-worker
// precache list are unchanged by anything here.
//
// The manualChunks split is the measurement, not housekeeping. The whole point
// of the exercise is "what would each option cost us", and the two candidate
// packages are reached through dynamic import() in layers.js — so rollup emits
// them as separate async chunks and measure.mjs can read Option A's price and
// Option B's price off the build instead of estimating them.

import { defineConfig } from 'vite';

const HERE = import.meta.dirname;

/** Scope -> chunk name. Order matters: the first match wins. */
const BUCKETS = [
  ['@deck.gl/geo-layers', 'option-a-geo-layers'],
  ['@loaders.gl/terrain', 'option-a-terrain-loader'],
  ['@deck.gl/mesh-layers', 'option-b-mesh-layers'],
  ['@luma.gl/gltf', 'option-a-gltf'],
  ['@loaders.gl/gltf', 'option-a-gltf'],
  ['@loaders.gl/tiles', 'option-a-tiles'],
  ['@deck.gl/core', 'deck-core'],
  ['@deck.gl/layers', 'deck-layers'],
];

export default defineConfig({
  root: HERE,
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The point is the real cost: no artificial inlining, no size warnings to mute.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 8192,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          for (const [scope, name] of BUCKETS) {
            if (id.includes(`node_modules/${scope}/`)) return name;
          }
          // Everything else deck drags in — @luma.gl, @math.gl, @probe.gl, the
          // remaining @loaders.gl modules. Kept distinct so neither option's
          // number silently absorbs the other's transitive weight.
          return 'shared-vendor';
        },
      },
    },
  },
});
