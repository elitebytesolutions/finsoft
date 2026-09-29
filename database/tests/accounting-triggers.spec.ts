import { randomUUID } from 'node:crypto'
import { closePeriod, lockPeriod, reopenPeriod, type TenantTx } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asTenant,
  cashCapital,
  createLedgerTenant,
  insertEntryRaw,
  insertLinesRaw,
  migrationClient,
  period,
  postBalancedRaw,
  stateOf,
  type LedgerTenant,
  type RawLine,
} from './accounting-support.ts'

/*
 * Trigger enforcement in migrations 011 and 012, each reproduced as a
 * failing write rather than asserted in prose:
 *
 *   fiscal_periods   transitions in calendar order; LOCKED is terminal for
 *                    every role; no stamp edits outside a transition
 *   journal_entries  immutable except POSTED -> REVERSED; posts only into an
 *                    OPEN period; at least two lines; reversal pairing
 *   journal_lines    append-only for every role; balanced at COMMIT
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

async function versionOf(tx: TenantTx, periodId: string): Promise<number> {
  const v = await scalarOn<number>(tx, 'select version from fiscal_periods where id = $1', [
    periodId,
  ])
  if (v === undefined) throw new Error(`no period ${periodId}`)
  return v
}

function close(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    const id = period(t, label)
    return closePeriod(tx, t.tenantId, id, await versionOf(tx, id), t.ownerId)
  })
}

function lock(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    const id = period(t, label)
    return lockPeriod(tx, t.tenantId, id, await versionOf(tx, id), t.ownerId)
  })
}

function reopen(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    const id = period(t, label)
    return reopenPeriod(tx, t.tenantId, id, await versionOf(tx, id), t.ownerId, 'test reopen')
  })
}

/** A raw UPDATE of the transition columns as finsoft_app — the trigger, not periods.ts, decides. */
function rawClose(t: LedgerTenant, label: string): Promise<string | undefined> {
  return stateOf(
    asTenant(t, (tx) =>
      rawOn(
        tx,
        `update fiscal_periods
            set status = 'CLOSED', closed_at = now(), closed_by = $2, updated_by = $2, version = version + 1
          where id = $1`,
        [period(t, label), t.ownerId],
      ),
    ),
  )
}

describe('fiscal_periods transition trigger (migration 011, ADR-0012)', () => {
  it('rejects closing a period while an earlier one is OPEN (23514)', async () => {
    const t = await createLedgerTenant('FPO')
    expect(await rawClose(t, '2026-08')).toBe('23514')
    expect(await rawClose(t, '2026-07')).toBe('resolved')
    expect(await rawClose(t, '2026-08')).toBe('resolved')
  })

  it('rejects locking a period while an earlier one is not LOCKED (23514)', async () => {
    const t = await createLedgerTenant('FPL')
    await close(t, '2026-07')
    await close(t, '2026-08')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update fiscal_periods
              set status = 'LOCKED', locked_at = now(), locked_by = $2, updated_by = $2, version = version + 1
            where id = $1`,
          [period(t, '2026-08'), t.ownerId],
        ),
      ),
    )
    expect(state).toBe('23514')
    await lock(t, '2026-07')
    await lock(t, '2026-08')
  })

  it('rejects reopening a period while a later one is CLOSED (23514)', async () => {
    const t = await createLedgerTenant('FPR')
    await close(t, '2026-07')
    await close(t, '2026-08')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update fiscal_periods
              set status = 'OPEN', closed_at = null, closed_by = null, reopened_at = now(),
                  reopened_by = $2, reopen_reason = 'x', updated_by = $2, version = version + 1
            where id = $1`,
          [period(t, '2026-07'), t.ownerId],
        ),
      ),
    )
    expect(state).toBe('23514')
    // The latest closed period may reopen.
    expect((await reopen(t, '2026-08')).status).toBe('OPEN')
  })

  it('makes LOCKED terminal — for finsoft_app AND for the migration role (23514)', async () => {
    const t = await createLedgerTenant('FPT')
    await close(t, '2026-07')
    await lock(t, '2026-07')

    const appState = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update fiscal_periods set status = 'CLOSED', updated_by = $2, version = version + 1 where id = $1`,
          [period(t, '2026-07'), t.ownerId],
        ),
      ),
    )
    expect(appState).toBe('23514')

    const client = migrationClient()
    await client.connect()
    try {
      const state = await stateOf(
        client.query(
          `update fiscal_periods set status = 'OPEN', closed_at = null, closed_by = null,
                  reopened_at = now(), reopened_by = created_by, reopen_reason = 'admin',
                  version = version + 1
            where id = $1`,
          [period(t, '2026-07')],
        ),
      )
      expect(state).toBe('23514')
    } finally {
      await client.end()
    }
  })

  it("rejects rewriting a closed period's closed_by with no transition (23514)", async () => {
    const t = await createLedgerTenant('FPS')
    await close(t, '2026-07')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update fiscal_periods set closed_by = $2, closed_at = now(), updated_by = $2, version = version + 1
            where id = $1`,
          [period(t, '2026-07'), t.ownerId],
        ),
      ),
    )
    expect(state).toBe('23514')
  })

  it('refuses a caller-chosen status at INSERT: a period is born OPEN (42501)', async () => {
    const t = await createLedgerTenant('FPI')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `insert into fiscal_periods (tenant_id, fiscal_year, period_index, period_start, period_end,
             label, status, created_by, updated_by)
           values ($1, 2028, 1, '2027-07-01', '2027-07-31', '2027-07', 'LOCKED', $2, $2)`,
          [t.tenantId, t.ownerId],
        ),
      ),
    )
    expect(state).toBe('42501')
  })
})

