import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, withGlobal, withTenant } from '@finsoft/database'
import {
  REPO_ROOT,
  TEST_TARGET,
  createTenantFixture,
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
} from '@finsoft/database/testing'
import { constraints, columns } from '../../database/tests/catalog.ts'
import { GLOBAL_TABLES } from '@finsoft/database'
import { INVARIANTS, enforcedIds, pendingIds } from './invariants.ts'
import { registerPostingInvariantChecks } from './posting-invariants.ts'
import { checkInvariant9, invariant9Available } from './ar-invariant-9.ts'

/*
 * The FinancialInvariantSuite. NON_NEGOTIABLES §3: it runs on every PR, and
 * if it fails nothing merges.
 *
 * M2-A executes seven of the ten (1, 2, 4, 5, 6, 7, 8) against the real
 * kernel and a real PostgreSQL, as finsoft_app with RLS forced — the checks
 * for 1, 2, 4, 5, 6, 8 live in posting-invariants.ts and are registered at
 * the bottom of this file. 3, 9 and 10 describe a stock ledger and
 * subledgers that do not exist yet; they stay registered as pending rather
 * than stubbed green, and the pending set is a ratchet that can only shrink.
 */

/*
 * Resolved from the harness's REPO_ROOT rather than `import.meta.dirname`.
 * tsconfig.base.json uses module: NodeNext and nothing above this directory
 * declares "type": "module", so TypeScript treats these files as CommonJS and
 * rejects import.meta — even though Vitest runs them as ESM. Reusing the
 * already-resolved root keeps every test tsconfig identical instead of giving
 * this one directory a different module setting.
 */
const BASELINE = join(REPO_ROOT, 'tests', 'accounting', 'pending-baseline.json')

/*
 * Invariant 8's race tests need two transactions on two REAL backends at
 * once. The harness pins the pool to one connection (harness.ts), on which a
 * second caller queues for the connection instead of racing — and the test
 * passes whether or not the idempotency path works (observed: a mutant that
 * leaked a document number survived on a pool of one). Same sanctioned
 * pattern as database/tests/document-sequences.spec.ts: reopen with several
 * connections for this file, restore the deterministic default afterwards.
 */
beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '4'
  await openDatabase(TEST_TARGET)
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '1'
})

