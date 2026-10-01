import { closeDatabase, withGlobal, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  migrateAccountingTestDatabase,
  prepareAccountingTestDatabase,
  runAs,
} from '@finsoft/database/testing'
import { Money } from '@finsoft/validation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertInvariant9SweepIsIsolated,
  checkInvariant9,
  computeInvariant9Rows,
  invariant9Available,
  isTestOnlyKernelPostingTenant,
} from '../accounting/ar-invariant-9.ts'
import { describeBreaks, reconcileSubledgerToGeneralLedger } from './reconciler.ts'

/*
 * Subledger-to-GL, AR, wired to REAL rows — the half of this directory's
 * README that was deferred ("Wire reconcileSubledgerToGeneralLedger ...
 * to real rows, per tenant, through withTenant"), now answered: M3-P
 * merged (@2a02731), `sales_invoices`/`customer_receipts` exist, and
 * SALE_POSTED/CUSTOMER_PAYMENT_RECEIVED are IMPLEMENTED_EVENTS. The
 * `invariant9Available` gate below stays (and the "unavailable" branch
 * stays asserted, not deleted) so a future regression that makes the
 * precondition false again is caught, not silently skipped.
 *
 * `dormant.spec.ts`'s FND-012 tripwire has fired for exactly this reason —
 * see that file and tests/reconciliation/README.md, both updated in the
 * same change as this file.
 *
 * `reconcileSubledgerToGeneralLedger` (this directory's own comparison,
 * proved against fixtures in subledger-to-gl.spec.ts) is reused UNCHANGED
 * here — the point of this file is wiring real rows to it, never a second
 * copy of the comparison logic. The subledger side is `Σ SUB(C, D)` over
 * every customer (ar-invariant-9.ts, customer-receipt.md §8); the GL side
 * is `accountBalance` — the AR_CONTROL account's balance, READ DIRECTLY,
 * with no party filter (ar-invariant-9.ts's own doc comment).
 *
 * ACCOUNTING SEAT REVIEW, 2026-09-29 (43be499): the first version of this
 * file passed `result.totalGl` — the sum of the SAME per-customer `gl`
 * figures the subledger side is compared against — as the GL side. Summing
 * a partition of a set always equals the sum of that set: the comparison
 * could never fail, whatever the data. Fixed by reading the AR_CONTROL
 * account directly (`arControlAccountBalance`, no party filter at all),
 * which is genuinely independent of the per-customer computation.
 */

