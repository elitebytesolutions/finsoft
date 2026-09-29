import { Money, Quantity, type Kind } from '@finsoft/validation'
import type { Amount } from '@finsoft/validation'

/*
 * The reconciler.
 *
 * Reconciliation asserts that two independently-maintained records of the
 * same truth agree: the subledger against the general ledger, and the
 * inventory valuation against the stock ledger.
 *
 * ── Why this exists now, when there is nothing to reconcile ─────────────
 *
 * Both kernels are `export {}` and no journal entry, stock movement or
 * balance exists. `tests/reconciliation/README.md` argues — correctly — that
 * a suite asserting zero equals zero would be worse than no suite, because it
 * would appear in the run as reconciliation coverage and stay green through
 * every change that later breaks reconciliation for real.
 *
 * That argument applies to the DATA, not to the COMPARISON. The thing a
 * reconciliation suite actually has to get right is detecting a break and
 * saying precisely where it is, and that logic can be built and proved
 * against fixtures today. Wave 5 wires it to real postings; Wave 6 to real
 * movements. The tripwire in `dormant.spec.ts` fails the moment either
 * becomes possible, so this cannot quietly stay unwired.
 *
 * ── Deliberately independent of production code ─────────────────────────
 *
 * Nothing here imports a kernel, a repository or a posting engine, and it
 * never will. A control that shares an implementation with the thing it
 * checks agrees with it by construction — including when both are wrong.
 * The only dependency is `@finsoft/validation`, because a reconciler that
 * did its own arithmetic in JS numbers would be the first thing to break
 * Invariant 1.
 *
 * ── No tolerance. Ever. ─────────────────────────────────────────────────
 *
 * NON_NEGOTIABLES §4. There is no epsilon parameter in this file and none
 * may be added. A tolerance wide enough to absorb a rounding difference is
 * wide enough to hide a missing journal line, and the two are
 * indistinguishable once it exists.
 */

/** Where a break is, in the terms an accountant would ask about. */
export interface Break<K extends Kind> {
  readonly tenantId: string
  /** The control account, or the costing scope for a valuation break. */
  readonly scope: string
  /** What the subledger (or the movement ledger) says. */
  readonly expected: Amount<K>
  /** What the general ledger (or the balance row) says. */
  readonly actual: Amount<K>
  /** actual − expected. Signed: positive means the GL is overstated. */
  readonly difference: Amount<K>
}

export interface SubledgerRow {
  readonly tenantId: string
  /** The control account this subledger rolls up to. */
  readonly controlAccount: string
  readonly amount: Money
}

export interface GeneralLedgerBalance {
  readonly tenantId: string
  readonly account: string
  readonly balance: Money
}

const key = (tenantId: string, scope: string): string => `${tenantId}\u0000${scope}`

/**
 * Subledger to general ledger.
 *
 * For every control account, the sum of its subledger balances must EQUAL
 * the GL account balance. Exact equality.
 *
 * Returns every break rather than throwing on the first, because "which
 * accounts disagree" is the question being asked — a reconciler that stops
 * at the first break turns one investigation into several.
 *
 * **A scope present on one side and absent on the other is a break, not a
 * skip.** That is the failure this control exists to catch: a journal line
 * written with no subledger row behind it, or a subledger row that never
 * reached the GL. Iterating one side and looking up the other would miss
 * exactly half of those.
 */
export function reconcileSubledgerToGeneralLedger(
  subledger: readonly SubledgerRow[],
  generalLedger: readonly GeneralLedgerBalance[],
): readonly Break<'Money'>[] {
  const expected = new Map<string, Money>()
  for (const row of subledger) {
    const k = key(row.tenantId, row.controlAccount)
    expected.set(k, Money.add(expected.get(k) ?? Money.zero(), row.amount))
  }

  const actual = new Map<string, Money>()
  for (const row of generalLedger) {
    const k = key(row.tenantId, row.account)
    if (actual.has(k)) {
      throw new Error(
        `reconciliation: two general ledger balances for ${row.tenantId}/${row.account}. ` +
          'The GL is meant to carry one balance per account per tenant; summing them here ' +
          'would hide whichever duplicate is wrong.',
      )
    }
    actual.set(k, row.balance)
  }

  const breaks: Break<'Money'>[] = []

  for (const k of new Set([...expected.keys(), ...actual.keys()])) {
    const [tenantId = '', scope = ''] = k.split('\u0000')
    const exp = expected.get(k) ?? Money.zero()
    const act = actual.get(k) ?? Money.zero()

    if (Money.equals(exp, act)) continue

    breaks.push({
      tenantId,
      scope,
      expected: exp,
      actual: act,
      difference: Money.subtract(act, exp),
    })
  }

  return sorted(breaks)
}

export interface StockMovement {
  readonly tenantId: string
  /** The costing scope: tenant/product/location, as ADR-0018 defines it. */
  readonly costingScope: string
  /** Signed. ADR-0015: the stored amount, never recomputed. */
  readonly inventoryValueDelta: Money
  readonly quantityDelta: Quantity
}

