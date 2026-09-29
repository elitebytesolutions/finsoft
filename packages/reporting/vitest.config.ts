import { configDefaults, defineConfig } from 'vitest/config'

/*
 * Same shape as packages/auth/vitest.config.ts: the workspace `test` script
 * is the Docker-free run. This package's own tests all need a real
 * PostgreSQL (there is no cached balance to fake), so they are named
 * "dot-integration-dot-spec" files and run instead via
 * tests/integration/vitest.config.ts, which already globs packages' src
 * trees for that suffix.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.spec.ts'],
  },
})
