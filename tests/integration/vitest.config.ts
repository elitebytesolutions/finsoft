import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/*
 * Integration suites boot the real NestJS application, so they need the same
 * compiler the application is built with.
 *
 * NestJS dependency injection reads design:paramtypes metadata, which is a
 * TypeScript TRANSFORMATION rather than an erasure. Vitest's default esbuild
 * transform strips types without emitting it, and every injected dependency
 * then resolves as undefined — the container builds, and nothing works.
 *
 * This mirrors apps/api/vitest.config.ts deliberately. Tests, that app's own
 * suite, and the shipped artefact all go through SWC.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    /*
     * Rooted at the repository, so this must name the directory. A bare
     * '**' glob here discovered every spec in the repo — 165 tests, the whole
     * suite run twice under the wrong config — and looked like a pass.
     */
    include: ['tests/integration/**/*.spec.ts'],
    environment: 'node',
    /*
     * One file at a time. These suites share a single PostgreSQL database and
     * a single Redis, and the harness pins DATABASE_POOL_MAX to 1 — parallel
     * files would contend for the connection and interleave fixture state,
     * producing failures that depend on scheduling rather than on the code.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
