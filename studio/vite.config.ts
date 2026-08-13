import react from '@vitejs/plugin-react';
// `vitest/config` (not `vite`) so the `test` block below is typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
