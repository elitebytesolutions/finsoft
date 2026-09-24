import { Money } from '@finsoft/validation'
import { describe, expect, it } from 'vitest'

import {
  describeBreaks,
  reconcileSubledgerToGeneralLedger,
  type GeneralLedgerBalance,
  type SubledgerRow,
} from './reconciler.ts'

/*
 * Subledger to general ledger. The four acceptance criteria in this
 * directory's README, applied to the reconciler rather than to live data.
 *
 * There IS no live data — both kernels are `export {}`. What is being proved
 * here is the thing a reconciliation suite has to get right before it is
 * pointed at anything: that it detects a break, that it names where, and
 * that it does not agree by accident. `dormant.spec.ts` fails the moment a
 * posting becomes possible, so this cannot stay unwired.
 */

/*
 * Amounts are asserted in their FIXED-SCALE form — '-5000.0000', not
 * '-5000'. That is ADR-0011's serialisation contract, not an incidental
 * detail of the library: a money value crosses HTTP, the outbox and every
 * export at its kind's scale, and an assertion written against a trimmed
 * form would pass today and fail the moment someone serialised it properly.
 */
const money = (v: string): Money => Money.from(v)

const sub = (tenantId: string, controlAccount: string, amount: string): SubledgerRow => ({
  tenantId,
  controlAccount,
  amount: money(amount),
})

const gl = (tenantId: string, account: string, balance: string): GeneralLedgerBalance => ({
  tenantId,
  account,
  balance: money(balance),
})

describe('criterion 1 — exact equality, with no tolerance', () => {
  it('reconciles when the subledger sums to the control account', () => {
    const breaks = reconcileSubledgerToGeneralLedger(
      [
        sub('T1', 'RECEIVABLES', '1200.5000'),
        sub('T1', 'RECEIVABLES', '399.5000'),
        sub('T1', 'PAYABLES', '-800.0000'),
      ],
      [gl('T1', 'RECEIVABLES', '1600.0000'), gl('T1', 'PAYABLES', '-800.0000')],
    )

    expect(breaks).toEqual([])
  })

  it('REPORTS a break of one ten-thousandth, because there is no tolerance', () => {
    /*
     * NON_NEGOTIABLES §4. The smallest representable difference at the
     * storage scale is a break.
     *
     * This is the assertion a future maintainer will be tempted to relax,
     * usually while chasing a rounding difference that turns out to be a
     * genuine missing line. A tolerance wide enough to absorb 0.0001 is wide
     * enough to hide a journal line for the same amount, and once it exists
     * nothing distinguishes the two.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '1600.0000')],
      [gl('T1', 'RECEIVABLES', '1600.0001')],
    )

    expect(breaks).toHaveLength(1)
    expect(breaks[0]?.difference.toString()).toBe('0.0001')
  })

  it('does not drift over many rows, because it sums decimals not floats', () => {
    /*
     * 0.1 + 0.2 !== 0.3 in binary floating point, and a reconciler that
     * summed with JS numbers would produce breaks that appear and disappear
     * with row order — the most expensive kind of false positive, because
     * the investigation finds nothing.
     */
    const rows = Array.from({ length: 300 }, () => sub('T1', 'RECEIVABLES', '0.1000'))
    const breaks = reconcileSubledgerToGeneralLedger(rows, [gl('T1', 'RECEIVABLES', '30.0000')])

    expect(breaks).toEqual([])
  })
})

