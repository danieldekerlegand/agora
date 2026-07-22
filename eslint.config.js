// Flat ESLint config for every TypeScript area in the monorepo. One config, one gate:
// `npm run lint` at the root lints schemas/, clients/*, registry/, resolver/, console/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'provider-router/**'],
  },
  js.configs.recommended,
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
);
