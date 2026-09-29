import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'

/*
 * THE TRIPWIRE.
 *
 * The reconcilers in this directory are proved against fixtures, because
 * there is nothing live to reconcile: both kernels are `export {}` and no
 * journal entry, stock movement or balance exists. That is the right state
 * for Wave 0 and the wrong state to leave unattended, because a suite that
 * tests only its own fixtures passes forever — including on the day real
 * data appears and nobody points it at any.
 *
 * So this file asserts the PRECONDITIONS of the deferral. The moment posting
 * or stock movement becomes possible, these tests fail with instructions,
 * and the failure is the reminder that a passing reconciliation suite is no
 * longer evidence of anything.
 *
 * A test that fails when the code improves is normally a bad test. This one
 * is deliberate: it is the only mechanism that converts "deferred to Wave 5"
 * from a note in a README into something that happens.
 */

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')

/** Source with comments and whitespace removed, so a comment cannot look like code. */
function meaningfulSource(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim()
}

/*
 * M2-A: THE ACCOUNTING HALF OF THIS TRIPWIRE FIRED, AS DESIGNED, AND WAS
 * ANSWERED RATHER THAN DELETED (Accounting seat, 2026-09-28).
 *
 * Migration 012 created journal_entries/journal_lines and the accounting
 * kernel gained a posting engine, so both original accounting assertions
 * failed. Their instruction — wire reconcileSubledgerToGeneralLedger to live
 * rows — cannot be carried out yet: it compares a DOCUMENT subledger
 * (invoices, receipts, allocations) with the AR/AP control accounts, and no
 * document subledger exists until M3. Nothing live can break Invariant 9 in
 * the meantime, because no enabled path reaches a control account: a manual
 * voucher to AR/AP is ACCOUNT_CONTROL_MANUAL_FORBIDDEN (golden P03 step 9),
 * and SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED are RULE_NOT_ENABLED.
 *
 * So the tripwire is re-armed on exactly those two preconditions. It fires
 * the moment either stops being true — a rule that can reach AR/AP is
 * enabled, or a subledger table is migrated — which is the moment live
 * reconciliation becomes both possible and necessary. The inventory half is
 * unchanged. The GL half now exists and is covered live by the
 * FinancialInvariantSuite (Invariants 1, 2, 6) for every tenant.
 */
const RECONCILE_LIVE_INSTRUCTIONS =
  'THE RECONCILIATION SUITE IS NOW UNDER-POWERED. It proves its reconcilers\n' +
  'against fixtures only, which is correct only while there is nothing to\n' +
  'reconcile. Before re-arming or deleting this assertion:\n\n' +
  '  1. Wire reconcileSubledgerToGeneralLedger / reconcileValuationToStockLedger\n' +
  '     to real rows, per tenant, through withTenant.\n' +
  '  2. Run them after a mixed sequence of postings AND REVERSALS — a\n' +
  '     reconciliation that only holds when nothing was corrected is not one.\n' +
  '  3. Keep every fixture test in this directory. They are what prove the\n' +
  '     comparison detects a break; live data proves there is not one today.\n' +
  '  4. Update tests/reconciliation/README.md and the Wave 0 register entry\n' +
  '     for FND-012, which both record this as deferred.'

