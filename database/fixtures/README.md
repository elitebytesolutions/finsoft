# database/fixtures/

Reference test data, for suites that need rows they did not create.

**Currently empty, deliberately.** Test data today is built programmatically by
the harness in `packages/database/src/testing/harness.ts` — `createTenantFixture`
and `unique()` — which gives every run its own uniquely-named tenants and users.
That is the right shape while the schema is two tables: a static fixture file
would have to be kept in step with every migration, and a stale fixture is worse
than none.

This directory takes content when a suite needs data it cannot reasonably build
itself: a chart-of-accounts template, a tax-code table, a realistic ledger for a
reconciliation or performance test.

Fixtures are test data. Reference data that ships with the product — COA
templates, tax codes — belongs in `../seeds/`, not here.
