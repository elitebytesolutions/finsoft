import { closeDatabase, withGlobal, withTenant } from '@finsoft/database'
import {
  createTenantFixture,
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
} from '@finsoft/database/testing'
import { Money } from '@finsoft/validation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkInvariant9, invariant9Available } from '../accounting/ar-invariant-9.ts'
import { describeBreaks, reconcileSubledgerToGeneralLedger } from './reconciler.ts'

/*
 * Subledger-to-GL, AR, wired to REAL rows — the half of this directory's
 * README that was still deferred ("Wire reconcileSubledgerToGeneralLedger
 * ... to real rows, per tenant, through withTenant"). Genuinely gated,
 * exactly like `tests/accounting/financial-invariant-suite.spec.ts`'s
 * Invariant 9 block and `dormant.spec.ts`'s own re-armed preconditions:
 * `sales_invoices` / `customer_receipts` do not exist on this branch, and
 * SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED are RULE_NOT_ENABLED, so there is
 * nothing to reconcile yet. See the M3-Q report for why `dormant.spec.ts`
 * itself is UNCHANGED: both its re-armed preconditions are still true on
 * this branch, so its tripwire is correctly still armed, not answered.
 *
 * `reconcileSubledgerToGeneralLedger` (this directory's own comparison,
 * proved against fixtures in subledger-to-gl.spec.ts) is reused UNCHANGED
 * here — the point of this file is wiring real rows to it, never a second
 * copy of the comparison logic. The subledger side is `Σ SUB(C, D)` over
 * every customer (ar-invariant-9.ts, customer-receipt.md §8); the GL side
 * is `Σ GL(C, D)`, the SAME query's own total. This is deliberately the
 * SAME identity §8 states structurally ("Σ over C of GL(C, D) = AR_CONTROL
 * balance at D") reconciled through the GENERIC control-account comparison
 * rather than a bespoke one, so a future AP wiring (Wave 6) is the same
 * shape, not a new design.
 */

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
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
    const tenantIds = (
      await withGlobal((tx) => tx.selectFrom('tenants').select('id').execute())
    ).map((row) => row.id)

    const subledger = []
    const generalLedger = []
    for (const tenantId of tenantIds) {
      const result = await runAs({ tenantId, userId: null }, () =>
        withTenant((tx) => checkInvariant9(tx, tenantId, asOf)),
      )
      const subTotal = result.rows.reduce(
        (sum, row) => Money.add(sum, Money.from(row.sub)),
        Money.zero(),
      )
      subledger.push({ tenantId, controlAccount: 'AR_CONTROL', amount: subTotal })
      generalLedger.push({ tenantId, account: 'AR_CONTROL', balance: Money.from(result.totalGl) })
    }

    const breaks = reconcileSubledgerToGeneralLedger(subledger, generalLedger)
    expect(breaks, describeBreaks(breaks)).toEqual([])
    expect(tenantIds.length).toBeGreaterThan(0)
  }, 120_000)
})
