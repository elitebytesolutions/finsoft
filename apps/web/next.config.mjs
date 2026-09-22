import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * Traces the minimal set of files the server actually needs and emits them
   * to .next/standalone. Without it a container image has to carry the whole
   * workspace node_modules — hundreds of megabytes of build tooling shipped
   * to production to run a server that uses none of it.
   *
   * Set for the Docker build (infrastructure/docker/Dockerfile.web); it
   * changes the build output, not the application.
   */
  output: 'standalone',
  eslint: {
    /*
     * Lint is a CI gate, not a build step.
     *
     * `next build` runs ESLint by default and fails the build on an error, so
     * the container image could not be produced at all while apps/web carried
     * its 143 `no-unused-vars` findings (FND-017). That couples "can we
     * produce a deployable artifact" to "is the code tidy", which are
     * different questions with different urgencies.
     *
     * This hides nothing: `npm run lint` runs in CI's static-analysis job and
     * BLOCKS the pipeline, so the same errors still stop a merge — they just
     * stop it at the gate that exists to catch them, once, with the repo's own
     * flat config rather than Next's. Removing this line would not add a
     * control; it would add a second, weaker copy of one.
     */
    ignoreDuringBuilds: true,
  },
  /*
   * The workspace root, so file tracing follows symlinked workspace packages
   * out of apps/web. Left unset, Next infers the root from the nearest
   * lockfile and silently omits @finsoft/* from the traced output — the image
   * builds and then fails at runtime on a missing module.
   */
  outputFileTracingRoot: join(fileURLToPath(import.meta.url), '../../..'),
  transpilePackages: ['@finsoft/ui', '@finsoft/shared-types'],
}
export default nextConfig
