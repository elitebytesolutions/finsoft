import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '@finsoft/database/testing'

/*
 * The boundary rules, exercised.
 *
 * dependency-cruiser watches the MODULE GRAPH, which is why it never saw the
 * violation that prompted this file: a transaction handle arrives through a
 * CALLBACK, not an import, so `tx.selectFrom(...)` inside a controller reads
 * as ordinary application code. The readiness probe built queries in the HTTP
 * layer and every check in the repository passed.
 *
 * A lint rule that has never been observed to fire is a comment. These run
 * ESLint over deliberately-violating source and assert the specific rule
 * catches it, so the enforcement is itself enforced.
 *
 * Fixtures are strings rather than files on disk: a file that violates the
 * rules would fail the repository's own lint run, and suppressing it there
 * would defeat the exercise.
 */

let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT })
})

/** Lint a fragment AS IF it lived at `filePath`, which selects the config blocks. */
async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? []).map((m) => m.message)
}

const matching = (messages: string[], fragment: string) =>
  messages.filter((m) => m.includes(fragment))

describe('apps/** may not construct queries (ADR-0013)', () => {
  it('catches a query built on a handle received through a callback', async () => {
    /*
     * THE regression test. This is the exact shape of the violation that got
     * through: no import of kysely, no import of pg — the handle is a
     * parameter. dependency-cruiser cannot see it, by construction.
     */
    const messages = await messagesFor(
      'apps/api/src/health/probe.ts',
      `import { withGlobal } from '@finsoft/database'
       export function check() {
         return withGlobal(async (tx) => {
           return tx.selectFrom('schema_migrations').select('version').execute()
         })
       }`,
    )

    expect(
      matching(messages, 'apps/** contains no query construction'),
      'a query built on a callback-supplied handle must be caught in apps/**',
    ).toHaveLength(1)
  })

  it.each(['insertInto', 'updateTable', 'deleteFrom'])('catches %s too', async (method) => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `export function w(tx: any) { return tx.${method}('users') }`,
    )
    expect(matching(messages, 'apps/** contains no query construction')).toHaveLength(1)
  })

  it('leaves the same code alone inside packages/database, which owns it', async () => {
    // The rule must be a boundary, not a ban. If it fired here too, the
    // package that is supposed to build queries could not.
    const messages = await messagesFor(
      'packages/database/src/health.ts',
      `export function read(tx: any) { return tx.selectFrom('tenants').select('id').execute() }`,
    )
    expect(matching(messages, 'apps/** contains no query construction')).toEqual([])
  })
})

describe('packages/auth may not construct queries either (ADR-0023, M1-A)', () => {
  /*
   * The same gap as apps/**, in the one other package where it is realistic:
   * a transaction handle arrives through a callback from a
   * @finsoft/database export, not an import of kysely or pg, so
   * dependency-cruiser's module-graph view sees nothing. packages/auth is
   * not on ADR-0013's kysely allowlist (.dependency-cruiser.cjs), so it
   * must never build a query on a handle it is handed.
   */
  it('catches a query built on a handle received through a callback', async () => {
    const messages = await messagesFor(
      'packages/auth/src/login.ts',
      `import { findLoginCandidate } from '@finsoft/database/auth'
       export function check() {
         return findLoginCandidate('CODE', 'x@example.test', async (tx) => {
           return tx.selectFrom('users').select('id').execute()
         })
       }`,
    )

    expect(
      matching(messages, 'packages/auth/** contains no query construction'),
      'a query built on a callback-supplied handle must be caught in packages/auth/**',
    ).toHaveLength(1)
  })

  it.each(['insertInto', 'updateTable', 'deleteFrom'])('catches %s too', async (method) => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `export function w(tx: any) { return tx.${method}('users') }`,
    )
    expect(matching(messages, 'packages/auth/** contains no query construction')).toHaveLength(1)
  })

  it('leaves the same code alone inside packages/database, which owns it', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/login.ts',
      `export function read(tx: any) { return tx.selectFrom('users').select('id').execute() }`,
    )
    expect(matching(messages, 'packages/auth/** contains no query construction')).toEqual([])
  })

  it('does not fire on a spec file, so a fixture test like this one can call selectFrom', async () => {
    const messages = await messagesFor(
      'packages/auth/src/login.spec.ts',
      `export function w(tx: any) { return tx.selectFrom('users') }`,
    )
    expect(matching(messages, 'packages/auth/** contains no query construction')).toEqual([])
  })
})

describe('TenantContext is forbidden in login.ts and refresh.ts (architecture re-review C2, 2026-09-27)', () => {
  /*
   * ADR-0023 A2: the tenant for every transaction these two files open
   * enters through withResolvedTenant(tenantByCodeResolver(...)) — never
   * TenantContext, which carries a bare, unbranded id and was the exact
   * shape of the login TOCTOU items 1a/1b/N1 fixed once already. This rule
   * has never been observed to fire; these fixtures fire it.
   */
  it('catches the relative import in login.ts', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/login.ts',
      `import { TenantContext } from '../tenant-context.ts'
       export function use() { return TenantContext.run }`,
    )
    expect(
      matching(messages, 'architecture re-review C2, 2026-09-27'),
      'importing TenantContext by its relative path in login.ts must be caught',
    ).toHaveLength(1)
  })

  it('catches the relative import in refresh.ts', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/refresh.ts',
      `import { TenantContext } from '../tenant-context.ts'
       export function use() { return TenantContext.run }`,
    )
    expect(
      matching(messages, 'architecture re-review C2, 2026-09-27'),
      'importing TenantContext by its relative path in refresh.ts must be caught',
    ).toHaveLength(1)
  })

  it('catches TenantContext named off the package surface too, not just the relative path', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/login.ts',
      `import { TenantContext } from '@finsoft/database'
       export function use() { return TenantContext.run }`,
    )
    expect(
      matching(messages, 'architecture re-review C2, 2026-09-27'),
      'importing the named export from the package surface must be caught too, not only the relative path',
    ).toHaveLength(1)
  })

  it('leaves every OTHER import from that surface alone (withTenant is not TenantContext)', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/login.ts',
      `import { withTenant } from '@finsoft/database'
       export function use() { return withTenant }`,
    )
    expect(matching(messages, 'architecture re-review C2, 2026-09-27')).toEqual([])
  })

  it('does not fire on a sibling file in the same directory (session.ts), which is not in scope', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/session.ts',
      `import { TenantContext } from '../tenant-context.ts'
       export function use() { return TenantContext.run }`,
    )
    expect(matching(messages, 'architecture re-review C2, 2026-09-27')).toEqual([])
  })
})

describe('withTenantAsPrincipal is importable only from permission.guard.ts (M1-X, Council T1)', () => {
  it('catches the import in an ordinary apps/api file', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })

  it('catches the import in the request-scoping interceptor too — it is not the allowed caller', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/tenant-context.interceptor.ts',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })

  it('catches the import in packages/auth', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })

  it('leaves permission.guard.ts alone, the one allowed importer', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/permission.guard.ts',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toEqual([])
  })
})

