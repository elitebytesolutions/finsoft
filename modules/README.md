# modules/

Feature modules. Each one is added by the wave that needs it — `modules/customers`
(M3-C) is the first (ADR-0028: module packaging and runtime).

A module is a workspace package (`modules/<name>/`, `@finsoft/<name>`), shipping
TypeScript source and running under Node's native type stripping, exactly like
`packages/*`. **There is no `ui/` layer** — controllers live in
`apps/api/src/<module>/` as thin adapters, and screens (M4) live in
`apps/web/src/screens`, consuming response types from `packages/shared-types`.

Every module has the same four layers, with dependencies pointing strictly
inward:

```
api  →  application  →  domain
              infrastructure  →  domain
```

`domain/` is pure TypeScript: no NestJS, no ORM, no HTTP, no Kysely, not even
`@finsoft/database` as a type. `application/ports.ts` declares the repository
interfaces `infrastructure/` implements (a **type-only** import back from
infrastructure is the one sanctioned exception to the inward arrow —
ADR-0028 statement 5).

Exports are exactly two: `"."` → `index.ts` (use-case factories, for
`apps/api`/`apps/worker`/`tests/**`) and `"./published"` →
`application/published.ts` (plain DTOs and typed errors, the only file
another module may import).

Modules never import each other's internals and never write to each other's
tables — cross-module traffic goes through a published application-layer
interface only (`modules/<other>/application/published.ts`). Modules never
construct journal lines (`postingEngine.post`) and never write
`stock_movements` (`inventoryKernel.postMovement`), and never call
`assignDocumentNumber`/`assignTenantDocumentNumber` directly — document and
master-code numbering comes from the kernel's own index (K3, K7). Enforced by
dependency-cruiser and ESLint in CI (`.dependency-cruiser.cjs`,
`eslint.config.mjs`), proven by `tests/security/depcruise-negative-control.spec.ts`
and `tests/security/lint-boundaries.spec.ts`.

See [ADR-0028](../docs/adr/ADR-0028-module-packaging-and-runtime.md) and
[docs/design/M3/modules.md](../docs/design/M3/modules.md) for the full
reasoning and the customers/receivables split.
