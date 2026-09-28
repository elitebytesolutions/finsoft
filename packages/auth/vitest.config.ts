import { configDefaults, defineConfig } from 'vitest/config'

/*
 * The workspace `test` script is the Docker-free unit run (OPS-002: `unit`
 * job and `npm run check`). Specs that need Redis or PostgreSQL are named
 * `*.integration.spec.ts` and run in the integration suite instead
 * (tests/integration/vitest.config.ts includes them).
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.spec.ts'],
  },
})
