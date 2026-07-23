// Flat ESLint config for every TypeScript area in the monorepo. One config, one gate:
// `npm run lint` at the root lints schemas/, clients/*, registry/, resolver/, console/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `**/crates/wasm/pkg/**` is wasm-bindgen build output (emitted by `make check-translation`
    // into a git-ignored dir): generated CommonJS glue, not authored source, so it must not be
    // linted — otherwise `make check` goes red whenever the wasm pkg has been built.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'provider-router/**',
      '**/crates/wasm/pkg/**',
    ],
  },
  js.configs.recommended,
  {
    // Build/tooling scripts are plain Node ESM, not part of the TS library surface: give them
    // the Node globals so `no-undef` does not flag `process` / `console` / `Buffer`.
    files: ['**/*.mjs', '**/scripts/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // The commons is a library surface: an unused export is a design smell, an unused
      // local is dead code. Argument-side `_` prefixes stay legal for interface stubs.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The translation wasm bindings' test harness is a Node CommonJS script (run by its
    // own test.sh, `require`-ing the wasm-bindgen CJS module) — not part of the TS library
    // surface. Treat it as CommonJS so `no-undef` doesn't flag require/__dirname/console,
    // and allow its require() loads (the module it loads is emitted as CJS, not ESM).
    files: ['**/crates/wasm/test.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'readonly', __dirname: 'readonly', console: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
