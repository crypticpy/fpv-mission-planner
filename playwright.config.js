// Playwright config (ADR 0009) — the browser half of `npm run check`.
//
// The suite runs against the *built* app served as a plain static directory,
// not against a dev server: dist/ plus a static file server is exactly what
// GitHub Pages does, so a missing asset or a broken relative URL fails here
// rather than in production. `vite preview` is that static server and nothing
// more — it refuses to start if dist/ has not been built, which is the right
// failure when someone runs `npm run smoke` on its own.
//
// Chromium only. This is a smoke gate, not a compatibility matrix; later
// milestones widen it (route editing, visual snapshots, a11y).

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: 'tests/browser',
  // The ADR 0004 rendering spike keeps its spec alongside these, but it needs a
  // different build, a different port and about a minute of WebGL. It runs from
  // playwright.spike.config.js via `npm run spike:occlusion`, on demand.
  testIgnore: ['**/spike-*.spec.js'],
  // The service-worker assertions install a worker at the preview origin, so
  // the specs must not race each other over one registration.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