describe('the reconciliation deferral is still valid', () => {
  it('no enabled posting rule can reach an AR/AP control account (M2-A re-arm)', async () => {
    const { IMPLEMENTED_EVENTS } = await import('@finsoft/accounting-kernel')
    expect(
      [...IMPLEMENTED_EVENTS].sort(),
      'A posting rule beyond the manual journal voucher is now enabled, so a\n' +
        'customer or vendor balance can now exist in the GL.\n\n' +
        RECONCILE_LIVE_INSTRUCTIONS,
    ).toEqual(['JOURNAL_VOUCHER_POSTED'])
  })

  it.each([['packages/inventory-kernel/src/index.ts', 'ADR-0008/0018 movement ledger', 'Wave 6']])(
    '%s is still empty',
    (path, what, wave) => {
      expect(
        meaningfulSource(path),
        `${path} has content, so ${what} may now exist.\n\n` +
          'THE RECONCILIATION SUITE IS NOW UNDER-POWERED. It proves its reconcilers\n' +
          'against fixtures only, which was correct while there was nothing to\n' +
          `reconcile and is not correct now. Before deleting this assertion (${wave}):\n\n` +
          '  1. Wire reconcileSubledgerToGeneralLedger / reconcileValuationToStockLedger\n' +
          '     to real rows, per tenant, through withTenant.\n' +
          '  2. Run them after a mixed sequence of postings AND REVERSALS — a\n' +
          '     reconciliation that only holds when nothing was corrected is not one.\n' +
          '  3. Keep every fixture test in this directory. They are what prove the\n' +
          '     comparison detects a break; live data proves there is not one today.\n' +
          '  4. Update tests/reconciliation/README.md and the Wave 0 register entry\n' +
          '     for FND-012, which both record this as deferred.',
      ).toBe('export {}')
    },
  )

  it('no subledger or stock table that would need reconciling has been migrated', () => {
    /*
     * The second precondition, and the one that can change without either
     * kernel gaining a line: a migration adding a document subledger
     * (customers, invoices, receipts, allocations — M3) or `stock_movements`
     * makes live reconciliation possible whatever the TypeScript looks like.
     * journal_entries / journal_lines (M2-A) are the GL side only; there is
     * nothing to reconcile them AGAINST until one of these exists.
     *
     * Reads the migration FILES rather than the database, so this runs
     * without a cluster and fails in the pull request that adds the table
     * rather than later.
     */
    const migrations = readFileSync(join(REPO_ROOT, 'database/migrations/CHECKSUMS'), 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((name): name is string => typeof name === 'string' && name.endsWith('.sql'))

    const created = migrations
      .flatMap((name) => {
        const sql = read(join('database/migrations', name))
        return [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/gi)].map((m) =>
          (m[1] ?? '').toLowerCase(),
        )
      })
      .filter(Boolean)

    // The GL side must exist for the re-arm above to mean anything.
    expect(created).toEqual(expect.arrayContaining(['journal_entries', 'journal_lines', 'parties']))

    const reconcilable = created.filter((t) =>
      /^(stock_|sales_|purchase_|customer|vendor|supplier|receipt|invoice|payment)|allocation/.test(
        t,
      ),
    )

    expect(
      reconcilable,
      'A table that reconciliation is ABOUT now exists, so the fixture-only suite\n' +
        'in this directory no longer covers what it appears to cover. See the\n' +
        'instructions on the kernel assertions above.',
    ).toEqual([])
  })
})

describe('what is proved today, stated so the suite cannot be over-read', () => {
  it('the reconcilers exist and are exercised', () => {
    /*
     * Deliberately weak, and labelled as such. It asserts only that the
     * comparison logic is present and imported — the STRENGTH of this
     * directory is in subledger-to-gl.spec.ts and valuation-to-ledger.spec.ts,
     * which prove the reconcilers detect breaks, name them, and do not net
     * one tenant or one account against another.
     *
     * What none of it proves is that any real ledger reconciles, because
     * there is no real ledger. Anyone reading a green run here should read
     * this sentence with it.
     */
    const source = meaningfulSource('tests/reconciliation/reconciler.ts')
    expect(source).toContain('reconcileSubledgerToGeneralLedger')
    expect(source).toContain('reconcileValuationToStockLedger')
  })

  it('and the reconcilers carry no tolerance parameter, now or ever', () => {
    /*
     * NON_NEGOTIABLES §4. Grepped rather than argued, because this is the
     * line most likely to be crossed by someone chasing a rounding
     * difference at the end of a long day — and a tolerance wide enough to
     * absorb one is wide enough to hide a missing journal line.
     */
    const source = meaningfulSource('tests/reconciliation/reconciler.ts')
    expect(source).not.toMatch(/tolerance|epsilon|\bapprox|closeTo/i)
  })
})