describe('journal_entries: the period gate (migration 012, ADR-0012)', () => {
  it('rejects an entry into a CLOSED period, and into a LOCKED one (23514)', async () => {
    const t = await createLedgerTenant('JPG')
    await close(t, '2026-07')
    expect(
      await stateOf(
        postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-07', occurredAt: '2026-07-10' }),
      ),
    ).toBe('23514')
    await lock(t, '2026-07')
    expect(
      await stateOf(
        postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-07', occurredAt: '2026-07-10' }),
      ),
    ).toBe('23514')
  })
})

describe('journal balance and completeness, at COMMIT (Invariant 1)', () => {
  it('rejects an unbalanced entry at commit (23514)', async () => {
    const t = await createLedgerTenant('JUB')
    const [dr] = cashCapital(t, '100.0000')
    const [, cr] = cashCapital(t, '99.9999')
    expect(await stateOf(postBalancedRaw(t, dr, cr))).toBe('23514')
  })

  it('rejects an entry with no lines at all (23514)', async () => {
    const t = await createLedgerTenant('JNL')
    expect(await stateOf(asTenant(t, (tx) => insertEntryRaw(tx, t)))).toBe('23514')
  })

  it('rejects a line with both sides zero, and one with both sides non-zero (23514)', async () => {
    const t = await createLedgerTenant('JOS')
    const [dr, cr] = cashCapital(t)
    const both: RawLine = { ...dr, debit: '1.0000', credit: '1.0000' }
    const neither: RawLine = { ...dr, debit: '0', credit: '0' }
    expect(await stateOf(postBalancedRaw(t, both, cr))).toBe('23514')
    expect(await stateOf(postBalancedRaw(t, neither, cr))).toBe('23514')
  })

  it('refuses a caller-chosen status at INSERT: an entry is born POSTED (42501)', async () => {
    const t = await createLedgerTenant('JBS')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `insert into journal_entries (tenant_id, entry_number, posting_rule, event, occurred_at,
             fiscal_period_id, status, narration, source_type, source_id, idempotency_key,
             request_fingerprint, created_by, updated_by)
           values ($1, 'JV-2027-000077', 'JOURNAL_VOUCHER_POSTED@1', 'JOURNAL_VOUCHER_POSTED',
             '2026-08-15', $2, 'REVERSED', 'x', 'journal_voucher', gen_random_uuid(), 'k-born',
             $3, $4, $4)`,
          [t.tenantId, period(t, '2026-08'), 'c'.repeat(64), t.ownerId],
        ),
      ),
    )
    expect(state).toBe('42501')
  })
})

describe('journal immutability (rule 2, ADR-0006)', () => {
  it('refuses finsoft_app an UPDATE of any non-transition column (42501)', async () => {
    const t = await createLedgerTenant('JIM')
    const id = await postBalancedRaw(t, ...cashCapital(t))
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(tx, `update journal_entries set narration = 'edited' where id = $1`, [id]),
      ),
    )
    expect(state).toBe('42501')
  })

  it('refuses the migration role an edit of a posted entry (23514, the trigger)', async () => {
    const t = await createLedgerTenant('JIT')
    const id = await postBalancedRaw(t, ...cashCapital(t))
    const client = migrationClient()
    await client.connect()
    try {
      const state = await stateOf(
        client.query(
          `update journal_entries set narration = 'edited', version = version + 1 where id = $1`,
          [id],
        ),
      )
      expect(state).toBe('23514')
    } finally {
      await client.end()
    }
  })

  it('refuses UPDATE and DELETE of journal_lines for every role, including the owner (42501)', async () => {
    const t = await createLedgerTenant('JLM')
    const id = await postBalancedRaw(t, ...cashCapital(t))

    expect(
      await stateOf(
        asTenant(t, (tx) =>
          rawOn(tx, `update journal_lines set memo = 'x' where entry_id = $1`, [id]),
        ),
      ),
    ).toBe('42501')

    const client = migrationClient()
    await client.connect()
    try {
      expect(
        await stateOf(
          client.query(`update journal_lines set memo = 'x' where entry_id = $1`, [id]),
        ),
      ).toBe('42501')
      expect(
        await stateOf(client.query(`delete from journal_lines where entry_id = $1`, [id])),
      ).toBe('42501')
      expect(
        await stateOf(client.query(`delete from journal_entries where id = $1`, [id])),
      ).not.toBe('resolved')
    } finally {
      await client.end()
    }
  })
})

