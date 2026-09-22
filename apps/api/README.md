# apps/api

NestJS. HTTP, authentication, module wiring. **Built by FND-009** — this is a
placeholder directory so the workspace layout matches ARCHITECTURE.md §2.

Owns every server-side check: permissions, tenant isolation, validation,
idempotency, audit. Business logic lives in `modules/*/domain`, not here.

The browser reaches it same-origin at `/api/*` through the reverse proxy, and
Next.js Server Components call it over the internal address — never through a
Next route handler in between.
