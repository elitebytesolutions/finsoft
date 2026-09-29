import { randomUUID } from 'node:crypto'
import { periodEngine } from '@finsoft/accounting-kernel'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
  TEST_TARGET,
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

function close(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    return periodEngine.close(label, tx)
  })
}

function lock(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    return periodEngine.lock(label, tx)
  })
}

function reopen(t: LedgerTenant, label: string) {
  return asTenant(t, async (tx) => {
    return periodEngine.reopen(label, 'test reopen', tx)
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

  it("rejects a closed month's date filed under the next OPEN period's id (23514, Council T3 R1)", async () => {
    const t = await createLedgerTenant('JPD')
    await close(t, '2026-07')
    // 2026-08 is OPEN; the date is in CLOSED July. Status alone would pass.
    expect(
      await stateOf(
        postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-08', occurredAt: '2026-07-10' }),
      ),
    ).toBe('23514')
    // Both boundaries of the named period are inclusive; one day either side is not.
    expect(
      await stateOf(
        postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-08', occurredAt: '2026-09-01' }),
      ),
    ).toBe('23514')
    for (const d of ['2026-08-01', '2026-08-31']) {
      expect(
        await stateOf(
          postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-08', occurredAt: d }),
        ),
      ).toBe('resolved')
    }
  })
})

/**
 * The period gate as the BYPASSRLS, table-owning migration role. RLS is not
 * what stops these; the trigger is. Each attempt runs in a transaction that
 * is rolled back whatever happens.
 */
async function migrationRoleEntryInto(
  t: LedgerTenant,
  periodLabel: string,
  occurredAt: string,
): Promise<string | undefined> {
  const client = migrationClient()
  await client.connect()
  try {
    await client.query('BEGIN')
    return await stateOf(
      client.query(
        `insert into journal_entries (tenant_id, entry_number, posting_rule, event, occurred_at,
           fiscal_period_id, narration, source_type, source_id, idempotency_key,
           request_fingerprint, created_by, updated_by)
         values ($1, 'JV-2027-900001', 'JOURNAL_VOUCHER_POSTED@1', 'JOURNAL_VOUCHER_POSTED',
           $2, $3, 'migration-role bypass attempt', 'journal_voucher', gen_random_uuid(),
           $4, $5, $6, $6)`,
        [
          t.tenantId,
          occurredAt,
          period(t, periodLabel),
          `mig-${randomUUID()}`,
          'd'.repeat(64),
          t.ownerId,
        ],
      ),
    )
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

describe('the period gate binds the migration role too (Council T3 Acct R2 / DB R6)', () => {
  it('refuses finsoft_migration an entry into a CLOSED period, and into a LOCKED one (23514)', async () => {
    const t = await createLedgerTenant('JMB')
    // Positive control: the same statement, same role, into an OPEN period, is accepted
    // (at the INSERT; the deferred completeness check never runs because we roll back).
    expect(await migrationRoleEntryInto(t, '2026-07', '2026-07-10')).toBe('resolved')

    await close(t, '2026-07')
    expect(await migrationRoleEntryInto(t, '2026-07', '2026-07-10')).toBe('23514')
    await lock(t, '2026-07')
    expect(await migrationRoleEntryInto(t, '2026-07', '2026-07-10')).toBe('23514')
    // And the mismatched-period route around it, as the migration role.
    expect(await migrationRoleEntryInto(t, '2026-08', '2026-07-10')).toBe('23514')
  })
})

/**
 * Poll until some backend in this database is waiting on a heavyweight lock.
 * Reads pg_locks (ungranted entries), NOT pg_stat_activity: the latter hides
 * wait_event_type for backends of other roles unless the viewer holds
 * pg_read_all_stats, so finsoft_migration could never see finsoft_app wait.
 */
async function waitUntilSomeoneIsBlocked(): Promise<void> {
  const client = migrationClient()
  await client.connect()
  try {
    for (let i = 0; i < 200; i += 1) {
      const r = await client.query<{ n: string }>(
        // No join to pg_database: a row-lock waiter's ungranted lock is on
        // the holder's transactionid, whose pg_locks.database is NULL.
        // Measured: that was the ONLY ungranted row, and a database join
        // hid it. database/tests runs files sequentially, so nothing else
        // is in flight to produce a false positive.
        `select count(*)::text as n from pg_locks l
          where not l.granted and l.locktype in ('transactionid', 'tuple')
            and l.pid <> pg_backend_pid()`,
      )
      if (r.rows[0]?.n !== '0') return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('no backend became blocked within 5s')
  } finally {
    await client.end()
  }
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

describe('posting vs close, concurrently (ADR-0012; journal-voucher.md: "commits before the close or is rejected after it")', () => {
  // Two transactions must be in flight at once. On the default pool of ONE
  // connection the second would queue for the connection rather than block
  // on the row lock — nothing ever shows as blocked, the first never
  // releases, and every later test in the file inherits the hang.
  beforeAll(async () => {
    await closeDatabase()
    process.env['DATABASE_POOL_MAX'] = '4'
    await openDatabase(TEST_TARGET)
  })
  afterAll(async () => {
    await closeDatabase()
    process.env['DATABASE_POOL_MAX'] = '1'
    await openDatabase(TEST_TARGET)
  })

  it('POST FIRST: the close waits on the posting, and the posting commits into the period', async () => {
    const t = await createLedgerTenant('JCP')
    await close(t, '2026-07') // §4.1 order: August can close only after July.

    const release = gate()
    const inserted = gate()
    let entryId: string | undefined
    const posting = asTenant(t, async (tx) => {
      entryId = await insertEntryRaw(tx, t, { periodLabel: '2026-08', occurredAt: '2026-08-20' })
      await insertLinesRaw(tx, t, entryId, cashCapital(t))
      inserted.open() // the trigger now holds 2026-08 FOR SHARE
      await release.wait
    })
    await inserted.wait

    let closeSettled = false
    const closing = close(t, '2026-08').finally(() => {
      closeSettled = true
    })
    try {
      await waitUntilSomeoneIsBlocked()
      expect(closeSettled, 'the close must wait on the posting').toBe(false)
    } finally {
      release.open()
    }
    await posting
    expect((await closing).status).toBe('CLOSED')

    const committed = await asTenant(t, (tx) =>
      rawOn<{ fiscal_period_id: string }>(
        tx,
        'select fiscal_period_id from journal_entries where id = $1',
        [entryId],
      ),
    )
    expect(committed).toEqual([{ fiscal_period_id: period(t, '2026-08') }])
  }, 20_000)

  it('CLOSE FIRST: the posting waits on the close, then is rejected against the committed CLOSED status (23514)', async () => {
    const t = await createLedgerTenant('JCC')
    await close(t, '2026-07')

    const release = gate()
    const closed = gate()
    const closing = asTenant(t, async (tx) => {
      const result = await periodEngine.close('2026-08', tx)
      closed.open() // CLOSED written, uncommitted; the calendar is held FOR UPDATE
      await release.wait
      return result
    })
    await closed.wait

    let postSettled = false
    const posting = stateOf(
      postBalancedRaw(t, ...cashCapital(t), { periodLabel: '2026-08', occurredAt: '2026-08-20' }),
    ).finally(() => {
      postSettled = true
    })
    try {
      await waitUntilSomeoneIsBlocked()
      expect(postSettled, 'the posting must wait on the close').toBe(false)
    } finally {
      release.open()
    }
    expect((await closing).status).toBe('CLOSED')
    expect(await posting).toBe('23514')

    const count = await asTenant(t, (tx) =>
      scalarOn<string>(
        tx,
        'select count(*)::text from journal_entries where fiscal_period_id = $1',
        [period(t, '2026-08')],
      ),
    )
    expect(count).toBe('0')
  }, 20_000)
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
