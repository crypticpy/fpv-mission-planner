// Playwright config for the ADR 0004 rendering spike — run on demand, never as
// part of `npm run check`.
//
// The spike is a second, self-contained vite app under spike/occlusion with its
// own build, its own port and its own synthetic terrain. Keeping it on a
// separate config (rather than a project inside playwright.config.js) is what
// lets `npm run smoke` stay a fast gate over the real app: the default config
// ignores spike-*.spec.js outright, so nothing about the app's smoke run
// changes because this exists.
//
//   npm run spike:occlusion        generate tiles, build, serve, assert
//
// Chromium only, one worker, no retries. Every assertion here is a pixel probe
// against a deterministic scene: a flake would be a real finding, so retries
// would only hide it.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: ['**/spike-*.spec.js'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  // WebGL scene setup plus terrain tile loading, eighteen times over.
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Pixel probes are stated in CSS pixels. A device pixel ratio other than 1
    // would silently halve every screen coordinate the spec computes.
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `npx vite preview --config spike/occlusion/vite.config.js --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