describe('criterion 2 — holds after reversals, not just a clean sequence', () => {
  it('reconciles a mixed run of postings and their reversals', () => {
    /*
     * ADR-0006: a mistake is corrected by reversal plus re-entry, never by
     * UPDATE. So the steady state of a real ledger is postings AND their
     * negations, and a reconciliation that only holds for a clean sequence
     * holds for a ledger nobody has ever corrected.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [
        sub('T1', 'RECEIVABLES', '5000.0000'), // invoice
        sub('T1', 'RECEIVABLES', '-5000.0000'), // reversed in full
        sub('T1', 'RECEIVABLES', '4750.0000'), // re-entered, corrected
        sub('T1', 'RECEIVABLES', '-1250.0000'), // part paid
      ],
      [gl('T1', 'RECEIVABLES', '3500.0000')],
    )

    expect(breaks).toEqual([])
  })

  it('catches a reversal that reached the GL but not the subledger', () => {
    /*
     * The realistic half-applied correction: the journal was reversed and the
     * subsidiary record was not, so the two records disagree by exactly the
     * reversed amount and both look internally consistent.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '5000.0000')],
      [gl('T1', 'RECEIVABLES', '0.0000')],
    )

    expect(breaks).toHaveLength(1)
    expect(breaks[0]?.difference.toString()).toBe('-5000.0000')
  })
})

describe('criterion 3 — per tenant, and not by accident', () => {
  it('reconciles each tenant independently', () => {
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '100.0000'), sub('T2', 'RECEIVABLES', '250.0000')],
      [gl('T1', 'RECEIVABLES', '100.0000'), gl('T2', 'RECEIVABLES', '250.0000')],
    )

    expect(breaks).toEqual([])
  })

  it('REFUSES to net one tenant against another', () => {
    /*
     * THE TEST THAT MAKES CRITERION 3 MEAN SOMETHING.
     *
     * T1 is 100 over and T2 is 100 under. A reconciler that grouped by
     * account and forgot the tenant would sum to zero and report a clean
     * run — while two tenants' books are both wrong. It is the exact shape
     * of bug a single-tenant test can never find, which is why the README
     * asks for proof that it does not hold by accident.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '1100.0000'), sub('T2', 'RECEIVABLES', '900.0000')],
      [gl('T1', 'RECEIVABLES', '1000.0000'), gl('T2', 'RECEIVABLES', '1000.0000')],
    )

    expect(breaks, 'the two must not cancel').toHaveLength(2)
    expect(breaks.map((b) => b.tenantId)).toEqual(['T1', 'T2'])
    expect(breaks[0]?.difference.toString()).toBe('-100.0000')
    expect(breaks[1]?.difference.toString()).toBe('100.0000')
  })

  it('does not net one ACCOUNT against another within a tenant either', () => {
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '500.0000'), sub('T1', 'PAYABLES', '-500.0000')],
      [gl('T1', 'RECEIVABLES', '400.0000'), gl('T1', 'PAYABLES', '-400.0000')],
    )

    expect(breaks).toHaveLength(2)
    expect(breaks.map((b) => b.scope)).toEqual(['PAYABLES', 'RECEIVABLES'])
  })
})

describe('criterion 4 — detects a deliberate break and names it', () => {
  it('names the account and the tenant for a journal line with no subledger row', () => {
    /*
     * The break the README specifies verbatim: a journal line written
     * without its subledger row. The GL has an account the subsidiary
     * records know nothing about.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '1000.0000')],
      [gl('T1', 'RECEIVABLES', '1000.0000'), gl('T1', 'INVENTORY', '250.0000')],
    )

    expect(breaks).toHaveLength(1)
    expect(breaks[0]?.tenantId).toBe('T1')
    expect(breaks[0]?.scope).toBe('INVENTORY')
    expect(breaks[0]?.actual.toString()).toBe('250.0000')
    expect(breaks[0]?.expected.toString()).toBe('0.0000')
  })

  it('names it the other way round too — a subledger row that never reached the GL', () => {
    /*
     * Iterating one side and looking up the other misses exactly half of
     * these, and it is the half that loses money: a receivable the customer
     * owes that the ledger has never heard of.
     */
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('T1', 'RECEIVABLES', '1000.0000'), sub('T1', 'PAYABLES', '-300.0000')],
      [gl('T1', 'RECEIVABLES', '1000.0000')],
    )

    expect(breaks).toHaveLength(1)
    expect(breaks[0]?.scope).toBe('PAYABLES')
    expect(breaks[0]?.difference.toString()).toBe('300.0000')
  })

  it('renders a break so a human can act on it without opening the code', () => {
    const breaks = reconcileSubledgerToGeneralLedger(
      [sub('TENANT-A', 'RECEIVABLES', '1000.0000')],
      [gl('TENANT-A', 'RECEIVABLES', '1250.0000')],
    )

    const text = describeBreaks(breaks)
    expect(text).toContain('TENANT-A')
    expect(text).toContain('RECEIVABLES')
    expect(text).toContain('1250')
    expect(text).toContain('1000')
    expect(text).toContain('250')
  })

  it('refuses two GL balances for one account rather than summing them', () => {
    /*
     * Summing would be the accommodating thing to do and would hide whichever
     * duplicate is wrong. A control that repairs its input is not a control.
     */
    expect(() =>
      reconcileSubledgerToGeneralLedger(
        [sub('T1', 'RECEIVABLES', '1000.0000')],
        [gl('T1', 'RECEIVABLES', '600.0000'), gl('T1', 'RECEIVABLES', '400.0000')],
      ),
    ).toThrow(/two general ledger balances/)
  })
})

describe('the reconciler discriminates — it is not a function that returns []', () => {
  /*
   * Every "reconciles cleanly" case above passes against a reconciler that
   * always returns an empty list. These are the cases that stop that, and
   * they are here as a group so nobody deletes them as redundant.
   */
  it('reports nothing for identical input and something for perturbed input', () => {
    const subledger = [sub('T1', 'RECEIVABLES', '1000.0000')]

    expect(
      reconcileSubledgerToGeneralLedger(subledger, [gl('T1', 'RECEIVABLES', '1000.0000')]),
    ).toEqual([])

    expect(
      reconcileSubledgerToGeneralLedger(subledger, [gl('T1', 'RECEIVABLES', '1000.0001')]),
    ).toHaveLength(1)
  })

  it('finds an empty ledger against a non-empty subledger', () => {
    expect(
      reconcileSubledgerToGeneralLedger([sub('T1', 'RECEIVABLES', '1.0000')], []),
    ).toHaveLength(1)
  })

  it('and reports nothing when both sides are genuinely empty', () => {
    expect(reconcileSubledgerToGeneralLedger([], [])).toEqual([])
  })
})
