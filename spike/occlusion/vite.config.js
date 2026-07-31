// Vite config for the ADR 0004 rendering spike — deliberately separate from the
// app's vite.config.js.
//
// The spike must not leak into production: `npm run build` builds index.html at
// the repo root with the root config and knows nothing about this directory, so
// dist/ and the generated service-worker precache list are unchanged by
// anything under spike/. Nothing here is shared with that build except the
// vite dependency itself.
//
// The manualChunks split is not cosmetic — it is the measurement ADR 0004 asks
// for. Bundling maplibre-gl and the deck.gl packages into separate chunks makes
// "what does each library cost us, gzipped" a number the build emits rather
// than an estimate.

import { defineConfig } from 'vite';

const DECK_SCOPES = ['@deck.gl', '@luma.gl', '@math.gl', '@probe.gl', '@loaders.gl'];

const HERE = import.meta.dirname;

export default defineConfig({
  root: HERE,
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The point of the exercise is the real cost, so no artificial inlining and
    // no size warnings to mute.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (DECK_SCOPES.some((scope) => id.includes(`node_modules/${scope}/`))) return 'deck';
          if (id.includes('node_modules/maplibre-gl/')) return 'maplibre';
          // maplibre-gl's own transitive dependencies (@mapbox/*, geojson-vt,
          // kdbush, pbf, …). Kept distinct rather than folded into either
          // bucket so the measurement never silently over- or under-counts.
          return 'vendor';
        },
      },
    },
  },
});
