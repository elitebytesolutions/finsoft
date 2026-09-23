# @finsoft/database

Connection pool, Kysely instance, tenant context, base repository, RLS helpers and the migration runner (ADR-0013). The only package that may construct a `Pool` or open a transaction.

**May import:** `packages/validation`, `packages/shared-types`. Owns `pg` and `kysely` exclusively.

Empty until FND-007. Enforced by dependency-cruiser in CI (FND-002).
