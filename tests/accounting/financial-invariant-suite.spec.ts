import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, withGlobal, withTenant } from '@finsoft/database'
import {
  ACCOUNTING_TEST_TARGET,
  REPO_ROOT,
  buildTenantCode,
  createTenantFixture,
  migrateAccountingTestDatabase,
  migrateTestDatabase,
  prepareAccountingTestDatabase,
  runAs,
} from '@finsoft/database/testing'
import { createFiscalYear, seedChartOfAccounts } from '@finsoft/database/provisioning'
import { registerParty } from '@finsoft/accounting-kernel'
// Clock injection is test-only: deliberately not on the package's public surface.
import { fixedClock } from '../../packages/accounting-kernel/src/clock.ts'
import { createPostingEngine } from '../../packages/accounting-kernel/src/posting-engine.ts'
import { createReversalEngine } from '../../packages/accounting-kernel/src/reversal.ts'
import { constraints, columns } from '../../database/tests/catalog.ts'
import { GLOBAL_TABLES } from '@finsoft/database'
import { INVARIANTS, enforcedIds, pendingIds } from './invariants.ts'
import { registerPostingInvariantChecks } from './posting-invariants.ts'
import {
  assertInvariant9SweepIsIsolated,
  checkInvariant9,
  invariant9Available,
  isTestOnlyKernelPostingTenant,
} from './ar-invariant-9.ts'

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
  await prepareAccountingTestDatabase()
  await migrateAccountingTestDatabase()
  await closeDatabase()
  process.env['DATABASE_POOL_MAX'] = '4'
  await openDatabase(ACCOUNTING_TEST_TARGET)
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
   * now runs the check FOR REAL, against EVERY tenant — `invariants.ts`
   * id 9 (AR half) moves to 'enforced' and `pending-baseline.json` drops
   * it in the SAME commit as this change, per the ratchet's own rule:
   * shrinking it requires a genuine live run, which this is.
   *
   * Accounting seat ruling, 2026-10-01 (REJECTING this lane's first
   * attempt): skipping a tenant with no subledger activity was wrong — it
   * hides the exact break Invariant 9 exists to catch (AR in the GL with
   * no document behind it). A tenant with no documents must show ZERO AR
   * in the GL; anything else is a break, and the sweep below checks every
   * tenant, no exceptions except the one EXPLICIT, NAMED allowlist
   * `ar-invariant-9.ts`'s `isTestOnlyKernelPostingTenant` documents (see that
   * file's own comment for why: `tests/accounting/kernel-rules.spec.ts`,
   * a file this lane does not own, posts a synthetic AR_CONTROL line with
   * no document behind it BY DESIGN, to prove the kernel's own schema —
   * that is the ONE tenant kind this invariant is not about).
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
     * M3-P HAS LANDED. From here the check is real: EVERY tenant (except
     * the named kernel-rules.spec.ts allowlist), GL(C, D) must equal
     * SUB(C, D) exactly, and Σ GL(C, D) must equal the AR_CONTROL
     * account's balance at D (structural, README §4.1) — computed by
     * `arControlAccountBalance` independently of whether an AR_CONTROL
     * ROLE resolves (ar-invariant-9.ts's own fallback).
     */
    const asOf = new Date().toISOString().slice(0, 10)
    const tenants = await withGlobal((tx) =>
      tx.selectFrom('tenants').select(['id', 'code']).execute(),
    )

    // QA-001 tripwire: proves, not assumes, that this sweep is isolated
    // from database/tests' own database before trusting anything below.
    await withGlobal((tx) =>
      assertInvariant9SweepIsIsolated(
        tx,
        tenants.map((t) => t.code),
      ),
    )

    let tenantsChecked = 0
    for (const { id: tenantId, code } of tenants) {
      if (isTestOnlyKernelPostingTenant(code)) continue

      const result = await runAs({ tenantId, userId: null }, () =>
        withTenant((tx) => checkInvariant9(tx, tenantId, asOf)),
      )
      // Per-customer: GL(C, D) = SUB(C, D) exactly, for every customer —
      // including a tenant with NO documents, which must show gl = sub = 0.
      expect(result.breaks, `tenant ${tenantId} (${code}): Invariant 9 AR-half breaks`).toEqual([])
      /*
       * Structural: Σ over C of GL(C, D) = AR_CONTROL balance at D
       * (README §4.1). `result.accountBalance` is read DIRECTLY — by role
       * when one resolves, by `account_control = 'AR'` across every such
       * account when none does (ar-invariant-9.ts) — independent of the
       * per-customer `rows` above. `result.totalGl` is the sum of THOSE
       * SAME rows, so comparing it to itself would prove nothing
       * (Accounting seat review, 2026-09-29, 43be499); comparing it to the
       * independently-read `accountBalance` is the actual structural
       * check, and it is what would catch a line that reached an
       * AR-control account without `party_type = 'CUSTOMER'` —
       * structurally forbidden by migration 012's CHECK, so this is a
       * belt-and-braces proof that the check would fire if that
       * constraint were ever weakened, not an expectation that it ever
       * fires today.
       */
      expect(
        result.totalGl,
        `tenant ${tenantId} (${code}): Σ GL(C, D) disagrees with the AR_CONTROL account's own balance`,
      ).toBe(result.accountBalance)
      tenantsChecked += 1
    }
    expect(tenantsChecked).toBeGreaterThan(0)
  })

  /*
   * THE NEGATIVE CASE Invariant 9 exists to catch, proved live — Accounting
   * seat ruling, 2026-10-01, item 4: "a tenant with an AR GL line and no
   * documents must make the invariant FAIL." Posts a SALE_POSTED entry
   * through the kernel directly (`createPostingEngine`, exactly as
   * `golden-posting-runner.ts`'s `level: "kernel"` steps and
   * kernel-rules.spec.ts's own "a kernel-built AR line satisfies migration
   * 012 end to end" test do — never through `modules/receivables`, so no
   * `sales_invoices` row is ever created for this tenant), on a tenant
   * fixture labelled 'INV9NEG' — NOT 'KR'/'KR2'/'M3RUNNER', so
   * `isTestOnlyKernelPostingTenant` does NOT exempt it. `checkInvariant9`
   * must report exactly this customer as a break: GL has the posting, SUB
   * has nothing.
   *
   * REVERSED at the end, on purpose: this harness never truncates between
   * test runs (packages/database/src/testing/harness.ts's own header —
   * "rows accumulate until someone destroys the volume"), and this test's
   * whole point is to commit a REAL, permanent row that genuinely breaks
   * Invariant 9 for this tenant. Left unreversed, that break would still
   * be there — correctly — the next time ANY "every tenant" sweep in this
   * file or subledger-to-gl-ar.spec.ts runs against the same database,
   * failing a test that has nothing to do with this one. The reversal
   * neutralises the GL side (Invariant 6) by the time any OTHER test's
   * `asOf` (always today's real date) reads it, so this test proves the
   * break exists AT THE MOMENT it is created without leaving a live
   * tripwire for every future run. The assertion above happens BEFORE the
   * reversal, against the posting's own date — it observes the real break,
   * not a reconstruction of one.
   */
  it('a tenant with an AR GL line and no sales_invoices/customer_receipts row FAILS the invariant', async () => {
    const tenant = await createTenantFixture('INV9NEG')
    expect(
      isTestOnlyKernelPostingTenant(tenant.code),
      'this fixture must NOT be on the test-only allowlist, or the negative case proves nothing',
    ).toBe(false)

    const customerId = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        await seedChartOfAccounts(tx, tenant.tenantId)
        await createFiscalYear(tx, tenant.tenantId, 2027)
        return registerParty(tx, 'CUSTOMER')
      }),
    )

    const clock = fixedClock('2026-09-15T12:00:00.000Z')
    const engine = createPostingEngine(clock)
    const referenceId = randomUUID()
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        engine.post(
          {
            event: 'SALE_POSTED',
            referenceType: 'sales_invoice',
            referenceId,
            occurredAt: '2026-09-15',
            idempotencyKey: 'inv9-negative-case',
            payload: {
              settlement: 'CREDIT',
              customerId,
              lines: [
                {
                  kind: 'SERVICE',
                  description: 'No document behind this line',
                  quantity: '1.000000',
                  unitPrice: '500.000000',
                  lineNet: '500.0000',
                },
              ],
              netAmount: '500.0000',
            },
          },
          tx,
        ),
      ),
    )

    const result = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      withTenant((tx) => checkInvariant9(tx, tenant.tenantId, '2026-09-15')),
    )
    expect(result.breaks, 'the AR GL line with no document must be reported as a break').toEqual([
      { customerId, gl: '500.0000', sub: '0.0000', difference: '-500.0000' },
    ])
    // The structural check still holds: the account genuinely has 500.0000,
    // whichever way it is read. The BREAK is per-customer, not structural.
    expect(result.totalGl).toBe(result.accountBalance)
    expect(result.accountBalance).toBe('500.0000')

    // Clean up for every OTHER "sweep every tenant" test — see the header
    // comment above. reverseForSource is the sanctioned via-source path
    // (reversal.md §4), exactly as a real caller reversing this document
    // would use it.
    const reversal = createReversalEngine(clock)
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) =>
        reversal.reverseForSource(
          {
            referenceType: 'sales_invoice',
            referenceId,
            reason: 'Negative-case cleanup: neutralise before any other sweep runs',
            idempotencyKey: 'inv9-negative-case-cleanup',
            actor: { userId: tenant.ownerId },
          },
          tx,
        ),
      ),
    )
    const asOfToday = new Date().toISOString().slice(0, 10)
    const afterReversal = await runAs({ tenantId: tenant.tenantId, userId: null }, () =>
      withTenant((tx) => checkInvariant9(tx, tenant.tenantId, asOfToday)),
    )
    expect(
      afterReversal.breaks,
      'reversed: this tenant must be clean for every later sweep in this run',
    ).toEqual([])
    expect(afterReversal.accountBalance).toBe('0.0000')
  })

  /*
   * Accounting seat follow-up, 2026-10-01 (approving 15644fe): proves the
   * CONTENT half of `assertInvariant9SweepIsIsolated`
   * (tests/accounting/ar-invariant-9.ts) — not just the structural
   * `current_database()` check (already proved adversarially during
   * development: pointing TEST_ACCOUNTING_DATABASE_URL at the schema
   * database fails loudly). A tenant code is inserted directly into the
   * SCHEMA suite's OWN database (a raw connection via
   * TEST_MIGRATION_DATABASE_URL, never through this file's own pool, which
   * stays pointed at the accounting database throughout this whole file —
   * see the top-level `beforeAll`) and then handed to the function as
   * something this sweep is "about to check". The two databases really are
   * different here; the code is the only thing that leaked — exactly the
   * case the structural check cannot catch on its own.
   */
  it('assertInvariant9SweepIsIsolated fails when a swept tenant code also exists in the schema database', async () => {
    // Self-sufficient regardless of invocation context: `test:gate` runs
    // test:schema (which migrates this database) first, but
    // `npm run test:financial-invariant-suite` on its own (CI's `invariants`
    // job runs `db:migrate:test` as a prior step; an ad-hoc local run might
    // not) does not guarantee it. migrateTestDatabase is independent of the
    // pool singleton this file's own beforeAll opened against the
    // accounting database (see the header comment there) — it only runs
    // migrations through its own raw connection.
    await migrateTestDatabase()

    const leakedCode = buildTenantCode('LEAK')
    const schemaMigrationUrl = process.env['TEST_MIGRATION_DATABASE_URL']
    if (!schemaMigrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')

    const client = new Client({ connectionString: schemaMigrationUrl })
    await client.connect()
    try {
      await client.query('INSERT INTO tenants (code, name) VALUES ($1, $2)', [
        leakedCode,
        `Isolation-tripwire probe ${leakedCode}`,
      ])
    } finally {
      await client.end()
    }

    await expect(
      withGlobal((tx) => assertInvariant9SweepIsIsolated(tx, [leakedCode])),
    ).rejects.toThrow(/ALSO exist in the schema suite's own database/)
  })
})

registerPostingInvariantChecks()