describe('reversal (reversal.md §6, §8)', () => {
  /** Post R reversing E and mark E REVERSED, in one transaction, as the kernel does. */
  function reverse(t: LedgerTenant, entryId: string, lines: readonly RawLine[]) {
    return asTenant(t, async (tx) => {
      const r = await insertEntryRaw(tx, t, {
        postingRule: 'REVERSAL@1',
        sourceType: 'reversal',
        sourceId: entryId,
        reversalOf: entryId,
        reversalReason: 'test',
        entryNumber: `RV-2027-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      })
      await insertLinesRaw(
        tx,
        t,
        r,
        lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
      )
      await rawOn(
        tx,
        `update journal_entries
            set status = 'REVERSED', reversed_by = $2, reversed_at = now(), updated_by = $3,
                version = version + 1
          where id = $1`,
        [entryId, r, t.ownerId],
      )
      return r
    })
  }

  it('accepts a reversal committed together with the original transition', async () => {
    const t = await createLedgerTenant('RVO')
    const lines = cashCapital(t)
    const e = await postBalancedRaw(t, ...lines)
    expect(await stateOf(reverse(t, e, lines))).toBe('resolved')
  })

  it('rejects a second reversal of the same entry (23505 on reversal_of)', async () => {
    const t = await createLedgerTenant('RV2')
    const lines = cashCapital(t)
    const e = await postBalancedRaw(t, ...lines)
    await reverse(t, e, lines)
    // A second R: source uniqueness ('reversal', E.id) and UNIQUE (tenant_id, reversal_of).
    expect(await stateOf(reverse(t, e, lines))).toBe('23505')
  })

  it('rejects re-transitioning an already REVERSED entry (23514)', async () => {
    const t = await createLedgerTenant('RV3')
    const lines = cashCapital(t)
    const e = await postBalancedRaw(t, ...lines)
    const r = await reverse(t, e, lines)
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update journal_entries set status = 'REVERSED', reversed_by = $2, reversed_at = now(),
                  version = version + 1 where id = $1`,
          [e, r],
        ),
      ),
    )
    expect(state).toBe('23514')
  })

  it('rejects reversing a reversal (23514)', async () => {
    const t = await createLedgerTenant('RV4')
    const lines = cashCapital(t)
    const e = await postBalancedRaw(t, ...lines)
    const r = await reverse(t, e, lines)
    const reversedLines = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }))
    expect(await stateOf(reverse(t, r, reversedLines))).toBe('23514')
  })

  it('rejects a reversal that commits without marking its original REVERSED (23514)', async () => {
    const t = await createLedgerTenant('RV5')
    const lines = cashCapital(t)
    const e = await postBalancedRaw(t, ...lines)
    const state = await stateOf(
      asTenant(t, async (tx) => {
        const r = await insertEntryRaw(tx, t, {
          postingRule: 'REVERSAL@1',
          sourceType: 'reversal',
          sourceId: e,
          reversalOf: e,
          reversalReason: 'orphan',
        })
        await insertLinesRaw(
          tx,
          t,
          r,
          lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
        )
      }),
    )
    expect(state).toBe('23514')
  })

  it('rejects marking an entry REVERSED by an entry that does not reverse it (23514)', async () => {
    const t = await createLedgerTenant('RV6')
    const e = await postBalancedRaw(t, ...cashCapital(t))
    const unrelated = await postBalancedRaw(t, ...cashCapital(t), { sourceId: randomUUID() })
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `update journal_entries set status = 'REVERSED', reversed_by = $2, reversed_at = now(),
                  version = version + 1 where id = $1`,
          [e, unrelated],
        ),
      ),
    )
    expect(state).toBe('23514')
  })
})