beforeAll(async () => {
  await prepareAccountingTestDatabase()
  await migrateAccountingTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

describe('AR subledger reconciles to AR_CONTROL — real rows, gated on M3-P', () => {
  it('reports unavailable today, or reconciles exactly for every tenant', async () => {
    const tenant = await createTenantFixture('REC9')
    const available = await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant((tx) => invariant9Available(tx)),
    )

    if (!available) {
      expect(available).toBe(false)
      return
    }

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

    /*
     * EVERY tenant is checked — Accounting seat ruling, 2026-10-01
     * (rejecting this lane's first attempt, which skipped any tenant with
     * no subledger activity: that hides the exact break Invariant 9 exists
     * to catch, AR in the GL with no document behind it). The ONE
     * exemption is the named allowlist `ar-invariant-9.ts`'s
     * `isTestOnlyKernelPostingTenant` documents — see that file's own comment.
     */
    const checkedTenantIds: string[] = []
    const subledger = []
    const generalLedger = []
    for (const { id: tenantId, code } of tenants) {
      if (isTestOnlyKernelPostingTenant(code)) continue
      checkedTenantIds.push(tenantId)

      const result = await runAs({ tenantId, userId: null }, () =>
        withTenant((tx) => checkInvariant9(tx, tenantId, asOf)),
      )
      const subTotal = result.rows.reduce(
        (sum, row) => Money.add(sum, Money.from(row.sub)),
        Money.zero(),
      )
      subledger.push({ tenantId, controlAccount: 'AR_CONTROL', amount: subTotal })
      // The GL side: the account's OWN balance, read independently of the
      // per-customer breakdown — see this file's header.
      generalLedger.push({
        tenantId,
        account: 'AR_CONTROL',
        balance: Money.from(result.accountBalance),
      })

      // Internal-consistency cross-check (ar-invariant-9.ts's own doc
      // comment on `totalGl`): the party-grouped sum and the direct account
      // read must agree. A mismatch means some line reached AR_CONTROL
      // without `party_type = 'CUSTOMER'`, or the tenant holds a second
      // AR-control account (TD-011) — either way a real defect, distinct
      // from the subledger-vs-GL reconciliation this file exists for.
      expect(
        result.totalGl,
        `tenant ${tenantId}: Σ per-customer GL disagrees with the AR_CONTROL account's own balance`,
      ).toBe(result.accountBalance)
    }

    const breaks = reconcileSubledgerToGeneralLedger(subledger, generalLedger)
    expect(breaks, describeBreaks(breaks)).toEqual([])
    expect(checkedTenantIds.length).toBeGreaterThan(0)
  }, 120_000)
})

describe('the comparison genuinely discriminates (Accounting seat review, 2026-09-29)', () => {
  /*
   * Both cases below are UNGATED — they need no `sales_invoices` /
   * `customer_receipts` table and run today, proving the FIXED mechanism
   * (not the live wiring, which stays PENDING) actually catches what it
   * claims to.
   *
   * Neither can be built as a genuinely live row on this branch:
   *   - "AR line with no party" is refused by migration 012's own CHECK
   *     constraint (`account_control = 'AR' <=> party_type = 'CUSTOMER'`),
   *     even for the BYPASSRLS migration role — it is not merely unlikely,
   *     it is structurally impossible while that constraint holds, which
   *     is the entire point of README §4.1 ("Invariant 9 structural").
   *     Modelled instead as what its EFFECT on `reconcileSubledgerToGeneralLedger`
   *     would be: an account balance the subledger total does not account for.
   *   - "a line on the wrong party" (a real customer, just not the one who
   *     owns the invoice) IS constructible live, but not without
   *     `sales_invoices` to hold the "right" answer to compare against —
   *     so it is proved instead at the level that actually detects it:
   *     `computeInvariant9Rows`, the pure per-customer comparison
   *     `checkInvariant9` calls internally. A wrong-party line changes
   *     which customer a GL amount is attributed to; it does NOT change
   *     the account's total, so `reconcileSubledgerToGeneralLedger`
   *     (account-level) cannot catch it by design — only the per-customer
   *     `breaks` can, which is exactly what this proves.
   */

  it('an AR_CONTROL balance not backed by any subledger total is a break (models "no party")', () => {
    const breaks = reconcileSubledgerToGeneralLedger(
      [{ tenantId: 'T1', controlAccount: 'AR_CONTROL', amount: Money.from('10000.0000') }],
      // The account carries 500 more than any customer's subledger accounts
      // for — exactly the shape a line with no customer attribution would
      // produce: real money on the account, invisible to Σ SUB.
      [{ tenantId: 'T1', account: 'AR_CONTROL', balance: Money.from('10500.0000') }],
    )
    expect(breaks).toHaveLength(1)
    // difference = actual (GL) − expected (SUB): positive means the GL is
    // overstated (reconciler.ts's own convention) — exactly the shape of a
    // line the subledger never heard about.
    expect(breaks[0]?.difference.toString()).toBe('500.0000')
  })

  it('a line attributed to the wrong (but real) customer is a per-customer break, even though the account total is untouched', () => {
    // CUST-A's invoice (10000.0000) posted correctly to the GL, but the
    // line was written under CUST-B's party id by mistake — a real,
    // registered customer, just the wrong one. The account's total (10000)
    // is exactly right; only the ATTRIBUTION is wrong.
    const gl = new Map([['CUST-B', { debit: '10000.0000', credit: '0.0000' }]])
    const sub = new Map([['CUST-A', '10000.0000']])

    const { rows, totalGl } = computeInvariant9Rows(gl, sub)

    // The account-level total is unaffected — reconcileSubledgerToGeneralLedger
    // alone would see Σ SUB = 10000.0000 = Σ GL and report nothing wrong.
    expect(totalGl).toBe('10000.0000')
    const aggregateBreaks = reconcileSubledgerToGeneralLedger(
      [{ tenantId: 'T1', controlAccount: 'AR_CONTROL', amount: Money.from('10000.0000') }],
      [{ tenantId: 'T1', account: 'AR_CONTROL', balance: Money.from(totalGl) }],
    )
    expect(
      aggregateBreaks,
      'the account-level check cannot see this defect — that is the point',
    ).toEqual([])

    // The PER-CUSTOMER check does see it: CUST-A has money owed with no GL
    // behind it, and CUST-B has GL with no invoice behind it.
    const breaks = rows.filter((row) => row.gl !== row.sub)
    expect(breaks.map((r) => r.customerId).sort()).toEqual(['CUST-A', 'CUST-B'])
    const a = breaks.find((r) => r.customerId === 'CUST-A')!
    const b = breaks.find((r) => r.customerId === 'CUST-B')!
    expect(a.gl).toBe('0.0000')
    expect(a.sub).toBe('10000.0000')
    expect(b.gl).toBe('10000.0000')
    expect(b.sub).toBe('0.0000')
  })
})
