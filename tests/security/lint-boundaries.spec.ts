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

describe('TenantContext.run is confined to five places (M1-X, Council C5)', () => {
  it('catches TenantContext.run in an ordinary apps/api file', async () => {
    const messages = await messagesFor(
      'apps/api/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export function use() { return TenantContext.run({ tenantId: 'x', userId: null }, () => 1) }`,
    )
    expect(matching(messages, 'M1-X C5')).toHaveLength(1)
  })

  it('leaves the request-wide interceptor alone, the one apps/api file allowed to call it', async () => {
    const messages = await messagesFor(
      'apps/api/src/common/tenant-context.interceptor.ts',
      `import { TenantContext } from '@finsoft/database'
       export function use() { return TenantContext.run({ tenantId: 'x', userId: null }, () => 1) }`,
    )
    expect(matching(messages, 'M1-X C5')).toEqual([])
  })

  it('leaves packages/auth alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'packages/auth/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export function use() { return TenantContext.run({ tenantId: 'x', userId: null }, () => 1) }`,
    )
    expect(matching(messages, 'M1-X C5')).toEqual([])
  })

  it('leaves packages/database alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'packages/database/src/thing.ts',
      `import { TenantContext } from './tenant-context.ts'
       export function use() { return TenantContext.run({ tenantId: 'x', userId: null }, () => 1) }`,
    )
    expect(matching(messages, 'M1-X C5')).toEqual([])
  })

  it('leaves the job runner alone, an allowed caller', async () => {
    const messages = await messagesFor(
      'apps/worker/src/thing.ts',
      `import { TenantContext } from '@finsoft/database'
       export function use() { return TenantContext.run({ tenantId: 'x', userId: null }, () => 1) }`,
    )
    expect(matching(messages, 'M1-X C5')).toEqual([])
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