describe('TenantContext is importable only by the interceptor, the outbox dispatcher, database and auth (M1-X, Council T2; worker exemption narrowed per Arch R2)', () => {
  it('catches it in a module', async () => {
    const messages = await messagesFor(
      'modules/sales/application/service.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches it in a kernel', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/post.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches an ordinary apps/api file', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches PermissionGuard too — it uses withTenantAsPrincipal, never TenantContext directly', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/permission.guard.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches another package (permissions)', async () => {
    const messages = await messagesFor(
      'packages/permissions/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches packages/validation', async () => {
    const messages = await messagesFor(
      'packages/validation/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('catches an aliased import — importNames matches the imported name, not the local binding', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { TenantContext as T } from '@finsoft/database'
       export const use = T`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it("still catches it even when the code goes on to use bracket access (TenantContext['run'])", async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export const run = TenantContext['run']`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('still catches it even when the code goes on to destructure (const { run } = TenantContext)', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       const { run } = TenantContext
       export { run }`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('leaves the request-scoping interceptor alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/tenant-context.interceptor.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toEqual([])
  })

  it('leaves the outbox dispatcher alone, the one allowed caller in apps/worker', async () => {
    const messages = await messagesFor(
      'apps/worker/src/outbox/dispatcher.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toEqual([])
  })

  /*
   * Council re-review Arch R2: the earlier exemption covered apps/worker/**
   * wholesale; it now names apps/worker/src/outbox/dispatcher.ts
   * specifically. This proves the narrowing actually narrowed something —
   * an ordinary job file elsewhere in apps/worker is caught exactly like
   * any other apps/** file.
   */
  it('catches it in an ordinary apps/worker job file — the dispatcher is the only exemption', async () => {
    const messages = await messagesFor(
      'apps/worker/src/jobs/x.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it('leaves packages/auth alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toEqual([])
  })

  it('leaves packages/database alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'packages/database/src/thing.ts',
      `import { TenantContext } from './tenant-context.ts'
       export const use = TenantContext`,
    )
    expect(matching(messages, 'M1-X T2')).toEqual([])
  })
})

describe('@finsoft/database/testing is importable only from a test file (M1-X, Council re-review 1)', () => {
  it('catches it in an ordinary apps/api file', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a module', async () => {
    const messages = await messagesFor(
      'modules/sales/application/thing.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a kernel', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/thing.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in another package (permissions)', async () => {
    const messages = await messagesFor(
      'packages/permissions/src/thing.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in packages/auth, which is otherwise allowed to import TenantContext directly', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a tools/ script that is not tools/seed/**', async () => {
    const messages = await messagesFor(
      'tools/db/thing.mjs',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it even in tools/seed/**, which is allowed to import provisioning but not testing', async () => {
    const messages = await messagesFor(
      'tools/seed/thing.mjs',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('leaves a test file alone', async () => {
    const messages = await messagesFor(
      'tests/integration/thing.spec.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toEqual([])
  })

  /*
   * Security seat, final check on a7576ac (medium): the request-scoping
   * interceptor and the outbox dispatcher are excluded (`ignores`) from the
   * general apps/** TenantContext-ban block so their own legitimate
   * TenantContext import is not caught — but with no block of their own,
   * that exclusion let them escape every OTHER ban that block carries too,
   * including this one. A dedicated block now covers them.
   */
  it('catches it in the request-scoping interceptor, which is otherwise allowed to import TenantContext directly', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/tenant-context.interceptor.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in the outbox dispatcher, which is otherwise allowed to import TenantContext directly', async () => {
    const messages = await messagesFor(
      'apps/worker/src/outbox/dispatcher.ts',
      `import { runAs } from '@finsoft/database/testing'
       export const use = runAs`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })
})

describe('@finsoft/database/provisioning is importable only from tools/seed/** or a test file (M1-X, Council re-review 1)', () => {
  it('catches it in an ordinary apps/api file', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a module', async () => {
    const messages = await messagesFor(
      'modules/sales/application/thing.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a kernel', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/thing.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in packages/auth', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in a tools/ script that is not tools/seed/**', async () => {
    const messages = await messagesFor(
      'tools/db/thing.mjs',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('allows it from a tools/seed/** file', async () => {
    const messages = await messagesFor(
      'tools/seed/thing.mjs',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toEqual([])
  })

  /*
   * Security seat, final check on a7576ac (medium): same gap as testing's
   * own describe block above — the interceptor and the dispatcher escaped
   * this ban too, with no block of their own to catch it.
   */
  it('catches it in the request-scoping interceptor, which is otherwise allowed to import TenantContext directly', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/tenant-context.interceptor.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('catches it in the outbox dispatcher, which is otherwise allowed to import TenantContext directly', async () => {
    const messages = await messagesFor(
      'apps/worker/src/outbox/dispatcher.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it('leaves a test file alone', async () => {
    const messages = await messagesFor(
      'tests/integration/thing.spec.ts',
      `import { createTenant } from '@finsoft/database/provisioning'
       export const use = createTenant`,
    )
    expect(matching(messages, 'Council re-review 1')).toEqual([])
  })
})

describe('tools/ scripts still carry the repo-wide decimal-library and request-scope bans (Security seat, final check on a7576ac, low regression)', () => {
  /*
   * The two tools/ script blocks this task added for the testing/
   * provisioning bans (eslint.config.mjs) each set no-restricted-imports —
   * which, for every file they match, REPLACES the repo-wide block's own
   * setting (DECIMAL_LIB_IMPORT_PATHS + REQUEST_SCOPE_IMPORT_BAN) rather
   * than adding to it. Without restating both lists in both blocks, every
   * tools/ script silently lost protection it had before this task touched
   * the file at all.
   */
  it('catches a decimal library imported from an ordinary tools/ script', async () => {
    const messages = await messagesFor(
      'tools/db/thing.mjs',
      `import Decimal from 'decimal.js'
       export const use = Decimal`,
    )
    expect(matching(messages, 'ADR-0011/ADR-0014')).toHaveLength(1)
  })

  it('catches a decimal library imported from tools/seed/**', async () => {
    const messages = await messagesFor(
      'tools/seed/thing.mjs',
      `import Decimal from 'decimal.js'
       export const use = Decimal`,
    )
    expect(matching(messages, 'ADR-0011/ADR-0014')).toHaveLength(1)
  })

  it('catches @finsoft/database/request-scope imported from an ordinary tools/ script', async () => {
    const messages = await messagesFor(
      'tools/db/thing.mjs',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })

  it('catches @finsoft/database/request-scope imported from tools/seed/**', async () => {
    const messages = await messagesFor(
      'tools/seed/thing.mjs',
      `import { withTenantAsPrincipal } from '@finsoft/database/request-scope'
       export const use = withTenantAsPrincipal`,
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })
})

describe('auth_lookup is restricted to packages/database (Architecture seat A1)', () => {
  it('catches the identifier in a string literal outside packages/database', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `export const q = "select * from auth_lookup.resolve_refresh($1)"`,
    )
    expect(matching(messages, 'auth_lookup is migration 006')).toHaveLength(1)
  })

  it('catches the identifier in a template literal (the sql tag form)', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      "import { sql } from 'kysely'\n" +
        'export const q = sql`select * from auth_lookup.resolve_refresh(${1})`',
    )
    expect(matching(messages, 'auth_lookup is migration 006')).not.toHaveLength(0)
  })

  it('leaves packages/database alone, which is the one place it belongs', async () => {
    const messages = await messagesFor(
      'packages/database/src/auth/resolvers.ts',
      `export const q = 'select tenant_id, token_id from auth_lookup.resolve_refresh($1)'`,
    )
    expect(matching(messages, 'auth_lookup is migration 006')).toEqual([])
  })
})

describe('packages/permissions may not construct queries either (Architecture seat ruling, M1-R)', () => {
  /*
   * packages/permissions is not on depcruise's kysely-is-allowlisted list
   * (docs/briefs/M1-R-rbac.md) — the RBAC query bodies live in
   * packages/database/src/rbac/*.ts, and packages/permissions calls them. A
   * transaction handle arriving through a callback is invisible to
   * dependency-cruiser's module graph exactly the way apps/**'s was, so this
   * is the same rule, extended to a second directory.
   */
  it('catches a query built on a transaction handle received through a callback', async () => {
    const messages = await messagesFor(
      'packages/permissions/src/resolve.ts',
      `import { withTenant } from '@finsoft/database'
       export function resolve(userId: string) {
         return withTenant(async (tx) => {
           return tx.selectFrom('role_permissions').select('permission_code').execute()
         })
       }`,
    )
    expect(
      matching(messages, 'apps/** contains no query construction'),
      'packages/permissions must call packages/database/src/rbac, never build the query itself',
    ).toHaveLength(1)
  })

  it('leaves packages/database alone, which is where the query body actually lives', async () => {
    const messages = await messagesFor(
      'packages/database/src/rbac/resolve-permissions.ts',
      `export function read(tx: any) { return tx.selectFrom('role_permissions').select('permission_code').execute() }`,
    )
    expect(matching(messages, 'apps/** contains no query construction')).toEqual([])
  })
})

const KERNEL_LOGIC = 'packages/accounting-kernel keeps its query bodies in src/queries/**'
const JOURNAL = 'journal_entries and journal_lines are written only by'
const PARTIES = 'ADR-0026 Compliance 7'

describe('packages/accounting-kernel: query bodies only in src/queries/** (ADR-0005, ADR-0026, M2-A)', () => {
  /*
   * The kernel DOES build queries — ADR-0005 puts the journal writes in it
   * and ADR-0026 puts registerParty's INSERT in it, not in packages/database.
   * What it may not do is build them in the posting pipeline, the reversal
   * engine or a rule. A handle arriving through a callback is invisible to
   * dependency-cruiser, so this is the only mechanism that sees it.
   */
  it('catches a builder query in kernel business logic', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/posting-engine.ts',
      `import type { TenantTx } from '@finsoft/database'
       export function post(tx: TenantTx) {
         return tx.selectFrom('journal_entries').select('id').execute()
       }`,
    )
    expect(matching(messages, KERNEL_LOGIC)).toHaveLength(1)
  })

  it('catches an sql`` tag in kernel business logic', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/rules/journal-voucher.ts',
      "import { sql } from 'kysely'\nexport const q = sql`select 1`",
    )
    expect(matching(messages, KERNEL_LOGIC)).toHaveLength(1)
  })

  it('catches the parties INSERT placed in kernel logic rather than src/queries/', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/parties.ts',
      `export function registerParty(tx: any) { return tx.insertInto('parties').values({}).execute() }`,
    )
    expect(matching(messages, KERNEL_LOGIC)).toHaveLength(1)
  })

  it('leaves src/queries/** alone — the one place the journal and parties are written', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/queries/journal-writes.ts',
      "import { sql } from 'kysely'\n" +
        `export async function w(tx: any) {
           await tx.insertInto('journal_entries').values({}).execute()
           await tx.insertInto('journal_lines').values({}).execute()
           await tx.updateTable('journal_entries').set({}).execute()
           await tx.insertInto('parties').values({}).execute()
         }`,
    )
    expect(matching(messages, KERNEL_LOGIC)).toEqual([])
    expect(matching(messages, JOURNAL)).toEqual([])
    expect(matching(messages, PARTIES)).toEqual([])
    expect(matching(messages, TX_CONTROL)).toEqual([])
  })

  it('still bans auth_lookup in the kernel (a later block must restate it, not drop it)', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/reversal.ts',
      `export const s = 'select * from auth_lookup.resolve_refresh($1)'`,
    )
    expect(matching(messages, 'auth_lookup is migration 006')).toHaveLength(1)
  })

  it('does not fire on a kernel spec file', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/post.spec.ts',
      `export function w(tx: any) { return tx.selectFrom('journal_entries') }`,
    )
    expect(matching(messages, KERNEL_LOGIC)).toEqual([])
  })
})

const TX_CONTROL = 'ADR-0027 (K1): packages/accounting-kernel issues no transaction control'
const JOURNAL_WRITES = 'packages/accounting-kernel/src/queries/journal-writes.ts'

describe('packages/accounting-kernel issues no transaction control but the numbering savepoint (ADR-0027, K1)', () => {
  /*
   * The kernel runs inside the caller's transaction. ADR-0027 sanctions one
   * savepoint, by one name, in one file, as three whole statements. Every
   * other transaction-control statement anywhere in the kernel — including a
   * differently-named savepoint in that same file — must fail the build.
   */
  const inQueries = (statement: string) =>
    "import { sql } from 'kysely'\n" +
    `export async function w(tx: any) { await sql\`${statement}\`.execute(tx) }`

  it.each([
    'SAVEPOINT finsoft_posting_number',
    'RELEASE SAVEPOINT finsoft_posting_number',
    'ROLLBACK TO SAVEPOINT finsoft_posting_number',
  ])('allows exactly `%s` in journal-writes.ts', async (statement) => {
    const messages = await messagesFor(JOURNAL_WRITES, inQueries(statement))
    expect(matching(messages, TX_CONTROL)).toEqual([])
  })

  it.each([
    // The case that used to pass as a "leave src/queries alone" fixture.
    ['a savepoint named s', 'SAVEPOINT s'],
    ['a near-miss name', 'SAVEPOINT finsoft_posting_number_2'],
    ['RELEASE of another savepoint', 'RELEASE SAVEPOINT s'],
    ['ROLLBACK TO another savepoint', 'ROLLBACK TO SAVEPOINT s'],
    ['a second statement appended', 'RELEASE SAVEPOINT finsoft_posting_number; COMMIT'],
    ['a bare ROLLBACK', 'ROLLBACK'],
    ['COMMIT', 'COMMIT'],
    ['BEGIN', 'BEGIN'],
    ['SET TRANSACTION', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'],
  ])('rejects %s even inside journal-writes.ts', async (_label, statement) => {
    const messages = await messagesFor(JOURNAL_WRITES, inQueries(statement))
    expect(matching(messages, TX_CONTROL)).toHaveLength(1)
  })

  it('rejects a dynamically named savepoint in journal-writes.ts', async () => {
    const messages = await messagesFor(
      JOURNAL_WRITES,
      "import { sql } from 'kysely'\n" +
        'export async function w(tx: any, n: string) { await sql`SAVEPOINT ${sql.id(n)}`.execute(tx) }',
    )
    expect(matching(messages, TX_CONTROL)).toHaveLength(1)
  })

  it.each([
    [
      'ROLLBACK in another queries file',
      'packages/accounting-kernel/src/queries/periods.ts',
      'ROLLBACK',
    ],
    [
      'COMMIT in another queries file',
      'packages/accounting-kernel/src/queries/parties.ts',
      'COMMIT',
    ],
    [
      'the ALLOWED statement, outside journal-writes.ts',
      'packages/accounting-kernel/src/queries/periods.ts',
      'ROLLBACK TO SAVEPOINT finsoft_posting_number',
    ],
    [
      'START TRANSACTION in a new queries file',
      'packages/accounting-kernel/src/queries/anything.ts',
      'START TRANSACTION',
    ],
  ])('rejects %s', async (_label, file, statement) => {
    const messages = await messagesFor(file, inQueries(statement))
    expect(matching(messages, TX_CONTROL)).toHaveLength(1)
  })

  it.each([
    [
      'ROLLBACK via sql.raw in the reversal engine',
      'packages/accounting-kernel/src/reversal.ts',
      `import { sql } from 'kysely'\nexport const r = (tx: any) => sql.raw('ROLLBACK').execute(tx)`,
    ],
    [
      'COMMIT via a raw compiled query in the posting engine',
      'packages/accounting-kernel/src/posting-engine.ts',
      `export const c = (tx: any, q: any) => tx.executeQuery(q.raw('COMMIT'))`,
    ],
    [
      'Kysely savepoint() in a rule',
      'packages/accounting-kernel/src/rules/journal-voucher.ts',
      `export const s = (trx: any) => trx.savepoint('sp').execute()`,
    ],
    [
      'Kysely commit() in the period engine',
      'packages/accounting-kernel/src/periods.ts',
      `export const c = (trx: any) => trx.commit().execute()`,
    ],
    [
      'Kysely rollbackToSavepoint() in a queries file',
      'packages/accounting-kernel/src/queries/journal-writes.ts',
      `export const r = (trx: any) => trx.rollbackToSavepoint('finsoft_posting_number').execute()`,
    ],
  ])('rejects %s', async (_label, file, code) => {
    const messages = await messagesFor(file, code)
    expect(matching(messages, TX_CONTROL)).toHaveLength(1)
  })

  it('does not fire on prose or on a CASE ... END inside a query', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/queries/periods.ts',
      "import { sql } from 'kysely'\n" +
        `export const m = 'does not balance at commit; rollback happens in the caller'
         export const q = (tx: any, x: string) => sql\`SELECT CASE WHEN a THEN \${x}
           END AS b FROM t\`.execute(tx)`,
    )
    expect(matching(messages, TX_CONTROL)).toEqual([])
  })

  it('leaves the real journal-writes.ts and the rest of the kernel clean', async () => {
    const results = await eslint.lintFiles(['packages/accounting-kernel/src/**/*.ts'])
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.message.includes(TX_CONTROL))
        .map((m) => `${r.filePath}:${m.line}`),
    )
    expect(hits).toEqual([])
    const jw = results.find((r) => r.filePath.replace(/\\/g, '/').endsWith(JOURNAL_WRITES))
    expect(jw, 'journal-writes.ts was linted').toBeDefined()
  })
})

describe('the journal is written only by the kernel (ADR-0005 Compliance)', () => {
  it.each([
    [
      'modules/sales/infrastructure/invoice-repo.ts',
      `export const w = (tx: any) => tx.insertInto('journal_entries').values({}).execute()`,
    ],
    [
      'modules/sales/infrastructure/invoice-repo.ts',
      `export const w = (tx: any) => tx.insertInto('journal_lines as jl').values({}).execute()`,
    ],
    [
      'modules/banking/infrastructure/repo.ts',
      `export const w = (tx: any) => tx.updateTable('journal_entries').set({}).execute()`,
    ],
    [
      'modules/banking/infrastructure/repo.ts',
      `export const w = (tx: any) => tx.deleteFrom('journal_lines').execute()`,
    ],
    [
      'apps/api/src/admin/fix.ts',
      "import { sql } from 'kysely'\nexport const q = sql`INSERT INTO journal_lines (debit) VALUES (1)`",
    ],
    [
      'apps/worker/src/jobs/import.ts',
      `export const q = 'UPDATE journal_entries SET narration = $1'`,
    ],
    [
      'packages/reporting/src/ledger.ts',
      `export const q = \`delete from public.journal_entries where id = $1\``,
    ],
    [
      'packages/database/src/accounting/customers.ts',
      `export const w = (tx: any) => tx.insertInto('journal_entries').values({}).execute()`,
    ],
    ['tools/seed/backfill.mjs', `export const q = 'insert into journal_entries (id) values ($1)'`],
  ])('fires in %s', async (file, code) => {
    expect(matching(await messagesFor(file, code), JOURNAL), `${file}: ${code}`).toHaveLength(1)
  })

  it('does not fire on a read, or on prose that merely names the table', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/invoice-repo.ts',
      `export const r = (tx: any) => tx.selectFrom('journal_entries').select('id').execute()
       export const note = 'balances come from journal_lines'`,
    )
    expect(matching(messages, JOURNAL)).toEqual([])
  })

  it('fires inside packages/database too — no production exemption remains (ADR-0005)', async () => {
    // The former named exemption for packages/database/src/accounting/journal.ts
    // is gone with insertJournalEntry/markEntryReversed: every module may
    // import packages/database, so a journal write there is a kernel bypass.
    for (const file of [
      'packages/database/src/accounting/journal.ts',
      'packages/database/src/accounting/ledger.ts',
    ]) {
      const messages = await messagesFor(
        file,
        `export const w = (tx: any) => tx.insertInto('journal_entries').values({}).execute()`,
      )
      expect(matching(messages, JOURNAL), file).toHaveLength(1)
    }
  })
})

describe('the parties register is written only by the kernel (ADR-0026 Compliance 7)', () => {
  it.each([
    [
      'modules/sales/infrastructure/customer-repo.ts',
      `export const w = (tx: any) => tx.insertInto('parties').values({}).execute()`,
    ],
    [
      'modules/sales/infrastructure/customer-repo.ts',
      `export const w = (tx: any) => tx.updateTable('parties').set({}).execute()`,
    ],
    [
      'modules/sales/infrastructure/customer-repo.ts',
      `export const w = (tx: any) => tx.deleteFrom('parties').execute()`,
    ],
    // Including inside packages/database, which every module may import.
    [
      'packages/database/src/accounting/customers.ts',
      `export const w = (tx: any) => tx.insertInto('parties').values({}).execute()`,
    ],
    [
      'packages/database/src/accounting/journal.ts',
      `export const w = (tx: any) => tx.insertInto('parties').values({}).execute()`,
    ],
    [
      'modules/sales/infrastructure/customer-repo.ts',
      "import { sql } from 'kysely'\nexport const q = sql`select id from parties where tenant_id = ${'x'}`",
    ],
    [
      'apps/api/src/admin/fix.ts',
      `export const q = 'INSERT INTO parties (tenant_id, party_type) VALUES ($1, $2)'`,
    ],
  ])('fires in %s', async (file, code) => {
    expect(matching(await messagesFor(file, code), PARTIES), `${file}: ${code}`).toHaveLength(1)
  })

  it('does not fire on a builder read, or on unrelated text', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/customer-repo.ts',
      `export const r = (tx: any) => tx.selectFrom('parties').select('id').execute()
       export const note = 'third parties are not parties to this contract'`,
    )
    expect(matching(messages, PARTIES)).toEqual([])
  })
})

describe('connection ownership (ADR-0013, ADR-0004)', () => {
  it('catches a transaction opened outside packages/database', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `export function go(db: any) { return db.transaction().execute(async () => {}) }`,
    )
    expect(matching(messages, 'transactions are opened only in packages/database')).toHaveLength(1)
  })

  it('catches app.tenant_id being set anywhere else (ADR-0004 Compliance)', async () => {
    const messages = await messagesFor(
      'modules/sales/application/service.ts',
      `export const SQL = "select set_config('app.tenant_id', $1, true)"`,
    )
    expect(matching(messages, 'only code that sets app.tenant_id')).toHaveLength(1)
  })

  it('catches a forged TenantTx', async () => {
    // The brand is forgeable with `as`; the runtime registry catches it at
    // use, this catches it at build.
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `type TenantTx = unknown
       export function forge(x: unknown) { return x as TenantTx }`,
    )
    expect(matching(messages, 'a brand is forgeable')).toHaveLength(1)
  })

  it('allows all three inside packages/database', async () => {
    const messages = await messagesFor(
      'packages/database/src/transaction.ts',
      `type TenantTx = unknown
       export function go(db: any, x: unknown) {
         const SQL = "select set_config('app.tenant_id', $1, true)"
         db.transaction().execute(async () => {})
         return [SQL, x as TenantTx]
       }`,
    )
    expect(matching(messages, 'transactions are opened only')).toEqual([])
    expect(matching(messages, 'only code that sets app.tenant_id')).toEqual([])
    expect(matching(messages, 'a brand is forgeable')).toEqual([])
  })
})

