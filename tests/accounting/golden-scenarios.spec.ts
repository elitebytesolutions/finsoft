import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Money, Quantity, UnitCost } from '@finsoft/validation'
import { REPO_ROOT } from '@finsoft/database/testing'

/*
 * Golden scenarios. NON_NEGOTIABLES §3.
 *
 *   "50–100 reference cases with hand-computed expected results, maintained
 *    in tests/accounting/golden/. Implementations may change; the expected
 *    numbers may not."
 *
 * The expected values live in JSON rather than in this file on purpose. A
 * number written inline next to the code that produces it is not an
 * independent check — it drifts with the implementation, because whoever
 * changes the implementation is looking straight at it. Holding them as data
 * with their provenance recorded makes changing one a deliberate, reviewable
 * act.
 *
 * Scenario A exercises the costing arithmetic only. The journal-entry half —
 * that the sale posts a balanced entry hitting revenue, COGS, inventory and
 * the receivable — needs the posting engine and belongs to Wave 2. It is
 * registered as pending in invariants.ts, not quietly omitted.
 */

/**
 * The shape a golden scenario file must have.
 *
 * Declared explicitly rather than inferred from a JSON import: an import
 * attribute is not permitted under this tsconfig's module setting, and an
 * explicit contract is better anyway — it fails loudly if a scenario file
 * drops a field, where inference would silently narrow to `never`.
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
  openQuestion: { invariant10Residual: string }
}

const scenarioA = JSON.parse(
  readFileSync(join(REPO_ROOT, 'tests', 'accounting', 'golden', 'scenario-a.json'), 'utf8'),
) as GoldenScenario

const { movements, expected, expectedAtStorageScale, openQuestion } = scenarioA

function movement(type: string) {
  const m = movements.find((x) => x.type === type)
  if (!m) throw new Error(`scenario A is missing its ${type} movement`)
  return m
}

describe(`Golden Scenario ${scenarioA.id}: ${scenarioA.name}`, () => {
  const opening = movement('OPENING')
  const purchase = movement('PURCHASE')
  const sale = movement('SALE')

  const openingValue = Money.multiply(
    Quantity.from(opening.quantity),
    UnitCost.from(opening.unitCost!),
  )
  const purchaseValue = Money.multiply(
    Quantity.from(purchase.quantity),
    UnitCost.from(purchase.unitCost!),
  )
  const totalValue = Money.add(openingValue, purchaseValue)
  const totalQuantity = Quantity.add(
    Quantity.from(opening.quantity),
    Quantity.from(purchase.quantity),
  )

  const average = UnitCost.weightedAverage(totalValue, totalQuantity)
  const sold = Quantity.from(sale.quantity)

  const cogs = Money.round(Money.multiply(sold, average))
  const revenue = Money.multiply(sold, UnitCost.from(sale.unitPrice!))
  const grossProfit = Money.subtract(revenue, cogs)
  const closingQuantity = Quantity.subtract(totalQuantity, sold)
  const inventoryValue = Money.round(Money.multiply(closingQuantity, average))

  it('accumulates value and quantity before the sale', () => {
    expect(Money.serialize(totalValue, 2)).toBe(expected.totalValueBeforeSale)
    expect(Quantity.serialize(totalQuantity, 0)).toBe(expected.totalQuantityBeforeSale)
  })

  it('computes the weighted average to six decimal places (ADR-0007)', () => {
    expect(UnitCost.serialize(average)).toBe(expected.weightedAverageCost)
  })

  it('reproduces every presented figure to the paisa', () => {
    expect(Quantity.serialize(closingQuantity, 0)).toBe(expected.closingQuantity)
    expect(Money.serialize(revenue, 2)).toBe(expected.revenue)
    expect(Money.serialize(cogs, 2)).toBe(expected.cogs)
    expect(Money.serialize(grossProfit, 2)).toBe(expected.grossProfit)
    expect(Money.serialize(inventoryValue, 2)).toBe(expected.inventoryValue)
  })

  it('reproduces the stored figures at numeric(19,4) and numeric(19,6)', () => {
    // Presentation rounding can hide a discrepancy of up to half a paisa.
    // These assert what actually lands in the columns.
    expect(UnitCost.serialize(average, 6)).toBe(expectedAtStorageScale.weightedAverageCost)
    expect(Money.serialize(cogs, 4)).toBe(expectedAtStorageScale.cogs)
    expect(Money.serialize(revenue, 4)).toBe(expectedAtStorageScale.revenue)
    expect(Money.serialize(grossProfit, 4)).toBe(expectedAtStorageScale.grossProfit)
    expect(Money.serialize(inventoryValue, 4)).toBe(expectedAtStorageScale.inventoryValue)
  })

  it('pins the Invariant 10 residual while the ADR-0007 ruling is outstanding', () => {
    // Not an endorsement of the gap. It is pinned so that it cannot change
    // size unnoticed, and so the number in the ruling discussion stays the
    // number the code actually produces.
    const glBalance = Money.subtract(totalValue, cogs)
    expect(Money.serialize(glBalance, 4)).toBe(expectedAtStorageScale.inventoryGlBalance)
    expect(Money.serialize(Money.subtract(inventoryValue, glBalance), 4)).toBe(
      openQuestion.invariant10Residual,
    )
  })
})
