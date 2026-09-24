import { Money, Quantity, UnitCost } from '@finsoft/validation'
import { describe, expect, it } from 'vitest'

import {
  reconcileValuationToStockLedger,
  type StockBalance,
  type StockMovement,
} from './reconciler.ts'

/*
 * Inventory valuation to the stock ledger. ADR-0015's Invariant 10.
 *
 * The four acceptance criteria in this directory's README, applied to the
 * reconciler. There are no stock movements yet — `inventory-kernel` is
 * `export {}` — so what is proved here is the comparison, not the data.
 */

const movement = (
  tenantId: string,
  costingScope: string,
  value: string,
  qty: string,
): StockMovement => ({
  tenantId,
  costingScope,
  inventoryValueDelta: Money.from(value),
  quantityDelta: Quantity.from(qty),
})

const balance = (
  tenantId: string,
  costingScope: string,
  value: string,
  qty: string,
): StockBalance => ({
  tenantId,
  costingScope,
  valueOnHand: Money.from(value),
  quantityOnHand: Quantity.from(qty),
})

describe('criterion 1 — value on hand equals the sum of stored movement amounts', () => {
  it('reconciles a receipt and an issue', () => {
    /*
     * Golden Scenario A's figures, which are hand-computed in
     * tests/accounting/golden/scenario-a.json rather than produced by any
     * implementation:
     *
     *   100 @ 80   =  8000.0000
     *    50 @ 100  =  5000.0000   → 13000.0000 over 150 units
     *   issue 40   = -3466.6667   → carried value 9533.3333 over 110
     */
    const { value, quantity, zeroMismatch } = reconcileValuationToStockLedger(
      [
        movement('T1', 'WIDGET@MAIN', '8000.0000', '100'),
        movement('T1', 'WIDGET@MAIN', '5000.0000', '50'),
        movement('T1', 'WIDGET@MAIN', '-3466.6667', '-40'),
      ],
      [balance('T1', 'WIDGET@MAIN', '9533.3333', '110')],
    )

    expect(value).toEqual([])
    expect(quantity).toEqual([])
    expect(zeroMismatch).toEqual([])
  })

  it('REPORTS the 0.0001 that the forbidden recomputation would have produced', () => {
    /*
     * THE CASE THIS WHOLE CONTROL EXISTS FOR.
     *
     * ADR-0015 §7: the carried value is 13000.0000 - 3466.6667 = 9533.3333.
     * Recomputing it as quantity x average gives 110 x 86.666667 = 9533.3334
     * — one ten-thousandth out, because the average's rounding error is
     * per-unit and the recomputation multiplies it by everything on hand.
     *
     * If a balance row is ever written by that route, THIS is what catches
     * it. A tolerance of a single hundredth would not.
     */
    const { value } = reconcileValuationToStockLedger(
      [
        movement('T1', 'WIDGET@MAIN', '8000.0000', '100'),
        movement('T1', 'WIDGET@MAIN', '5000.0000', '50'),
        movement('T1', 'WIDGET@MAIN', '-3466.6667', '-40'),
      ],
      [balance('T1', 'WIDGET@MAIN', '9533.3334', '110')],
    )

    expect(value).toHaveLength(1)
    expect(value[0]?.difference.toString()).toBe('0.0001')
  })
})

describe('criterion 3 — the forbidden figure is never computed HERE', () => {
  it('the reconciler never needs an average cost to do its job', () => {
    /*
     * ADR-0015 §7 forbids `quantity x average_cost` everywhere, and a
     * reconciliation suite that computed the forbidden figure in order to
     * check the correct one would have written the bug into the control.
     *
     * Demonstrated rather than asserted about the source: the reconciler is
     * given movements whose stored deltas sum to the carried value, and no
     * average is supplied or derivable in a way it uses. The average is
     * computed HERE, in the test, purely to show the two differ — and it is
     * never passed to the reconciler.
     */
    const totalValue = Money.from('13000.0000')
    const totalQty = Quantity.from('150')
    const average = UnitCost.weightedAverage(totalValue, totalQty)
    expect(average.toString()).toBe('86.666667')

    const recomputed = Money.round(Money.multiply(Quantity.from('110'), average), 4)
    const carried = Money.from('9533.3333')

    expect(recomputed.toString(), 'the two genuinely differ').toBe('9533.3334')
    expect(Money.equals(recomputed, carried)).toBe(false)

    // And the reconciler agrees with the CARRIED value, not the recomputation.
    const { value } = reconcileValuationToStockLedger(
      [movement('T1', 'W@M', '13000.0000', '150'), movement('T1', 'W@M', '-3466.6667', '-40')],
      [balance('T1', 'W@M', '9533.3333', '110')],
    )
    expect(value).toEqual([])
  })
})

