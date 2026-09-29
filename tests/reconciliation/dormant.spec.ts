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

  /*
   * M3-C (this migration, 015): THE SECOND PRECONDITION PARTIALLY FIRED, AS
   * DESIGNED, AND WAS ANSWERED RATHER THAN WEAKENED.
   *
   * `customers` is the first table this precondition's regex was written to
   * catch. It is master data, not a subledger DOCUMENT with monetary lines
   * of its own — creating a customer posts nothing — so it does not, by
   * itself, make SUBLEDGER-TO-GL reconciliation (reconcileSubledgerToGeneralLedger,
   * this directory's own comparison) either possible or necessary yet: that
   * still needs `sales_invoices` / `customer_receipts` / an allocations
   * table, none of which exist until M3-P. What `customers` DOES make
   * possible is the ADJACENT reconciliation ADR-0026 Compliance 6 calls
   * for — the party registry (parties <-> customers, by shared id) — and
   * that one is answered live, not deferred:
   * tests/reconciliation/party-registry.spec.ts, run against real rows,
   * every test run, with a fixture proving it detects an orphan and names
   * it.
   *
   * `CUSTOMERS_TABLE_ANSWERED_BY` is a narrow, reviewed exception — like
   * `GLOBALLY_UNIQUE_INDEX_ALLOWLIST` (database/tests/schema.spec.ts) — not
   * a widening of the regex: `customer_receipts`, `sales_invoices` and an
   * allocations table still trip this same assertion the moment M3-P adds
   * them, exactly as designed, because only the literal name "customers" is
   * excepted.
   */
  const CUSTOMERS_TABLE_ANSWERED_BY =
    'tests/reconciliation/party-registry.spec.ts (ADR-0026 Compliance 6)'

  it('no subledger or stock table that would need reconciling has been migrated (except customers, answered)', () => {
    /*
     * The second precondition, and the one that can change without either
     * kernel gaining a line: a migration adding a document subledger
     * (invoices, receipts, allocations — M3-P) or `stock_movements` makes
     * live subledger-to-GL reconciliation possible whatever the TypeScript
     * looks like. journal_entries / journal_lines (M2-A) are the GL side
     * only; there is nothing to reconcile them AGAINST until one of these
     * exists.
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
    // customers itself must exist too, or the exception below is vacuous.
    expect(created).toEqual(expect.arrayContaining(['customers']))

    const reconcilable = created
      .filter((t) =>
        /^(stock_|sales_|purchase_|customer|vendor|supplier|receipt|invoice|payment)|allocation/.test(
          t,
        ),
      )
      .filter((t) => t !== 'customers')

    expect(
      reconcilable,
      'A table that reconciliation is ABOUT now exists, so the fixture-only suite\n' +
        'in this directory no longer covers what it appears to cover. See the\n' +
        'instructions on the kernel assertions above.\n\n' +
        `('customers' is excepted, answered by ${CUSTOMERS_TABLE_ANSWERED_BY} — see this file's ` +
        'own comment above this test for why that is not a widening of the regex.)',
    ).toEqual([])
  })

  /*
   * M3-Q (2026-09-29): NEITHER PRECONDITION HAS FIRED, SO NOTHING HERE
   * CHANGES — this note exists so a reader can see this was checked, not
   * assumed. `sales_invoices` / `customer_receipts` still do not exist
   * (M3-P has not merged migrations 016/017; as of this writing M3-P's own
   * branch carries zero commits beyond `develop` — see the M3-Q report),
   * and `IMPLEMENTED_EVENTS` above is still exactly
   * `['JOURNAL_VOUCHER_POSTED']`. Both assertions in this describe block
   * are therefore still correctly PASSING, i.e. the tripwire is still
   * correctly ARMED — this is not the moment either fires.
   *
   * What IS ready, so the tripwire's own instructions ("wire
   * reconcileSubledgerToGeneralLedger... to real rows") take one PR to
   * carry out rather than a redesign, once it does fire:
   *   - tests/accounting/ar-invariant-9.ts: GL(C, D) and SUB(C, D) per
   *     customer-receipt.md §8, gated by `invariant9Available()` on the
   *     same two preconditions this file checks.
   *   - tests/reconciliation/subledger-to-gl-ar.spec.ts: wires
   *     `reconcileSubledgerToGeneralLedger` (THIS directory's own,
   *     unchanged comparison) to real rows via ar-invariant-9.ts, gated
   *     the same way — it reports "unavailable" today, for the same
   *     reason this file does.
   *   - tests/accounting/golden-posting-runner.ts and
   *     tests/accounting/posting-scenarios-m3.spec.ts: the golden-scenario
   *     runner support for P04-P12, gated on a REAL `modules/receivables`
   *     (tests/accounting/receivables-real-port.ts), not on this file's
   *     two preconditions — a third, independent gate, because the golden
   *     runner needs the MODULE, not only the kernel event flip.
   *
   * None of the above weakens this file. Flipping either precondition is
   * still a deliberate act in M3-P's own PR — this note only says the
   * follow-through is already built and waiting, not that it has run.
   */
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