export interface StockBalance {
  readonly tenantId: string
  readonly costingScope: string
  readonly valueOnHand: Money
  readonly quantityOnHand: Quantity
}

export interface ValuationBreak {
  readonly value: readonly Break<'Money'>[]
  readonly quantity: readonly Break<'Quantity'>[]
  /**
   * Scopes where exactly one of quantity and value is zero.
   *
   * ADR-0015's Invariant 10, second form: quantity and value reach zero
   * TOGETHER. A scope holding value with no stock, or stock with no value,
   * is a break even when both ledgers agree with each other — which is why
   * it is reported separately rather than folded into the value list.
   */
  readonly zeroMismatch: readonly { tenantId: string; scope: string; reason: string }[]
}

/**
 * Inventory valuation to the stock ledger. ADR-0015 Invariant 10.
 *
 * `stock_balances.value_on_hand` must equal `Σ inventory_value_delta` for its
 * costing scope, and the same for quantity.
 *
 * **The valuation is never recomputed as `quantity × average_cost` here.**
 * ADR-0015 §7 forbids that everywhere, and a reconciliation suite that
 * computes the forbidden figure in order to check the correct one has
 * written the bug into the control. The only arithmetic below is summation
 * of stored amounts.
 */
export function reconcileValuationToStockLedger(
  movements: readonly StockMovement[],
  balances: readonly StockBalance[],
): ValuationBreak {
  const value = new Map<string, Money>()
  const quantity = new Map<string, Quantity>()

  for (const m of movements) {
    const k = key(m.tenantId, m.costingScope)
    value.set(k, Money.add(value.get(k) ?? Money.zero(), m.inventoryValueDelta))
    quantity.set(k, Quantity.add(quantity.get(k) ?? Quantity.zero(), m.quantityDelta))
  }

  const balanceByKey = new Map<string, StockBalance>()
  for (const b of balances) balanceByKey.set(key(b.tenantId, b.costingScope), b)

  const valueBreaks: Break<'Money'>[] = []
  const quantityBreaks: Break<'Quantity'>[] = []
  const zeroMismatch: { tenantId: string; scope: string; reason: string }[] = []

  for (const k of new Set([...value.keys(), ...balanceByKey.keys()])) {
    const [tenantId = '', scope = ''] = k.split('\u0000')
    const b = balanceByKey.get(k)

    const expectedValue = value.get(k) ?? Money.zero()
    const actualValue = b?.valueOnHand ?? Money.zero()
    if (!Money.equals(expectedValue, actualValue)) {
      valueBreaks.push({
        tenantId,
        scope,
        expected: expectedValue,
        actual: actualValue,
        difference: Money.subtract(actualValue, expectedValue),
      })
    }

    const expectedQty = quantity.get(k) ?? Quantity.zero()
    const actualQty = b?.quantityOnHand ?? Quantity.zero()
    if (!Quantity.equals(expectedQty, actualQty)) {
      quantityBreaks.push({
        tenantId,
        scope,
        expected: expectedQty,
        actual: actualQty,
        difference: Quantity.subtract(actualQty, expectedQty),
      })
    }

    /*
     * Checked against the BALANCE ROW, which is what a report reads. A scope
     * whose ledgers agree with each other can still be wrong in this way, and
     * that is precisely the case ADR-0015 singles out.
     */
    const qtyZero = Quantity.isZero(actualQty)
    const valZero = Money.isZero(actualValue)
    if (qtyZero !== valZero) {
      zeroMismatch.push({
        tenantId,
        scope,
        reason: qtyZero
          ? `quantity is zero but value on hand is ${Money.serialize(actualValue, 4)}: value left behind by stock that is gone`
          : `value is zero but quantity on hand is ${Quantity.serialize(actualQty, 6)}: stock carried at nothing`,
      })
    }
  }

  return {
    value: sorted(valueBreaks),
    quantity: sorted(quantityBreaks),
    zeroMismatch: [...zeroMismatch].sort(
      (a, b) => a.tenantId.localeCompare(b.tenantId) || a.scope.localeCompare(b.scope),
    ),
  }
}

/**
 * Deterministic order, so a failure message is diffable between runs.
 *
 * An unordered break list makes two identical failures look different and
 * two different ones look alike, which is how a flaky-looking report gets
 * ignored.
 */
function sorted<K extends Kind>(breaks: readonly Break<K>[]): readonly Break<K>[] {
  return [...breaks].sort(
    (a, b) => a.tenantId.localeCompare(b.tenantId) || a.scope.localeCompare(b.scope),
  )
}

/** A break list rendered for a failure message: one line each, no rounding. */
export function describeBreaks<K extends Kind>(breaks: readonly Break<K>[]): string {
  return breaks
    .map(
      (b) =>
        `  tenant ${b.tenantId} · ${b.scope}: ledger says ${b.actual.toString()}, ` +
        `subsidiary records say ${b.expected.toString()} (difference ${b.difference.toString()})`,
    )
    .join('\n')
}