describe('the money and DDL guards (ADR-0011, ADR-0013)', () => {
  it('catches a type parser override in either call form', async () => {
    const viaReceiver = await messagesFor(
      'apps/api/src/boot.ts',
      `import pg from 'pg'
       pg.types.setTypeParser(1700, parseFloat)`,
    )
    const bare = await messagesFor(
      'apps/api/src/boot.ts',
      `import { setTypeParser } from 'pg-types'
       setTypeParser(1700, Number)`,
    )

    expect(matching(viaReceiver, 'type parser overrides are forbidden').length).toBeGreaterThan(0)
    expect(matching(bare, 'type parser overrides are forbidden').length).toBeGreaterThan(0)
  })

  it('catches a DDL builder regardless of what the receiver is called', async () => {
    // An earlier selector keyed on identifiers named db/tx/trx/kysely, which
    // fullDb().schema.createTable(...) walked straight past.
    const messages = await messagesFor(
      'packages/reporting/src/x.ts',
      `export function ddl(anythingAtAll: any) {
         return anythingAtAll.schema.createTable('t').execute()
       }`,
    )
    expect(matching(messages, 'DDL belongs in database/migrations')).toHaveLength(1)
  })

  it('catches sql.raw, which does not parameterise', async () => {
    /*
     * Added because ADR-0013's Compliance claimed this rule had a negative
     * control and it did not — `sql.raw` appeared nowhere in the repository
     * except in the selector and its own message. A rule whose only two
     * occurrences are its own definition has never been observed to fire.
     */
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `import { sql } from 'kysely'
       export const q = (t: string) => sql.raw('select * from ' + t)`,
    )
    expect(matching(messages, 'sql.raw does not parameterise')).toHaveLength(1)
  })

  it('leaves the sql TAG alone, which is the sanctioned form', async () => {
    /*
     * Without this the rule above would pass against a selector that banned
     * every use of `sql`, which would be unusable and would be "fixed" by
     * deleting it.
     */
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `import { sql } from 'kysely'
       export const q = (id: string) => sql\`select * from t where id = \${id}\``,
    )
    expect(matching(messages, 'sql.raw does not parameterise')).toHaveLength(0)
  })

  it("catches Kysely's Migrator, which would take DDL out of the .sql files", async () => {
    /*
     * Same reason as sql.raw: the claimed negative control did not exist.
     * `Migrator` appeared only in the selector and in one comment.
     */
    const messages = await messagesFor(
      'packages/database/src/x.ts',
      `import { Migrator } from 'kysely'
       export const m = (db: any) => new Migrator({ db, provider: null as any })`,
    )
    expect(matching(messages, "Kysely's Migrator is not used")).toHaveLength(1)
  })

  it('catches clearWhere stripping the tenant predicate', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `export function strip(q: any) { return q.clearWhere() }`,
    )
    expect(matching(messages, 'Stripping a query clause')).toHaveLength(1)
  })

  it('catches a decimal library imported outside packages/validation', async () => {
    const messages = await messagesFor(
      'modules/sales/domain/price.ts',
      `import Decimal from 'decimal.js'
       export const x = new Decimal('1')`,
    )
    expect(matching(messages, 'import Money from @finsoft/validation').length).toBeGreaterThan(0)
  })
})