describe('criterion 2 — quantity and value reach zero together', () => {
  it('reconciles a scope sold out to exactly zero and zero', () => {
    const { value, quantity, zeroMismatch } = reconcileValuationToStockLedger(
      [
        movement('T1', 'W@M', '13000.0000', '150'),
        movement('T1', 'W@M', '-3466.6667', '-40'),
        movement('T1', 'W@M', '-9533.3333', '-110'),
      ],
      [balance('T1', 'W@M', '0.0000', '0')],
    )

    expect(value).toEqual([])
    expect(quantity).toEqual([])
    expect(zeroMismatch, 'both reached zero together').toEqual([])
  })

  it('catches VALUE LEFT BEHIND by stock that is gone', () => {
    /*
     * ADR-0015's residual case. Quantity is zero and value is not: the
     * subledger is carrying money against nothing, and every unit-cost
     * calculation on that scope from here on divides by zero or invents a
     * number.
     *
     * Both ledgers agree with each other here — the movements really do sum
     * to 0.0001 — which is why this is reported separately from a value
     * break. A reconciler comparing only the two sums would call this clean.
     */
    const { value, zeroMismatch } = reconcileValuationToStockLedger(
      [movement('T1', 'W@M', '13000.0000', '150'), movement('T1', 'W@M', '-12999.9999', '-150')],
      [balance('T1', 'W@M', '0.0001', '0')],
    )

    expect(value, 'the two ledgers agree with each other').toEqual([])
    expect(zeroMismatch).toHaveLength(1)
    expect(zeroMismatch[0]?.reason).toMatch(/quantity is zero but value on hand is 0.0001/)
  })

  it('catches STOCK CARRIED AT NOTHING', () => {
    /*
     * The mirror image, and the one that understates the balance sheet:
     * units on hand with no value against them. Every subsequent issue
     * costs at zero and the margin on those sales is fiction.
     */
    const { zeroMismatch } = reconcileValuationToStockLedger(
      [movement('T1', 'W@M', '0.0000', '40')],
      [balance('T1', 'W@M', '0.0000', '40')],
    )

    expect(zeroMismatch).toHaveLength(1)
    expect(zeroMismatch[0]?.reason).toMatch(/value is zero but quantity on hand is 40/)
  })
})

describe('criterion 4 — a break is found, named, and not netted away', () => {
  it('does not net one costing scope against another', () => {
    const { value } = reconcileValuationToStockLedger(
      [movement('T1', 'A@MAIN', '100.0000', '10'), movement('T1', 'B@MAIN', '100.0000', '10')],
      [balance('T1', 'A@MAIN', '150.0000', '10'), balance('T1', 'B@MAIN', '50.0000', '10')],
    )

    expect(value, 'the +50 and -50 must not cancel').toHaveLength(2)
    expect(value.map((b) => b.scope)).toEqual(['A@MAIN', 'B@MAIN'])
  })

  it('does not net one tenant against another', () => {
    const { value } = reconcileValuationToStockLedger(
      [movement('T1', 'W@M', '100.0000', '10'), movement('T2', 'W@M', '100.0000', '10')],
      [balance('T1', 'W@M', '150.0000', '10'), balance('T2', 'W@M', '50.0000', '10')],
    )

    expect(value).toHaveLength(2)
    expect(value.map((b) => b.tenantId)).toEqual(['T1', 'T2'])
  })

  it('catches a movement with no balance row, and a balance row with no movements', () => {
    const orphanMovement = reconcileValuationToStockLedger(
      [movement('T1', 'GHOST@MAIN', '500.0000', '5')],
      [],
    )
    expect(orphanMovement.value).toHaveLength(1)
    expect(orphanMovement.value[0]?.scope).toBe('GHOST@MAIN')

    const orphanBalance = reconcileValuationToStockLedger(
      [],
      [balance('T1', 'PHANTOM@MAIN', '500.0000', '5')],
    )
    expect(orphanBalance.value).toHaveLength(1)
    expect(orphanBalance.value[0]?.scope).toBe('PHANTOM@MAIN')
  })

  it('catches a quantity break even when the value reconciles', () => {
    /*
     * Value and quantity are separate records and fail separately. A
     * reconciler that checked only value would pass a scope whose unit count
     * is wrong, and every future average cost on it would be wrong with it.
     */
    const { value, quantity } = reconcileValuationToStockLedger(
      [movement('T1', 'W@M', '1000.0000', '100')],
      [balance('T1', 'W@M', '1000.0000', '99')],
    )

    expect(value).toEqual([])
    expect(quantity).toHaveLength(1)
    expect(quantity[0]?.difference.toString()).toBe('-1.000000')
  })
})

describe('the valuation reconciler discriminates', () => {
  it('is clean on identical input and not on perturbed input', () => {
    const movements = [movement('T1', 'W@M', '1000.0000', '10')]

    expect(
      reconcileValuationToStockLedger(movements, [balance('T1', 'W@M', '1000.0000', '10')]).value,
    ).toEqual([])

    expect(
      reconcileValuationToStockLedger(movements, [balance('T1', 'W@M', '1000.0001', '10')]).value,
    ).toHaveLength(1)
  })

  it('reports nothing when both sides are genuinely empty', () => {
    const result = reconcileValuationToStockLedger([], [])
    expect(result.value).toEqual([])
    expect(result.quantity).toEqual([])
    expect(result.zeroMismatch).toEqual([])
  })
})
