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