describe('packages/** must stay loadable by Node type stripping', () => {
  it('catches a parameter property', async () => {
    // Invisible to every test, because Vitest transpiles. It only surfaces
    // when Node loads the module — which is how BaseRepository shipped
    // unloadable and passed 200-odd tests.
    const messages = await messagesFor(
      'packages/database/src/thing.ts',
      `export class Thing { constructor(private readonly a: string) {} }`,
    )
    expect(matching(messages, 'strip-only mode cannot load a parameter property')).toHaveLength(1)
  })

  it('allows one in apps/**, where SWC compiles and NestJS needs it', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `export class Thing { constructor(private readonly a: string) {} }`,
    )
    expect(matching(messages, 'strip-only mode cannot load a parameter property')).toEqual([])
  })
})

describe('services log through the logger, not console (ADR-0016)', () => {
  /*
   * The global rule allows console.warn and console.error, which is right for
   * scripts and wrong for a long-running service: a bare console.error writes
   * UNSTRUCTURED text to the same stdout the JSON pipeline reads. The
   * aggregator gets a line with no level, no correlation id and no redaction —
   * carrying whatever the developer interpolated into it.
   *
   * These also pin the flat-config trap that made the first attempt useless:
   * raising the severity alone KEEPS the inherited `allow` list, so the rule
   * reads as tightened and enforces nothing new. If someone rewrites the block
   * as `'no-console': 'error'`, the console.error cases below go green again.
   */
  it.each(['apps/api/src/thing.ts', 'apps/worker/src/thing.ts', 'modules/sales/api/thing.ts'])(
    'bans console.error in %s',
    async (filePath) => {
      const messages = await messagesFor(filePath, `export const f = () => console.error('x')`)
      expect(matching(messages, 'Unexpected console statement')).toHaveLength(1)
    },
  )

  it('bans console.log and console.warn in a service too', async () => {
    for (const method of ['log', 'warn', 'info', 'debug']) {
      const messages = await messagesFor(
        'apps/worker/src/thing.ts',
        `export const f = () => console.${method}('x')`,
      )
      expect(
        matching(messages, 'Unexpected console statement'),
        `console.${method} must be banned in a service`,
      ).toHaveLength(1)
    }
  })

  /*
   * ADR-0016 §2 rules that these five packages may log, through
   * @finsoft/observability and never through console. The rule below is what
   * makes the second half of that sentence true: until it existed, §2 stated
   * a boundary in a LEVEL 1 record with no mechanism behind it, the repo-wide
   * `['warn', { allow: ['warn', 'error'] }]` stood for packages/**, and the
   * ADR's own named first consumer — packages/database/src/pool.ts — used
   * console.error legally.
   */
  it.each([
    'packages/database/src/pool.ts',
    'packages/auth/src/session.ts',
    'packages/permissions/src/check.ts',
    'packages/reporting/src/trial-balance.ts',
    'packages/validation/src/money.ts',
  ])('bans console.error in %s, the packages ADR-0016 §2 rules on', async (filePath) => {
    const messages = await messagesFor(filePath, `export const f = () => console.error('x')`)
    expect(
      matching(messages, 'Unexpected console statement'),
      'ADR-0016 §2: these packages log through @finsoft/observability, never through console',
    ).toHaveLength(1)
  })

  it('leaves the kernels and shared packages on the repo-wide rule', async () => {
    /*
     * Deliberately NOT extended to them: a kernel may not log at all, which is
     * a dependency-cruiser rule, not a console rule. Banning console there too
     * would make the weaker mechanism look like the one doing the work.
     */
    const messages = await messagesFor(
      'packages/accounting-kernel/src/post.ts',
      `export const f = () => console.error('x')`,
    )
    expect(matching(messages, 'Unexpected console statement')).toHaveLength(0)
  })

  it('still allows console in a CLI, which legitimately owns stdout', async () => {
    const messages = await messagesFor(
      'packages/database/src/migrate/cli.ts',
      `export const f = () => console.log('applied')`,
    )
    expect(matching(messages, 'Unexpected console statement')).toHaveLength(0)
  })

  it('leaves apps/web alone, where console is a browser concern', async () => {
    const messages = await messagesFor(
      'apps/web/src/thing.ts',
      `export const f = () => console.error('x')`,
    )
    expect(matching(messages, 'Unexpected console statement')).toHaveLength(0)
  })
})