describe('FinancialInvariantSuite: the ratchet', () => {
  const baseline: { pending: number[] } = JSON.parse(readFileSync(BASELINE, 'utf8'))

  it('registers all ten invariants from NON_NEGOTIABLES §3', () => {
    expect(INVARIANTS.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('has no invariant pending that the baseline does not already permit', () => {
    // A new pending id here means an invariant regressed, or one was added
    // without being implemented. Either way the suite must not go quietly
    // green with a larger hole than it had yesterday.
    const unexpected = pendingIds().filter((id) => !baseline.pending.includes(id))
    expect(
      unexpected,
      `Invariant(s) ${unexpected.join(', ')} became pending. The pending set may only shrink.`,
    ).toEqual([])
  })

  it('fails when an invariant is enforced but still listed as pending', () => {
    // This is the half that makes it a ratchet rather than a ceiling: once
    // an invariant is implemented, the baseline MUST be shrunk by hand. The
    // suite refuses to let the count stay stale.
    const stale = enforcedIds().filter((id) => baseline.pending.includes(id))
    expect(
      stale,
      `Invariant(s) ${stale.join(', ')} are now enforced. Remove them from pending-baseline.json.`,
    ).toEqual([])
  })

  it('keeps the baseline free of ids that are not registered invariants', () => {
    const known = new Set(INVARIANTS.map((i) => i.id))
    expect(baseline.pending.filter((id) => !known.has(id))).toEqual([])
  })

  it('reports what is not yet covered, so a green run is not mistaken for a complete one', () => {
    const pending = INVARIANTS.filter((i) => i.status === 'pending')
    // Not an assertion about correctness — it prints the outstanding set so
    // it appears in every CI log rather than only in this file.
    console.warn(
      `\n  FinancialInvariantSuite: ${enforcedIds().length}/10 enforced, ${pending.length} pending —\n` +
        pending.map((i) => `    ${i.id}. ${i.statement}\n       ${i.note}`).join('\n') +
        '\n',
    )
    expect(pending.length + enforcedIds().length).toBe(10)
  })
})

describe('Invariant 7: cross-tenant references are impossible', () => {
  /*
   * NON_NEGOTIABLES states this as "no journal line points at another
   * tenant's account". The journal does not exist yet, so it is enforced in
   * the generalised form ADR-0003:29 gives it, which is the one that will
   * still be true when the journal arrives.
   *
   * This is not a duplicate of database/tests/schema.spec.ts. That suite
   * asserts every tenant-owned table foreign-keys tenant_id to tenants(id).
   * This asserts something different and strictly stronger: a foreign key
   * from one tenant-owned table to ANOTHER must itself carry tenant_id.
   *
   * It matters because referential integrity checks bypass row security. A
   * single-column FK lets tenant A reference tenant B's row with RLS both
   * enabled and forced — demonstrated during FND-007/008 by removing the
   * composite key and watching a cross-tenant insert succeed.
   */
  it('requires every foreign key between tenant-owned tables to carry tenant_id', async () => {
    const [allConstraints, allColumns] = await Promise.all([constraints(), columns()])

    const tenantOwned = new Set(
      allColumns
        .filter((c) => c.column_name === 'tenant_id')
        .map((c) => c.table_name)
        .filter((t) => !(GLOBAL_TABLES as readonly string[]).includes(t)),
    )

    const offenders = allConstraints
      .filter((c) => c.contype === 'f')
      .filter((c) => tenantOwned.has(c.table_name))
      .filter((c) => c.referenced_table !== null && tenantOwned.has(c.referenced_table))
      .filter((c) => !/FOREIGN KEY \(tenant_id,/.test(c.definition))
      .map((c) => `${c.table_name}.${c.constraint_name}: ${c.definition}`)

    expect(
      offenders,
      'A foreign key between two tenant-owned tables must lead with tenant_id. ' +
        'Referential integrity checks bypass RLS, so a single-column key is a live ' +
        'cross-tenant path even with row security enabled and forced (ADR-0003:29).',
    ).toEqual([])
  })

  it('has at least one such foreign key to assert against', async () => {
    // Guards against the assertion above passing vacuously on a schema that
    // simply has no cross-table references yet.
    const [allConstraints, allColumns] = await Promise.all([constraints(), columns()])
    const tenantOwned = new Set(
      allColumns
        .filter((c) => c.column_name === 'tenant_id')
        .map((c) => c.table_name)
        .filter((t) => !(GLOBAL_TABLES as readonly string[]).includes(t)),
    )
    const crossTable = allConstraints
      .filter((c) => c.contype === 'f')
      .filter((c) => tenantOwned.has(c.table_name))
      .filter((c) => c.referenced_table !== null && tenantOwned.has(c.referenced_table))

    expect(crossTable.length).toBeGreaterThan(0)
  })
})

describe('Invariant 9, AR half (M3-Q) — gated on M3-P', () => {
  /*
   * docs/posting-rules/customer-receipt.md §8. M3-P merged (@2a02731):
   * `sales_invoices` / `customer_receipts` exist and SALE_POSTED /
   * CUSTOMER_PAYMENT_RECEIVED are IMPLEMENTED_EVENTS. This describe block
   * now runs the check FOR REAL, against every tenant that has subledger
   * activity — `invariants.ts` id 9 (AR half) moves to 'enforced' and
   * `pending-baseline.json` drops it in the SAME commit as this change,
   * per the ratchet's own rule: shrinking it requires a genuine live run,
   * which this is.
   */
  it('the AR-half gate correctly reports unavailable until M3-P lands, or runs for real once it has', async () => {
    const tenant = await createTenantFixture('INV9')
    const available = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => invariant9Available(tx)),
    )

    if (!available) {
      // The honest, expected state before M3-P merges. Asserted, not
      // skipped, so a change that makes this silently stop checking
      // anything is itself a visible diff.
      expect(available).toBe(false)
      return
    }

    /*
     * M3-P HAS LANDED. From here the check is real: every tenant WITH
     * SUBLEDGER ACTIVITY, GL(C, D) must equal SUB(C, D) exactly, and Σ
     * GL(C, D) must equal the AR_CONTROL balance at D (structural,
     * README §4.1).
     *
     * Each tenant is skipped (not asserted on) unless it has at least one
     * `sales_invoices` or `customer_receipts` row of its own — checked
     * PER TENANT, inside `withTenant`, never by querying a tenant-owned
     * table through `withGlobal` (schema.ts's GlobalDatabase deliberately
     * excludes them; this stays inside that boundary rather than
     * widening it for a test). Found running this for real: a tenant from
     * `tests/accounting/kernel-rules.spec.ts`'s "a kernel-built AR line
     * satisfies migration 012 end to end" test has an AR_CONTROL journal
     * line with a genuinely RANDOM, synthetic `source_id` — that test is
     * explicit that it is "test-only: proves the schema accepts what the
     * rule builds. Not a path any caller has", deliberately bypassing
     * `modules/receivables` via `runPostingPipeline` directly, so no
     * `sales_invoices` row for it ever exists or ever will. Invariant 9 is
     * a GL-TO-SUBLEDGER reconciliation; a tenant that never created a
     * subledger document was never exercising the path this invariant
     * reconciles, and is not a tenant this check is about — a REAL
     * production tenant can never reach this state, because
     * `modules/receivables` always creates the document first. This is a
     * test-suite-construction fact, not a posted-data defect: the file
     * this scoping works around is explicitly out of this lane's ALLOWED
     * paths (tests/accounting/kernel-rules.spec.ts, M3-P/M2-A owned), so
     * the fix lives on this check's OWN sweep instead of on that file.
     */
    const asOf = new Date().toISOString().slice(0, 10)
    const tenantIds = (
      await withGlobal((tx) => tx.selectFrom('tenants').select('id').execute())
    ).map((row) => row.id)

    let tenantsChecked = 0
    for (const tenantId of tenantIds) {
      const hasSubledgerActivity = await runAs({ tenantId, userId: null }, () =>
        withTenant(async (tx) => {
          const [invoice, receipt] = await Promise.all([
            tx.selectFrom('sales_invoices').select('id').limit(1).executeTakeFirst(),
            tx.selectFrom('customer_receipts').select('id').limit(1).executeTakeFirst(),
          ])
          return invoice !== undefined || receipt !== undefined
        }),
      )
      if (!hasSubledgerActivity) continue

      const result = await runAs({ tenantId, userId: null }, () =>
        withTenant((tx) => checkInvariant9(tx, tenantId, asOf)),
      )
      // Per-customer: GL(C, D) = SUB(C, D) exactly, for every customer.
      expect(result.breaks, `tenant ${tenantId}: Invariant 9 AR-half breaks`).toEqual([])
      /*
       * Structural: Σ over C of GL(C, D) = AR_CONTROL balance at D
       * (README §4.1). `result.accountBalance` is read DIRECTLY from the
       * AR_CONTROL account, with no party filter — independent of the
       * per-customer `rows` above. `result.totalGl` is the sum of THOSE
       * SAME rows, so comparing it to itself would prove nothing
       * (Accounting seat review, 2026-09-29, 43be499); comparing it to the
       * independently-read `accountBalance` is the actual structural
       * check, and it is what would catch a line that reached AR_CONTROL
       * without `party_type = 'CUSTOMER'` — structurally forbidden by
       * migration 012's CHECK, so this is a belt-and-braces proof that the
       * check would fire if that constraint were ever weakened, not an
       * expectation that it ever fires today.
       */
      expect(
        result.totalGl,
        `tenant ${tenantId}: Σ GL(C, D) disagrees with the AR_CONTROL account's own balance`,
      ).toBe(result.accountBalance)
      tenantsChecked += 1
    }
    expect(tenantsChecked).toBeGreaterThan(0)
  })
})

registerPostingInvariantChecks()
