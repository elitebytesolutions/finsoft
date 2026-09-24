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

describe('the reconciliation deferral is still valid', () => {
  it.each([
    ['packages/accounting-kernel/src/index.ts', 'ADR-0005 posting engine', 'Wave 5'],
    ['packages/inventory-kernel/src/index.ts', 'ADR-0008/0018 movement ledger', 'Wave 6'],
  ])('%s is still empty', (path, what, wave) => {
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
  })

  it('no table that would need reconciling has been migrated', () => {
    /*
     * The second precondition, and the one that can change without either
     * kernel gaining a line: a migration adding `journal_entries` or
     * `stock_movements` makes live reconciliation possible whatever the
     * TypeScript looks like.
     *
     * Reads the migration FILES rather than the database, so this runs
     * without a cluster and fails in the pull request that adds the table
     * rather than later.
     */
    const migrations = readFileSync(join(REPO_ROOT, 'database/migrations/CHECKSUMS'), 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((name): name is string => Boolean(name) && name.endsWith('.sql'))

    const created = migrations
      .flatMap((name) => {
        const sql = read(join('database/migrations', name))
        return [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/gi)].map((m) =>
          (m[1] ?? '').toLowerCase(),
        )
      })
      .filter(Boolean)

    const reconcilable = created.filter((t) =>
      ['journal_entries', 'journal_lines', 'stock_movements', 'stock_balances'].includes(t),
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