describe('strip-only safety, per package (ADR-0013, Node type stripping)', () => {
  /*
   * Node's type stripping ERASES types; it does not TRANSFORM. A parameter
   * property, an enum or a namespace needs a transformation, so a module
   * containing one is unloadable by the runtime that ships — while
   * compiling, linting and passing every Vitest run, because Vitest
   * transpiles. That is exactly how a parameter property in BaseRepository
   * survived 200 tests.
   *
   * These rules were silently inert everywhere except packages/database.
   * ESLint flat config REPLACES a rule's options between blocks rather than
   * merging them, and a later `**` block dropped all three selectors.
   * packages/database survived only because it sat in that block's `ignores`
   * — and the one negative control that existed tested packages/database,
   * so the harness certified the single package where the rule still worked.
   *
   * Hence: every package is probed by name. A per-package table is the only
   * shape that could have caught this.
   */

  const STRIPPED = [
    'packages/validation/src/x.ts',
    'packages/database/src/x.ts',
    'packages/observability/src/x.ts',
    'packages/shared-types/src/x.ts',
    'packages/accounting-kernel/src/x.ts',
    'packages/inventory-kernel/src/x.ts',
    'packages/auth/src/x.ts',
    'packages/permissions/src/x.ts',
    'packages/reporting/src/x.ts',
    'packages/ui/src/x.ts',
    // Runs `node apps/worker/src/main.ts` directly in production.
    'apps/worker/src/x.ts',
  ]

  const FORBIDDEN = {
    'a parameter property': 'export class A { constructor(private readonly b: string) {} }',
    'an enum': 'export enum E { A, B }',
    'a namespace': 'export namespace N { export const a = 1 }',
  }

  for (const [label, code] of Object.entries(FORBIDDEN)) {
    it.each(STRIPPED)(`rejects ${label} in %s`, async (filePath) => {
      const messages = await messagesFor(filePath, code)
      expect(
        matching(messages, 'strip-only'),
        `${filePath} accepted ${label}; it would be unloadable at runtime`,
      ).not.toHaveLength(0)
    })
  }

  it('allows all three in apps/api, which is built with SWC', async () => {
    /*
     * The other half of the control. apps/api does NOT extend
     * tsconfig.packages.json, because NestJS dependency injection needs
     * emitDecoratorMetadata and parameter properties — a rule that banned
     * them there would ban the framework.
     */
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      'export class A { constructor(private readonly b: string) {} }',
    )
    expect(matching(messages, 'strip-only')).toHaveLength(0)
  })

  it('leaves valid erasable TypeScript alone', async () => {
    /*
     * A rule that rejected everything would satisfy every case above and
     * stop the packages compiling. This is the case that proves it
     * discriminates.
     */
    const erasable = `
      export interface Shape { readonly a: string }
      export type Kind = 'x' | 'y'
      export const KINDS = { X: 'x', Y: 'y' } as const
      export class Good {
        private readonly b: string
        constructor(b: string) {
          this.b = b
        }
        get value(): string {
          return this.b
        }
      }
      export function f(v: unknown): v is Shape {
        return typeof v === 'object'
      }
    `
    for (const filePath of STRIPPED) {
      const messages = await messagesFor(filePath, erasable)
      expect(
        matching(messages, 'strip-only'),
        `${filePath} rejected valid erasable code`,
      ).toHaveLength(0)
    }
  })
})

