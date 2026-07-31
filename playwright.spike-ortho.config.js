// Playwright config for the orthographic-3D rendering spike — run on demand,
// never as part of `npm run check`.
//
// A third config, alongside playwright.config.js (the app) and
// playwright.spike.config.js (the occlusion spike), for the same reason the
// second one exists: the spike is a self-contained vite app with its own build,
// its own port and its own fixtures, and `npm run smoke` must stay a fast gate
// over the real app.
//
//   npm run spike:ortho     fetch tiles, build, serve, assert, measure
//
// `testDir` points at the spike itself rather than tests/browser, so everything
// this spike owns lives under one directory and can be deleted in one move.
//
// Chromium only, one worker, no retries. The assertions are projection
// arithmetic and picking against a deterministic scene served from disk: a flake
// would be a real finding, and a retry would hide it.
//
// SPIKE_ORTHO_HEADED=1 runs headed. That matters here in a way it did not for
// the occlusion spike: headless chromium falls back to SwiftShader, so a frame
// time measured headless is a CPU rasteriser's frame time. The spec records the
// renderer string next to every timing so the two runs can never be confused.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4175;
const BASE_URL = `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: 'spike/ortho',
  testMatch: ['**/*.spec.js'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  // A 256-sample grid stitched from twelve DEM tiles, several times over.
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    // Screen coordinates in the spec are CSS pixels; a DPR other than 1 would
    // silently halve every one of them.
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
    headless: !process.env.SPIKE_ORTHO_HEADED,
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `npx vite preview --config spike/ortho/vite.config.js --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
