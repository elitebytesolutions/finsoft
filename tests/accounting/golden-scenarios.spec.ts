import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Money, Quantity, UnitCost } from '@finsoft/validation'
import { REPO_ROOT } from '@finsoft/database/testing'

/*
 * Golden scenarios. NON_NEGOTIABLES §3, governed by ADR-0015.
 *
 *   "50–100 reference cases with hand-computed expected results, maintained
 *    in tests/accounting/golden/. Implementations may change; the expected
 *    numbers may not."
 *
 * The expected values live in JSON on purpose. A number written inline next
 * to the code that produces it is not an independent check — it drifts with
 * the implementation, because whoever changes the implementation is looking
 * straight at it.
 *
 * These exercise the costing ARITHMETIC. The journal-entry half — that a sale
 * posts a balanced entry hitting revenue, COGS, inventory and the receivable
 * — needs the posting engine and belongs to Wave 2. When the inventory kernel
 * lands in Wave 5, these must be re-pointed at inventoryKernel.postMovement
 * rather than performing the kernel's arithmetic inline.
 */

interface GoldenScenario {
  id: string
  name: string
  movements: Array<{
    sequence: number
    type: string
    quantity: string
    unitCost?: string
    unitPrice?: string
  }>
  expected: Record<string, string>
  expectedAtStorageScale: Record<string, string>
  forbiddenRecomputation: { quantityTimesAverage: string; differenceFromCarriedValue: string }
  sellOut: {
    quantitySold: string
    cogs: string
    valueOnHandBefore: string
    inventoryValueDelta: string
    roundingAmount: string
    valueOnHandAfter: string
    quantityOnHandAfter: string
    inventoryGlAfter: string
    journal: { debits: string; credits: string }
  }
  timesTen: {
    quantities: { opening: string; purchase: string; sold: string }
    weightedAverageCost: string
    cogs: string
    valueOnHand: string
    inventoryGlBalance: string
    invariant10Residual: string
    forbiddenQuantityTimesAverage: string
    forbiddenDifference: string
  }
  splitTransactions: {
    oneSaleOf40: { cogs: string; valueOnHandAfter: string }
    tenSalesOf4: { cogsEach: string; cogsTotal: string; valueOnHandAfter: string }
    difference: string
  }
}

const scenarioA = JSON.parse(
  readFileSync(join(REPO_ROOT, 'tests', 'accounting', 'golden', 'scenario-a.json'), 'utf8'),
) as GoldenScenario

const { movements, expected, expectedAtStorageScale, forbiddenRecomputation } = scenarioA

function movement(type: string) {
  const m = movements.find((x) => x.type === type)
  if (!m) throw new Error(`scenario A is missing its ${type} movement`)
  return m
}

/**
 * Value a receipt. ADR-0015 §4: `receipt_value` is the landed total actually
 * debited to inventory, and it is what the carried value accumulates.
 */
const receiptValue = (quantity: string, unitCost: string) =>
  Money.multiply(Quantity.from(quantity), UnitCost.from(unitCost))

