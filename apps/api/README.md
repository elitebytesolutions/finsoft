# apps/api

NestJS. HTTP, authentication, module wiring. Owns every server-side check:
permissions, tenant isolation, validation, idempotency, audit. Business logic
lives in `modules/*/domain`, not here.

The browser reaches it same-origin at `/api/*` through the reverse proxy, and
Next.js Server Components call it over the internal address — never through a
Next route handler in between.

## Running it

```bash
npm run db:up                       # the data plane must be up
npm run dev  --workspace @finsoft/api
npm run build --workspace @finsoft/api && node apps/api/dist/main.js
```

`API_PORT` overrides the default 3001. OpenAPI is served at `/api/docs` in
non-production only.

## Build

**SWC, not tsc, and not Node's type stripping.** NestJS dependency injection
reads `design:paramtypes` metadata, which is a TypeScript *transformation*
rather than a type annotation — Node's strip-only mode does not perform it, and
`tsc` cannot compile this app because `@finsoft/database` resolves to
TypeScript source with `.ts` import specifiers.

So the two concerns are split: SWC transpiles (`nest-cli.json`), and
`tsc --noEmit` typechecks (`tsconfig.json`). Vitest uses SWC too, so tests and
the shipped artefact go through the same compiler.

## What exists

| | |
|---|---|
| `GET /api/health` | Liveness. Touches no dependency, exposes only uptime. |
| `GET /api/health/ready` | Readiness. Counts applied migrations, so it proves the database is reachable *and* migrated. 503 when it is not. |
| `TenantGuard` | Registered globally and **fails closed**. Every route is refused unless marked `@Public()`. |
| `ZodValidationPipe` | Per-route validation against a schema from `packages/validation`. Strips undeclared properties; never echoes submitted values. |

## The guard fails closed, deliberately

Authentication is Wave 1, so no request can present a verified tenant yet. The
guard refuses everything that has not explicitly opted out.

The alternative — allowing requests through untenanted until auth arrives —
would mean the first feature endpoint built in Wave 1 runs with no tenant
isolation and nothing fails to indicate it. A 401 on an endpoint that does not
exist yet costs nothing.
