// ESLint flat config (ADR 0009).
//
// `js.configs.recommended` and nothing stylistic: this config exists to catch
// correctness bugs (unused bindings, unreachable code, duplicate keys, shadowed
// globals), not to reformat a codebase that already reads consistently. Every
// rule adjustment below is justified in place; if a rule needs a blanket "off"
// to accommodate a real idiom, that reasoning belongs here, not in an inline
// disable comment scattered through js/.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // Never linted: build output, dependencies, the vendored map library
    // (upstream code, not ours to restyle), and the research/docs trees.
    ignores: ['dist/**', 'node_modules/**', 'vendor/**', 'research/**', 'docs/**'],
  },

  // ---- application source: browser ESM ----
  // Both roots on purpose. A file matching no config object is not linted at
  // all, so if this listed only `js/**` the M0b move to `src/` would leave
  // `npm run lint` reporting a green pass over zero files.
  {
    files: ['js/**/*.js', 'src/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,

      // The app catches-and-ignores in several deliberate places — private-mode
      // localStorage, quota errors, a service-worker registration that fails.
      // Those are documented no-ops, and `catch {}` with a comment inside is the
      // codebase's way of writing them. `allowEmptyCatch` keeps the rule on for
      // every other kind of empty block.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Caught errors are frequently unused on purpose (see above), and the
      // codebase uses a leading underscore for "declared, deliberately unused".
      'no-unused-vars': ['error', {
        args: 'after-used',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
      }],
    },
  },

  // ---- the service worker: worker globals, not window ----
  {
    files: ['sw.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: { ...js.configs.recommended.rules },
  },

  // ---- unit/contract tests: node ESM ----
  {
    files: ['tests/**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { ...js.configs.recommended.rules },
  },

  // ---- browser smoke tests: Playwright drives node, asserts on a page ----
  {
    files: ['tests/browser/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Both: the spec file runs in node, but its `page.evaluate` callbacks are
      // serialised into the browser and reference window/document there.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules },
  },

  // ---- build tooling: node ESM ----
  {
    files: ['scripts/**/*.mjs', 'vite.config.js', 'playwright.config.js', 'eslint.config.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { ...js.configs.recommended.rules },
  },
];
