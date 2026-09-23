import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/* Mirrors ui-prototype/vite.config.ts (same jsdom environment, same setup file
 * shape) so the ported tests behave the same way they did in the prototype.
 * The extra alias resolution below matches apps/web/tsconfig.json's `paths` —
 * Vitest does not read tsconfig path mapping on its own. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The workspace install resolves two copies of react/react-dom: root
    // node_modules has 19.3.0 (hoisted there for the workspace, and what
    // @testing-library/react — itself hoisted to the root — requires
    // internally), while apps/web/node_modules has its own exactly-pinned
    // 19.2.8 nested alongside it because apps/web/package.json pins an exact
    // version that differs from root's. @testing-library/react's internal
    // `require('react-dom/client')` is a plain Node CJS resolution that Vite
    // never sees, so it cannot be redirected — it always lands on root's
    // copy. The only side that *can* be redirected is our own source, so it
    // is aliased to root's copy too: one real React instance app-wide,
    // matching what the test renderer already uses.
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: path.resolve(__dirname, '../../node_modules/react') },
      { find: /^react\//, replacement: path.resolve(__dirname, '../../node_modules/react') + '/' },
      { find: /^react-dom$/, replacement: path.resolve(__dirname, '../../node_modules/react-dom') },
      {
        find: /^react-dom\//,
        replacement: path.resolve(__dirname, '../../node_modules/react-dom') + '/',
      },
      {
        find: '@finsoft/ui/tokens.css',
        replacement: path.resolve(__dirname, '../../packages/ui/src/tokens/index.css'),
      },
      {
        find: '@finsoft/ui/kit.css',
        replacement: path.resolve(__dirname, '../../packages/ui/src/styles/kit.css'),
      },
      {
        find: '@finsoft/ui',
        replacement: path.resolve(__dirname, '../../packages/ui/src/index.tsx'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.tsx',
    css: true,
    include: ['src/test/**/*.test.tsx'],
  },
})