describe('app.tenant_id in a TEMPLATE LITERAL (ADR-0004)', () => {
  /*
   * The selector was `Literal[value=/app\.tenant_id/]`, and a template
   * literal's text is a TemplateElement rather than a Literal. So the rule
   * missed the sql`` form — which is the form packages/database itself uses,
   * and therefore the one anybody copying it would write.
   *
   * The harness exercised only the double-quoted string, so it certified a
   * rule that missed the realistic case. That is the failure this file exists
   * to prevent, reproduced in the file itself.
   */
  it('catches the sql`` tag form, which is what the codebase actually writes', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      'export function f(tx: any, t: string) {\n' +
        "  return tx.executeQuery(`select set_config('app.tenant_id', ${t}, true)`)\n" +
        '}',
    )
    expect(matching(messages, 'only code that sets app.tenant_id')).not.toHaveLength(0)
  })

  it('still catches the plain string form', async () => {
    const messages = await messagesFor(
      'modules/sales/infrastructure/repo.ts',
      `export const q = "select set_config('app.tenant_id', $1, true)"`,
    )
    expect(matching(messages, 'only code that sets app.tenant_id')).not.toHaveLength(0)
  })

  it('leaves packages/database alone, which is the one place it belongs', async () => {
    const messages = await messagesFor(
      'packages/database/src/transaction.ts',
      'export function f(tx: any, t: string) {\n' +
        "  return tx.executeQuery(`select set_config('app.tenant_id', ${t}, true)`)\n" +
        '}',
    )
    expect(matching(messages, 'only code that sets app.tenant_id')).toHaveLength(0)
  })

  it('catches the angle-bracket handle assertion as well as `as`', async () => {
    const angle = await messagesFor(
      'modules/sales/application/x.ts',
      'export const f = (v: unknown) => (<TenantTx>v)',
    )
    expect(matching(angle, 'never asserted')).not.toHaveLength(0)
  })
})

/* ====================================================================== *
 * ADR-0028, M3-C's first PR. C6 (decorators, strip-only, framework bans,
 * withTenant/withGlobal placement), C7 (query construction confined to
 * infrastructure/), C8 + S2 (table ownership), S1 (the platform bans still
 * fire per layer, and both TenantContext/withGlobal entries fire on the
 * same specifier).
 * ====================================================================== */

describe('modules/** has no decorators and no NestJS/HTTP framework (ADR-0028 statement 1, C6)', () => {
  it('catches a decorator in a module file', async () => {
    const messages = await messagesFor(
      'modules/customers/application/x.ts',
      '@Injectable()\nexport class X {}',
    )
    expect(matching(messages, 'modules/** has no decorators')).toHaveLength(1)
  })

  it('catches an @nestjs/* import anywhere in modules/**', async () => {
    const messages = await messagesFor(
      'modules/customers/application/x.ts',
      "import { Injectable } from '@nestjs/common'\nexport const x = Injectable",
    )
    expect(matching(messages, 'modules/** has no NestJS, express or fastify import')).toHaveLength(
      1,
    )
  })

  it('catches express and fastify too', async () => {
    for (const pkg of ['express', 'fastify']) {
      const messages = await messagesFor(
        'modules/customers/infrastructure/x.ts',
        `import x from '${pkg}'\nexport const y = x`,
      )
      expect(
        matching(messages, 'modules/** has no NestJS, express or fastify import'),
        pkg,
      ).toHaveLength(1)
    }
  })

  it('catches a parameter property, an enum and a namespace (strip-only, same as packages/*)', async () => {
    const cases = {
      'a parameter property': 'export class A { constructor(private readonly b: string) {} }',
      'an enum': 'export enum E { A, B }',
      'a namespace': 'export namespace N { export const a = 1 }',
    }
    for (const [label, code] of Object.entries(cases)) {
      const messages = await messagesFor('modules/customers/domain/x.ts', code)
      expect(matching(messages, 'strip-only'), label).not.toHaveLength(0)
    }
  })

  it('leaves the real customers.controller.ts (apps/api, SWC-built) alone — decorators belong there', async () => {
    const messages = await messagesFor(
      'apps/api/src/customers/x.controller.ts',
      "import { Controller } from '@nestjs/common'\n@Controller('x')\nexport class X {}",
    )
    expect(matching(messages, 'modules/** has no decorators')).toEqual([])
  })
})

