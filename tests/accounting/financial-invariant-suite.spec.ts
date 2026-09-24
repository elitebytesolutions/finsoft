import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase } from '@finsoft/database'
import { REPO_ROOT, migrateTestDatabase, prepareTestDatabase } from '@finsoft/database/testing'
import { constraints, columns } from '../../database/tests/catalog.ts'
import { GLOBAL_TABLES } from '@finsoft/database'
import { INVARIANTS, enforcedIds, pendingIds } from './invariants.ts'

/*
 * The FinancialInvariantSuite. NON_NEGOTIABLES §3: it runs on every PR, and
 * if it fails nothing merges.
 *
 * Wave 0 can execute exactly one of the ten. The other nine describe a
 * posting engine, a fiscal calendar and a stock ledger that do not exist
 * yet. The honest thing — and the thing §4 demands — is to register them as
 * pending rather than stub them green, and to make the pending set a ratchet
 * that can only shrink.
 */

/*
 * Resolved from the harness's REPO_ROOT rather than `import.meta.dirname`.
 * tsconfig.base.json uses module: NodeNext and nothing above this directory
 * declares "type": "module", so TypeScript treats these files as CommonJS and
 * rejects import.meta — even though Vitest runs them as ESM. Reusing the
 * already-resolved root keeps every test tsconfig identical instead of giving
 * this one directory a different module setting.
 */
const BASELINE = join(REPO_ROOT, 'tests', 'accounting', 'pending-baseline.json')

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()
}, 120_000)

afterAll(async () => {
  await closeDatabase()
})

describe('FinancialInvariantSuite: the ratchet', () => {
  const baseline: { pending: number[] } = JSON.parse(readFileSync(BASELINE, 'utf8'))

  it('registers all ten invariants from NON_NEGOTIABLES §3', () => {
    expect(INVARIANTS.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('has no invariant pending that the baseline does not already permit', () => {
    // A new pending id here means an invariant regressed, or one was added
    // without being implemented. Either way the suite must not go quietly
    // green with a larger hole than it had yesterday.
    const unexpected = pendingIds().filter((id) => !baseline.pending.includes(id))
    expect(
      unexpected,
      `Invariant(s) ${unexpected.join(', ')} became pending. The pending set may only shrink.`,
    ).toEqual([])
  })

  it('fails when an invariant is enforced but still listed as pending', () => {
    // This is the half that makes it a ratchet rather than a ceiling: once
    // an invariant is implemented, the baseline MUST be shrunk by hand. The
    // suite refuses to let the count stay stale.
    const stale = enforcedIds().filter((id) => baseline.pending.includes(id))
    expect(
      stale,
      `Invariant(s) ${stale.join(', ')} are now enforced. Remove them from pending-baseline.json.`,
    ).toEqual([])
  })

  it('keeps the baseline free of ids that are not registered invariants', () => {
    const known = new Set(INVARIANTS.map((i) => i.id))
    expect(baseline.pending.filter((id) => !known.has(id))).toEqual([])
  })

  it('reports what is not yet covered, so a green run is not mistaken for a complete one', () => {
    const pending = INVARIANTS.filter((i) => i.status === 'pending')
    // Not an assertion about correctness — it prints the outstanding set so
    // it appears in every CI log rather than only in this file.
    console.warn(
      `\n  FinancialInvariantSuite: ${enforcedIds().length}/10 enforced, ${pending.length} pending —\n` +
        pending.map((i) => `    ${i.id}. ${i.statement}\n       ${i.note}`).join('\n') +
        '\n',
    )
    expect(pending.length + enforcedIds().length).toBe(10)
  })
})

describe('Invariant 7: cross-tenant references are impossible', () => {
  /*
   * NON_NEGOTIABLES states this as "no journal line points at another
   * tenant's account". The journal does not exist yet, so it is enforced in
   * the generalised form ADR-0003:29 gives it, which is the one that will
   * still be true when the journal arrives.
   *
   * This is not a duplicate of database/tests/schema.spec.ts. That suite
   * asserts every tenant-owned table foreign-keys tenant_id to tenants(id).
   * This asserts something different and strictly stronger: a foreign key
   * from one tenant-owned table to ANOTHER must itself carry tenant_id.
   *
   * It matters because referential integrity checks bypass row security. A
   * single-column FK lets tenant A reference tenant B's row with RLS both
   * enabled and forced — demonstrated during FND-007/008 by removing the
   * composite key and watching a cross-tenant insert succeed.
   */
  it('requires every foreign key between tenant-owned tables to carry tenant_id', async () => {
    const [allConstraints, allColumns] = await Promise.all([constraints(), columns()])

    const tenantOwned = new Set(
      allColumns
        .filter((c) => c.column_name === 'tenant_id')
        .map((c) => c.table_name)
        .filter((t) => !(GLOBAL_TABLES as readonly string[]).includes(t)),
    )

    const offenders = allConstraints
      .filter((c) => c.contype === 'f')
      .filter((c) => tenantOwned.has(c.table_name))
      .filter((c) => c.referenced_table !== null && tenantOwned.has(c.referenced_table))
      .filter((c) => !/FOREIGN KEY \(tenant_id,/.test(c.definition))
      .map((c) => `${c.table_name}.${c.constraint_name}: ${c.definition}`)

    expect(
      offenders,
      'A foreign key between two tenant-owned tables must lead with tenant_id. ' +
        'Referential integrity checks bypass RLS, so a single-column key is a live ' +
        'cross-tenant path even with row security enabled and forced (ADR-0003:29).',
    ).toEqual([])
  })

  it('has at least one such foreign key to assert against', async () => {
    // Guards against the assertion above passing vacuously on a schema that
    // simply has no cross-table references yet.
    const [allConstraints, allColumns] = await Promise.all([constraints(), columns()])
    const tenantOwned = new Set(
      allColumns
        .filter((c) => c.column_name === 'tenant_id')
        .map((c) => c.table_name)
        .filter((t) => !(GLOBAL_TABLES as readonly string[]).includes(t)),
    )
    const crossTable = allConstraints
      .filter((c) => c.contype === 'f')
      .filter((c) => tenantOwned.has(c.table_name))
      .filter((c) => c.referenced_table !== null && tenantOwned.has(c.referenced_table))

    expect(crossTable.length).toBeGreaterThan(0)
  })
})
