import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/*
 * NestJS dependency injection reads design:paramtypes metadata, which is a
 * TypeScript *transformation*. Vitest's default esbuild transform erases
 * types but does not emit that metadata, so a DI container built under it
 * resolves every dependency as undefined.
 *
 * SWC performs the transformation, which is also what the production build
 * uses (nest-cli.json). Tests and the shipped artefact therefore go through
 * the same compiler.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
})