describe('withTenant opens only inside modules/*/application/** (ADR-0028 statement 6, C6)', () => {
  it('catches withTenant imported in infrastructure/', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'withTenant is opened only inside')).toHaveLength(1)
  })

  it('catches withTenant imported in api/', async () => {
    const messages = await messagesFor(
      'modules/customers/api/x.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'withTenant is opened only inside')).toHaveLength(1)
  })

  it('catches withTenant imported in domain/ — via the STRONGER, domain-specific ban', async () => {
    // domain/ has its own, more specific no-restricted-imports block (a
    // blanket @finsoft/database ban — ARCHITECTURE §2: "domain/ never sees
    // a connection or a row type"), which flat config REPLACES the general
    // modules/** withTenant-outside-application block with. The import is
    // still caught, just by the stronger rule and a different message.
    const messages = await messagesFor(
      'modules/customers/domain/x.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'domain/ never sees a connection or a row type')).toHaveLength(1)
  })

  it("catches withTenant imported in the module's index.ts", async () => {
    const messages = await messagesFor(
      'modules/customers/index.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'withTenant is opened only inside')).toHaveLength(1)
  })

  it('leaves application/ alone — the one layer allowed to open one', async () => {
    const messages = await messagesFor(
      'modules/customers/application/x.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'withTenant is opened only inside')).toEqual([])
  })

  it('catches withGlobal in every non-domain layer (a module is always tenant-scoped)', async () => {
    for (const file of [
      'modules/customers/application/x.ts',
      'modules/customers/infrastructure/x.ts',
      'modules/customers/api/x.ts',
      'modules/customers/index.ts',
    ]) {
      const messages = await messagesFor(
        file,
        "import { withGlobal } from '@finsoft/database'\nexport const w = withGlobal",
      )
      expect(matching(messages, 'withGlobal is not used in modules'), file).toHaveLength(1)
    }
  })

  it('catches withGlobal in domain/ too — via the stronger, domain-specific ban', async () => {
    const messages = await messagesFor(
      'modules/customers/domain/x.ts',
      "import { withGlobal } from '@finsoft/database'\nexport const w = withGlobal",
    )
    expect(matching(messages, 'domain/ never sees a connection or a row type')).toHaveLength(1)
  })

  it('the withTenant-outside-application ban has no spec/test exemption — it fires on a module spec file too', async () => {
    // Unlike the C6/C7/C8 syntax blocks (which DO ignore *.spec.ts/*.test.ts),
    // this specific no-restricted-imports block carries no such exemption.
    // ADR-0028 statement 10's unit tests are domain/api-contract tests with
    // "no database" — they have no legitimate reason to import withTenant
    // either, so the stricter behaviour is intentional, not a gap; pinned
    // here so a future change to the ignore list is a deliberate edit.
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.spec.ts',
      "import { withTenant } from '@finsoft/database'\nexport const w = withTenant",
    )
    expect(matching(messages, 'withTenant is opened only inside')).toHaveLength(1)
  })
})

describe('S1: the platform bans still fire, per module layer, and both entries fire on one specifier', () => {
  const layers = [
    'modules/customers/api/x.ts',
    'modules/customers/application/x.ts',
    'modules/customers/infrastructure/x.ts',
    'modules/customers/index.ts',
  ]

  it.each(layers)('TenantContext still fires in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "import { TenantContext } from '@finsoft/database'\nexport const t = TenantContext",
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
  })

  it.each(layers)('@finsoft/database/testing still fires in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "import { runAs } from '@finsoft/database/testing'\nexport const r = runAs",
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it.each(layers)('@finsoft/database/provisioning still fires in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "import { createTenant } from '@finsoft/database/provisioning'\nexport const c = createTenant",
    )
    expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
  })

  it.each(layers)('@finsoft/database/request-scope still fires in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "import { withTenantAsPrincipal } from '@finsoft/database/request-scope'\nexport const w = withTenantAsPrincipal",
    )
    expect(matching(messages, 'M1-X T1')).toHaveLength(1)
  })

  it.each(layers)('pg still fires in %s (S1)', async (file) => {
    const messages = await messagesFor(file, "import { Pool } from 'pg'\nexport const p = Pool")
    expect(matching(messages, 'the pg driver lives in packages/database only')).toHaveLength(1)
  })

  it.each(layers)('@finsoft/database/auth still fires in %s (S1)', async (file) => {
    const messages = await messagesFor(
      file,
      "import { findLoginCandidate } from '@finsoft/database/auth'\nexport const f = findLoginCandidate",
    )
    expect(matching(messages, 'the auth/login query surface')).toHaveLength(1)
  })

  it('both the withGlobal ban AND the TenantContext ban fire on the same @finsoft/database specifier', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { TenantContext, withGlobal } from '@finsoft/database'\nexport const x = [TenantContext, withGlobal]",
    )
    expect(matching(messages, 'M1-X T2')).toHaveLength(1)
    expect(matching(messages, 'withGlobal is not used in modules')).toHaveLength(1)
  })

  /*
   * S1 domain (Security seat, Council review, 2026-09-29): domain/ has its
   * OWN, more specific no-restricted-imports block (a blanket
   * '@finsoft/database' ban), which flat config REPLACES the shared
   * MODULES_IMPORT_BAN_PATHS block with for files under domain/ — so this
   * layer needs its own proof, not a fold into `layers` above. Before this
   * fix, '@finsoft/database/auth' and '@finsoft/database/request-scope'
   * were reachable from domain/ despite the blanket ban's own stated intent
   * ("domain/ never sees a connection or a row type") — the blanket ban
   * matches only the bare specifier, exactly the subpath-specifier gap this
   * block's own comment already names for TESTING_IMPORT_BAN/
   * PROVISIONING_IMPORT_BAN, just not, until now, for these two.
   */
  describe('domain/ carries the same subpath bans, via its own stricter block', () => {
    it('@finsoft/database/request-scope fires in domain/', async () => {
      const messages = await messagesFor(
        'modules/customers/domain/x.ts',
        "import { withTenantAsPrincipal } from '@finsoft/database/request-scope'\nexport const w = withTenantAsPrincipal",
      )
      expect(matching(messages, 'M1-X T1')).toHaveLength(1)
    })

    it('@finsoft/database/auth fires in domain/', async () => {
      const messages = await messagesFor(
        'modules/customers/domain/x.ts',
        "import { findLoginCandidate } from '@finsoft/database/auth'\nexport const f = findLoginCandidate",
      )
      expect(matching(messages, 'the auth/login query surface')).toHaveLength(1)
    })

    it('@finsoft/database/testing still fires in domain/ (pre-existing, restated for completeness)', async () => {
      const messages = await messagesFor(
        'modules/customers/domain/x.ts',
        "import { runAs } from '@finsoft/database/testing'\nexport const r = runAs",
      )
      expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
    })

    it('@finsoft/database/provisioning still fires in domain/ (pre-existing, restated for completeness)', async () => {
      const messages = await messagesFor(
        'modules/customers/domain/x.ts',
        "import { createTenant } from '@finsoft/database/provisioning'\nexport const c = createTenant",
      )
      expect(matching(messages, 'Council re-review 1')).toHaveLength(1)
    })

    it('the bare @finsoft/database specifier is caught by the stricter blanket ban, not the M1-X T2 one', async () => {
      const messages = await messagesFor(
        'modules/customers/domain/x.ts',
        "import { TenantContext } from '@finsoft/database'\nexport const t = TenantContext",
      )
      expect(matching(messages, 'domain/ never sees a connection or a row type')).toHaveLength(1)
    })
  })
})

