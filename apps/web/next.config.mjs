import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

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
  /*
   * Local dev only. `npm run dev` serves apps/web alone on :3000 with nothing in
   * front of it, while the API listens on its own port — so a same-origin
   * `/api/*` call from the browser (apps/web/src/lib/api/client.ts) would 404
   * against Next's own router instead of reaching the API. This rewrite makes
   * dev behave like staging/production, where Caddy (infrastructure/staging/
   * Caddyfile) does the same routing in front of the container: one origin,
   * `/api/*` proxied through to the API, everything else served by Next. That
   * is also the arrangement ADR-0009's SameSite=Strict refresh cookie requires
   * — a cross-origin call to a different port would never send it.
   *
   * Kept unconditional rather than gated on NODE_ENV: in staging/production the
   * request never reaches Next at all (Caddy intercepts /api/* first), so this
   * rule is provably inert there rather than merely assumed harmless.
   */
  async rewrites() {
    const apiPort = process.env.API_PORT || 3001
    return [{ source: '/api/:path*', destination: `http://localhost:${apiPort}/api/:path*` }]
  },
}
export default nextConfig
