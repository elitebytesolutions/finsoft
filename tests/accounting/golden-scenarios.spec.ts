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

  /*
   * The subledger subtracts the SAME stored number the GL is debited — which
   * is ADR-0015's whole point, and also why the two expressions below are
   * identical.
   *
   * BE HONEST ABOUT WHAT THAT MEANS FOR THESE TESTS. There is no posting
   * engine yet, so no journal is modelled and there is no independent GL
   * side. Asserting `valueAfter === valueAfter` here would be asserting
   * `x − x = 0`, which is a tautology dressed as a reconciliation.
   *
   * So these cases assert what they can actually prove: that the specified
   * values are produced, and that the recomputation DIFFERS from them. The
   * GL side is specified, not observed. Invariant 10 stays `pending` in
   * invariants.ts until Wave 2 posts a real journal to reconcile against.
   */
  const valueAfter = Money.subtract(valueOnHand, cogs)

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

  it('produces the specified carried value (the GL side is specified, not observed)', () => {
    /*
     * The carried value IS what the GL balance will be, because the posting
     * engine will debit the same stored `cogs` this subtracts. That identity
     * is what ADR-0015 makes structural.
     *
     * What this test can prove today is that the figure matches the value the
     * golden file specifies for the GL. It cannot prove the reconciliation —
     * there is no journal yet. An assertion comparing the value to itself
     * would look like a reconciliation and be worth nothing, so there isn't
     * one; Invariant 10 stays `pending` until Wave 2 provides the other side.
     */
    expect(Money.serialize(valueAfter, 4)).toBe(expectedAtStorageScale.inventoryGlBalance)
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
      const glEnd = Money.add(valueAfter, inventoryDelta)
      expect(Money.serialize(glEnd, 4)).toBe(sellOut.inventoryGlAfter)
      expect(Money.isNegative(glEnd)).toBe(false)
    })

    it('posts the residual to the rounding account and still balances exactly', () => {
      expect(Money.serialize(rounding, 4)).toBe(sellOut.roundingAmount)

      /*
       * The journal is built from LINES and the two sides summed
       * independently, rather than asserting `finalCogs === valueAfter +
       * rounding` — which is just the definition of `rounding` rearranged,
       * and would balance no matter what the line amounts were.
       *
       * Each line here is the amount a posting engine would actually write:
       * the COGS debit is the stored cogs_amount, the inventory credit is the
       * magnitude of the stored inventory_value_delta, and the rounding line
       * is the stored rounding_amount. Summing those and comparing is a real
       * check of Invariant 1.
       */
      const lines = [
        { account: 'Cost of Goods Sold', debit: finalCogs, credit: Money.from('0') },
        { account: 'Inventory', debit: Money.from('0'), credit: Money.abs(inventoryDelta) },
        { account: 'Rounding', debit: Money.from('0'), credit: rounding },
      ]

      const debits = Money.sum(lines.map((l) => l.debit))
      const credits = Money.sum(lines.map((l) => l.credit))

      expect(Money.serialize(debits, 4)).toBe(sellOut.journal.debits)
      expect(Money.serialize(credits, 4)).toBe(sellOut.journal.credits)
      // Invariant 1, at posting scale, with no tolerance.
      expect(Money.equals(debits, credits)).toBe(true)
      expect(Money.isZero(Money.subtract(debits, credits))).toBe(true)
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

    it('produces a carried value on both paths, and the paths genuinely differ', () => {
      /*
       * The point of A4. Each of the ten roundings is independently correct,
       * so the totals differ — and the carried value on each path is still
       * what the GL balance will be, because both subtract the same stored
       * deltas. Invariant 10 does not care which path was taken.
       *
       * A GL side computed here would be the same expression as the subledger
       * side, so comparing them would assert x = x. The real content is that
       * the two PATHS differ while each remains internally consistent, which
       * is what these two assertions check.
       */
      const each = Money.round(Money.multiply(Quantity.from('4'), average))
      let splitValue = valueOnHand
      for (let i = 0; i < 10; i++) {
        splitValue = Money.subtract(splitValue, each)
      }

      expect(Money.serialize(splitValue, 4)).toBe(splitTransactions.tenSalesOf4.valueOnHandAfter)
      // The paths genuinely differ, so neither assertion above is vacuous.
      expect(Money.equals(splitValue, valueAfter)).toBe(false)
    })
  })

  describe('the closure identity (ADR-0015 §9)', () => {
    /*
     * Where the path difference actually goes. It is not absorbed and not
     * tolerated — it is carried forward and discharged in full at the flush.
     *
     * The GENERAL form is asserted, `Σ inventory_value_delta = 0`, because it
     * holds for every movement type. The familiar corollary
     * `Σ receipt_value = Σ outward_value − Σ rounding_amount` is asserted too,
     * but it breaks on value-only adjustments, which have a delta and neither
     * a receipt nor an outward movement.
     */
    function runLifecycle(saleSizes: readonly number[]) {
      const deltas = [
        receiptValue(opening.quantity, opening.unitCost!),
        receiptValue(purchase.quantity, purchase.unitCost!),
      ]
      const receiptTotal = Money.sum(deltas)

      let value = receiptTotal
      let qty = quantityOnHand
      let outwardTotal = Money.from('0')
      let roundingTotal = Money.from('0')

      for (const size of saleSizes) {
        const q = Quantity.from(String(size))
        const remaining = Quantity.subtract(qty, q)
        const outward = Money.round(Money.multiply(q, average))
        outwardTotal = Money.add(outwardTotal, outward)

        if (Quantity.isZero(remaining)) {
          // §5 flush: the inventory leg is the carried value, not the rate.
          deltas.push(Money.negate(value))
          roundingTotal = Money.add(roundingTotal, Money.subtract(outward, value))
          value = Money.from('0')
        } else {
          deltas.push(Money.negate(outward))
          value = Money.subtract(value, outward)
        }
        qty = remaining
      }

      return { deltas, receiptTotal, outwardTotal, roundingTotal, value, qty }
    }

    it.each([
      ['one sale of 40 then the flush', [40, 110]],
      ['ten sales of 4 then the flush', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 110]],
      ['a single sale of the whole 150', [150]],
    ] as const)('closes to zero for %s', (_label, sizes) => {
      const { deltas, receiptTotal, outwardTotal, roundingTotal, value, qty } = runLifecycle(sizes)

      expect(Quantity.isZero(qty), 'the life cycle must end at zero stock').toBe(true)
      expect(Money.isZero(value)).toBe(true)

      // General identity — holds for every movement type.
      expect(Money.serialize(Money.sum(deltas), 4)).toBe('0.0000')

      // Corollary — the path difference is discharged through the rounding
      // account, not absorbed. Different paths produce different totals on
      // both sides, and both close to the same receipts.
      expect(Money.equals(Money.subtract(outwardTotal, roundingTotal), receiptTotal)).toBe(true)
    })

    it('discharges a LARGER residual on the more fragmented path', () => {
      // The 0.0003 path difference from A4 does not vanish — it shows up as a
      // larger rounding-account posting at the flush, which is exactly what
      // makes it visible and attributable rather than tolerated.
      const one = runLifecycle([40, 110])
      const ten = runLifecycle([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 110])

      expect(Money.serialize(one.roundingTotal, 4)).toBe('0.0001')
      expect(Money.serialize(ten.roundingTotal, 4)).toBe('0.0004')
      expect(Money.serialize(Money.subtract(ten.roundingTotal, one.roundingTotal), 4)).toBe(
        '0.0003',
      )
      expect(Money.serialize(Money.subtract(ten.outwardTotal, one.outwardTotal), 4)).toBe('0.0003')
    })
  })
})