describe('C7 (ADR-0028): query construction is confined to modules/*/infrastructure/**', () => {
  const nonInfra = [
    'modules/customers/api/x.ts',
    'modules/customers/application/x.ts',
    'modules/customers/domain/x.ts',
    'modules/customers/index.ts',
  ]

  it.each(nonInfra)('catches a builder call received on a parameter, in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "export function w(tx: any) { return tx.selectFrom('customers').selectAll().execute() }",
    )
    expect(matching(messages, 'query construction lives only in')).toHaveLength(1)
  })

  it.each(nonInfra)('catches an sql`` tag in %s', async (file) => {
    const messages = await messagesFor(
      file,
      "import { sql } from 'kysely'\nexport const q = sql`select 1`",
    )
    expect(matching(messages, 'sql`` tag outside modules')).toHaveLength(1)
  })

  it('leaves infrastructure/ alone — the one layer allowed to build a query', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export function w(tx: any) { return tx.selectFrom('customers').selectAll().execute() }",
    )
    expect(matching(messages, 'query construction lives only in')).toEqual([])
  })

  it('does not fire on a spec file outside infrastructure/', async () => {
    const messages = await messagesFor(
      'modules/customers/application/x.spec.ts',
      "export function w(tx: any) { return tx.selectFrom('customers').selectAll().execute() }",
    )
    expect(matching(messages, 'query construction lives only in')).toEqual([])
  })
})

describe('C8 / S2 (ADR-0028): modules/customers/infrastructure/** names only its own table', () => {
  it('allows a literal naming customers, aliased', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export function w(tx: any) { return tx.selectFrom('customers as c').selectAll().execute() }",
    )
    expect(matching(messages, 'names only its own table')).toEqual([])
  })

  it("catches a literal that is customers with a suffix ('customers_x'), not an exact match", async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export function w(tx: any) { return tx.selectFrom('customers_x').selectAll().execute() }",
    )
    expect(matching(messages, 'names only its own table')).toHaveLength(1)
  })

  it("catches a literal naming a different table ('parties')", async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export function w(tx: any) { return tx.insertInto('parties').values({}).execute() }",
    )
    expect(matching(messages, 'names only its own table')).toHaveLength(1)
  })

  it.each([
    'selectFrom',
    'insertInto',
    'updateTable',
    'deleteFrom',
    'mergeInto',
    'innerJoin',
    'leftJoin',
  ])('catches every builder method (%s) naming another table', async (method) => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      `export function w(tx: any) { return tx.${method}('parties').execute() }`,
    )
    expect(matching(messages, 'names only its own table')).toHaveLength(1)
  })

  it('fails CLOSED on a non-literal (dynamic) table argument, even one that LOOKS like customers', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      'export function w(tx: any, t: string) { return tx.selectFrom(t).selectAll().execute() }',
    )
    expect(matching(messages, 'names only its own table')).toHaveLength(1)
  })

  it('catches a nested builder call (eb.selectFrom) naming another table', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      `export function w(tx: any) {
         return tx.selectFrom('customers').where((eb: any) => eb.selectFrom('parties').select('id'))
       }`,
    )
    expect(matching(messages, 'names only its own table')).toHaveLength(1)
  })

  /*
   * S2 (Security seat, Council review, 2026-09-29): the sql`` tag is now
   * banned OUTRIGHT in modules/*\/infrastructure/**, not merely checked for
   * naming another table — that partial check had two escapes (fragment
   * composition and a comma join, both probed below). An sql`` tag naming
   * customers ITSELF is caught too now, which is the point: no raw SQL
   * fragment is trusted to parse correctly, ever, in this layer.
   */
  it('catches an sql`` tag naming another table', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { sql } from 'kysely'\nexport const q = (tx: any) => sql`select * from parties`.execute(tx)",
    )
    expect(matching(messages, 'does not use the sql`` tag at all')).toHaveLength(1)
  })

  it('catches an sql`` tag even when it names customers itself (S2: banned outright)', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { sql } from 'kysely'\nexport const q = (tx: any) => sql`select * from customers where id = ${1}`.execute(tx)",
    )
    expect(matching(messages, 'does not use the sql`` tag at all')).toHaveLength(1)
  })

  it('S2 escape 1: a table name hidden inside an INTERPOLATED fragment is still caught (whole tag is banned)', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { sql } from 'kysely'\n" +
        'const frag = sql`users`\n' +
        'export const q = (tx: any) => sql`select * from customers c, ${frag}`.execute(tx)',
    )
    // Both tagged templates are sql`` — both are caught.
    expect(matching(messages, 'does not use the sql`` tag at all').length).toBeGreaterThanOrEqual(2)
  })

  it('S2 escape 2: a comma-joined second table in one sql`` fragment is still caught (whole tag is banned)', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { sql } from 'kysely'\n" +
        'export const q = (tx: any) => sql`select * from customers c, users u`.execute(tx)',
    )
    expect(matching(messages, 'does not use the sql`` tag at all')).toHaveLength(1)
  })

  it('leaves the sql`` tag alone OUTSIDE infrastructure/ where C7 already owns the same ban with its own message', async () => {
    const messages = await messagesFor(
      'modules/customers/application/x.ts',
      "import { sql } from 'kysely'\nexport const q = sql`select 1`",
    )
    // C7's own message ("sql`` tag outside modules...") fires instead —
    // proves the two bans are not silently doubled up or dropped.
    expect(matching(messages, 'does not use the sql`` tag at all')).toEqual([])
    expect(matching(messages, 'sql`` tag outside modules')).toHaveLength(1)
  })

  it.each(['table', 'ref'])(
    'catches sql.%s, which builds a table reference dynamically (S2)',
    async (member) => {
      const messages = await messagesFor(
        'modules/customers/infrastructure/x.ts',
        `import { sql } from 'kysely'\nexport const q = (n: string) => sql.${member}(n)`,
      )
      expect(matching(messages, 'defeats the table-ownership check by construction')).toHaveLength(
        1,
      )
    },
  )

  it('catches db.dynamic (S2)', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export const d = (db: any) => db.dynamic.ref('x')",
    )
    expect(matching(messages, 'builds a table reference from a runtime string')).toHaveLength(1)
  })

  it('catches CompiledQuery (S2)', async () => {
    // Every AST Identifier named CompiledQuery matches (the import
    // specifier's imported/local names and the usage), so this fires more
    // than once for one import + one reference — not a length-1 count.
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "import { CompiledQuery } from 'kysely'\nexport const q = CompiledQuery",
    )
    expect(
      matching(messages, 'bypassing the table-ownership check entirely').length,
    ).toBeGreaterThan(0)
  })

  it('catches executeQuery (S2)', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      'export const q = (tx: any, c: any) => tx.executeQuery(c)',
    )
    expect(matching(messages, 'bypassing the table-ownership check')).toHaveLength(1)
  })

  it('leaves a read on customers alone', async () => {
    const messages = await messagesFor(
      'modules/customers/infrastructure/x.ts',
      "export function r(tx: any) { return tx.selectFrom('customers').selectAll().execute() }",
    )
    expect(matching(messages, 'names only its own table')).toEqual([])
  })

  it('leaves the real customers.repository.ts clean', async () => {
    const results = await eslint.lintFiles(['modules/customers/infrastructure/**/*.ts'])
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.message.includes('names only its own table'))
        .map((m) => `${r.filePath}:${m.line}: ${m.message}`),
    )
    expect(hits).toEqual([])
    expect(results.length).toBeGreaterThan(0)
  })
})
