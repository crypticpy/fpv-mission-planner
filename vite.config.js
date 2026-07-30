// Vite build config (ADR 0009).
//
// The source tree stays plain browser-runnable ESM — nothing Vite-specific is
// allowed into index.html or js/**, so `python3 -m http.server` at the repo
// root keeps working exactly as it does today. Everything build-shaped lives
// here.
//
// `base: './'` because the app deploys to a GitHub Pages *subpath*
// (/fpv-mission-planner/): every URL Vite writes into dist/ must be relative
// to the document, never rooted at "/".

import { cp } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';

const ROOT = import.meta.dirname;

/**
 * Files that must land in dist/ at their *source* paths instead of as
 * content-hashed assets, plus the regex that finds the <link> tags pointing at
 * them.
 *
 * Why: `manifest.webmanifest` carries its own relative icon references
 * (`icons/icon-192.png`, …) inside JSON. Vite hashes and relocates the
 * manifest but cannot rewrite paths *inside* it, so the default handling
 * silently breaks every PWA install icon — and icon-192/icon-512, referenced
 * only from the manifest, never make it into dist/ at all. Keeping the
 * manifest and icons/ verbatim also keeps its `start_url: "."` / `scope: "."`
 * meaning the same thing in dist/ as on the no-build dev path.
 */
const VERBATIM = ['manifest.webmanifest', 'icons'];
const VERBATIM_LINKS = /^[ \t]*<link\b[^>]*\bhref="(?:manifest\.webmanifest|icons\/[^"]*)"[^>]*>[ \t]*\r?\n?/gm;

/**
 * Lifts the verbatim <link> tags out of index.html before Vite's asset scanner
 * sees them, copies their targets into dist/ untouched, and puts the original
 * tags back into the emitted HTML.
 */
function verbatimStatic() {
  /** @type {string[]} */
  let held = [];

  return [
    {
      name: 'fpv:verbatim-static-pre',
      enforce: /** @type {const} */ ('pre'),
      transformIndexHtml: {
        order: /** @type {const} */ ('pre'),
        handler(html) {
          held = [];
          return html.replace(VERBATIM_LINKS, (tag) => {
            held.push(tag.trim());
            return '';
          });
        },
      },
    },
    {
      name: 'fpv:verbatim-static-post',
      transformIndexHtml: {
        order: /** @type {const} */ ('post'),
        handler(html) {
          if (!held.length) return html;
          return html.replace('</head>', `${held.join('\n')}\n</head>`);
        },
      },
      // closeBundle, not writeBundle: dist/ has been emptied and written by
      // then, so the copies cannot be clobbered.
      async closeBundle() {
        for (const entry of VERBATIM) {
          await cp(path.join(ROOT, entry), path.join(ROOT, 'dist', entry), { recursive: true });
        }
      },
    },
  ];
}

export default defineConfig({
  base: './',
  // No public/ directory in this repo — static passthrough is explicit, above.
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [verbatimStatic()],
});
