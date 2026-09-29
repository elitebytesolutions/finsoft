# @finsoft/permissions

The atomic permission catalogue and its evaluation. Code-generated into API guards and UI capability checks. A permission that is not in the catalogue does not exist.

**May import:** `packages/validation`, `packages/shared-types`, `packages/database`.

`packages/database` was added by M1-R (docs/briefs/M1-R-rbac.md), an Architecture seat
ruling: this package is not on dependency-cruiser's `kysely-is-allowlisted` list, so it must
not build a Kysely query itself. The RBAC query bodies (`selectEffectivePermissionCodes`,
`insertSeededRoles`) live in `packages/database/src/rbac/*.ts`; this package holds the
catalogue, the system role templates, the privileged-permission flag and the UI capability
map, and calls the database package's exports rather than querying directly. A second,
narrower ESLint rule (`packages/permissions/src/**` in `eslint.config.mjs`) enforces the
same boundary the way `apps/**` already enforces it against `packages/database`.

Enforced by dependency-cruiser in CI (FND-002).