describe(`Golden Scenario ${scenarioA.id}: ${scenarioA.name}`, () => {
  const opening = movement('OPENING')
  const purchase = movement('PURCHASE')
  const sale = movement('SALE')

  // --- the carried value, accumulated from stored amounts ------------------
  const valueOnHand = Money.add(
    receiptValue(opening.quantity, opening.unitCost!),
    receiptValue(purchase.quantity, purchase.unitCost!),
  )
  const quantityOnHand = Quantity.add(
    Quantity.from(opening.quantity),
    Quantity.from(purchase.quantity),
  )

  // ADR-0015 §4: numerator is the carried value, not qty × previous average.
  const average = UnitCost.weightedAverage(valueOnHand, quantityOnHand)

  const sold = Quantity.from(sale.quantity)
  // Boundary 2: round once, when the movement row is written.
  const cogs = Money.round(Money.multiply(sold, average))
  const revenue = Money.multiply(sold, UnitCost.from(sale.unitPrice!))
  const grossProfit = Money.subtract(revenue, cogs)

  const quantityAfter = Quantity.subtract(quantityOnHand, sold)
  // The subledger subtracts the SAME stored number the GL is debited.
  const valueAfter = Money.subtract(valueOnHand, cogs)
  const glAfter = Money.subtract(valueOnHand, cogs)

  it('accumulates value and quantity before the sale', () => {
    expect(Money.serialize(valueOnHand, 2)).toBe(expected.totalValueBeforeSale)
    expect(Quantity.serialize(quantityOnHand, 0)).toBe(expected.totalQuantityBeforeSale)
  })

  it('computes the weighted average to six decimal places', () => {
    expect(UnitCost.serialize(average)).toBe(expected.weightedAverageCost)
  })

  it('reproduces every presented figure to the paisa', () => {
    expect(Quantity.serialize(quantityAfter, 0)).toBe(expected.closingQuantity)
    expect(Money.serialize(revenue, 2)).toBe(expected.revenue)
    expect(Money.serialize(cogs, 2)).toBe(expected.cogs)
    expect(Money.serialize(grossProfit, 2)).toBe(expected.grossProfit)
    expect(Money.serialize(valueAfter, 2)).toBe(expected.inventoryValue)
  })

  it('reproduces the stored figures at numeric(19,4) and numeric(19,6)', () => {
    expect(UnitCost.serialize(average, 6)).toBe(expectedAtStorageScale.weightedAverageCost)
    expect(Money.serialize(cogs, 4)).toBe(expectedAtStorageScale.cogs)
    expect(Money.serialize(revenue, 4)).toBe(expectedAtStorageScale.revenue)
    expect(Money.serialize(grossProfit, 4)).toBe(expectedAtStorageScale.grossProfit)
    expect(Money.serialize(valueAfter, 4)).toBe(expectedAtStorageScale.valueOnHand)
  })

  it('satisfies Invariant 10 exactly, with no tolerance', () => {
    // The subledger valuation and the GL balance are equal BY CONSTRUCTION:
    // both are 13000.0000 − 3466.6667. That identity is what ADR-0015 makes
    // structural, and it is why no tolerance is needed or permitted.
    expect(Money.serialize(glAfter, 4)).toBe(expectedAtStorageScale.inventoryGlBalance)
    expect(Money.serialize(Money.subtract(valueAfter, glAfter), 4)).toBe(
      expectedAtStorageScale.invariant10Residual,
    )
  })

  it('pins quantity × average as the FORBIDDEN figure, not the valuation', () => {
    // Rule 16 / ADR-0015 §7. Asserted so the recomputation cannot creep back
    // in as an expectation: a test that makes this number the valuation is
    // the defect this pins.
    const recomputed = Money.round(Money.multiply(quantityAfter, average))
    expect(Money.serialize(recomputed, 4)).toBe(forbiddenRecomputation.quantityTimesAverage)
    expect(Money.serialize(Money.subtract(recomputed, valueAfter), 4)).toBe(
      forbiddenRecomputation.differenceFromCarriedValue,
    )
    expect(Money.equals(recomputed, valueAfter)).toBe(false)
  })

  describe('A2: selling out (ADR-0015 §5)', () => {
    const { sellOut } = scenarioA
    const finalCogs = Money.round(Money.multiply(quantityAfter, average))
    // At zero quantity the inventory leg flushes the carried value.
    const inventoryDelta = Money.negate(valueAfter)
    const rounding = Money.subtract(finalCogs, valueAfter)

    it('takes quantity and value to zero together', () => {
      expect(Money.serialize(finalCogs, 4)).toBe(sellOut.cogs)
      expect(Money.serialize(valueAfter, 4)).toBe(sellOut.valueOnHandBefore)
      expect(Money.serialize(inventoryDelta, 4)).toBe(sellOut.inventoryValueDelta)

      const valueEnd = Money.add(valueAfter, inventoryDelta)
      const quantityEnd = Quantity.subtract(quantityAfter, quantityAfter)

      expect(Money.serialize(valueEnd, 4)).toBe(sellOut.valueOnHandAfter)
      expect(Quantity.serialize(quantityEnd, 0)).toBe(sellOut.quantityOnHandAfter)
      expect(Money.isZero(valueEnd)).toBe(true)
      expect(Quantity.isZero(quantityEnd)).toBe(true)
    })

    it('leaves the inventory GL at exactly zero, never negative', () => {
      // Under the superseded rule this ended at −0.0001 with zero stock
      // behind it: an asset account with a credit balance.
      const glEnd = Money.add(glAfter, inventoryDelta)
      expect(Money.serialize(glEnd, 4)).toBe(sellOut.inventoryGlAfter)
      expect(Money.isNegative(glEnd)).toBe(false)
    })

    it('posts the residual to the rounding account and still balances exactly', () => {
      expect(Money.serialize(rounding, 4)).toBe(sellOut.roundingAmount)

      const debits = finalCogs
      const credits = Money.add(valueAfter, rounding)
      expect(Money.serialize(debits, 4)).toBe(sellOut.journal.debits)
      expect(Money.serialize(credits, 4)).toBe(sellOut.journal.credits)
      // Invariant 1, at posting scale, with no tolerance.
      expect(Money.equals(debits, credits)).toBe(true)
    })
  })

  describe('A3: ten times the quantity (ADR-0015, why a tolerance cannot be sized)', () => {
    const { timesTen } = scenarioA
    const v = Money.add(
      receiptValue(timesTen.quantities.opening, opening.unitCost!),
      receiptValue(timesTen.quantities.purchase, purchase.unitCost!),
    )
    const q = Quantity.add(
      Quantity.from(timesTen.quantities.opening),
      Quantity.from(timesTen.quantities.purchase),
    )
    const avg = UnitCost.weightedAverage(v, q)
    const soldTen = Quantity.from(timesTen.quantities.sold)
    const cogsTen = Money.round(Money.multiply(soldTen, avg))
    const valueTen = Money.subtract(v, cogsTen)

    it('still reconciles exactly at ten times the quantity', () => {
      expect(UnitCost.serialize(avg)).toBe(timesTen.weightedAverageCost)
      expect(Money.serialize(cogsTen, 4)).toBe(timesTen.cogs)
      expect(Money.serialize(valueTen, 4)).toBe(timesTen.valueOnHand)
      expect(Money.serialize(valueTen, 4)).toBe(timesTen.inventoryGlBalance)
    })

    it('shows the forbidden recomputation growing with quantity', () => {
      // 0.0001 at ×1 and 0.0005 at ×10: the average's error is per-unit and
      // the recomputation multiplies it by the whole quantity on hand. A
      // tolerance wide enough to cover this at scale would hide an inventory
      // movement that never reached the GL.
      const recomputed = Money.round(Money.multiply(Quantity.subtract(q, soldTen), avg))
      expect(Money.serialize(recomputed, 4)).toBe(timesTen.forbiddenQuantityTimesAverage)
      expect(Money.serialize(Money.subtract(recomputed, valueTen), 4)).toBe(
        timesTen.forbiddenDifference,
      )
    })
  })

  describe('A4: ten transactions are not one transaction ten times larger', () => {
    const { splitTransactions } = scenarioA

    it('accumulates a different total, which is expected (ADR-0015 §9)', () => {
      const each = Money.round(Money.multiply(Quantity.from('4'), average))
      let total = Money.from('0')
      let running = valueOnHand
      for (let i = 0; i < 10; i++) {
        total = Money.add(total, each)
        running = Money.subtract(running, each)
      }

      expect(Money.serialize(each, 4)).toBe(splitTransactions.tenSalesOf4.cogsEach)
      expect(Money.serialize(total, 4)).toBe(splitTransactions.tenSalesOf4.cogsTotal)
      expect(Money.serialize(running, 4)).toBe(splitTransactions.tenSalesOf4.valueOnHandAfter)
      expect(Money.serialize(Money.subtract(total, cogs), 4)).toBe(splitTransactions.difference)
    })

    it('reconciles to the GL exactly on BOTH paths', () => {
      // The point of A4. Each of the ten roundings is independently correct,
      // so the totals differ — but value_on_hand equals the GL in both cases,
      // because both subtract the same stored deltas. Invariant 10 does not
      // care which path was taken.
      const each = Money.round(Money.multiply(Quantity.from('4'), average))
      let splitValue = valueOnHand
      let splitGl = valueOnHand
      for (let i = 0; i < 10; i++) {
        splitValue = Money.subtract(splitValue, each)
        splitGl = Money.subtract(splitGl, each)
      }

      expect(Money.equals(splitValue, splitGl)).toBe(true)
      expect(Money.equals(valueAfter, glAfter)).toBe(true)
      // And the two paths genuinely differ, so this is not a vacuous pair.
      expect(Money.equals(splitValue, valueAfter)).toBe(false)
    })
  })
})
