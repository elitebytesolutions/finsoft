import { prepareTestDatabase, rawOn, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  account,
  asTenant,
  cashCapital,
  createLedgerTenant,
  insertEntryRaw,
  insertLinesRaw,
  migrationClient,
  period,
  postBalancedRaw,
  registerPartyRaw,
  stateOf,
  type LedgerTenant,
  type RawLine,
} from './accounting-support.ts'

/*
 * journal_lines — ADR-0026 statements 2 and 3, migration 012.
 *
 * README §4.1's "an AR line carries a customer, an AP line a vendor, no
 * other line a party" is STRUCTURAL: two CHECKs plus two composite FKs.
 * Every case below is a raw INSERT, never the kernel — the kernel's own
 * pre-checks (PARTY_NOT_FOUND, PARTY_TYPE_MISMATCH) must not be what makes
 * these pass.
 *
 * Expected SQLSTATEs: 23514 check_violation (CHECK), 23503
 * foreign_key_violation (composite FK).
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

/** Try one entry whose first line is `line`, balanced against Owner's Capital. */
function tryLine(t: LedgerTenant, line: RawLine): Promise<string | undefined> {
  const amount = line.debit !== '0' ? line.debit : line.credit
  const offset: RawLine =
    line.debit !== '0'
      ? { accountId: account(t, '3100'), accountControl: 'NONE', debit: '0', credit: amount }
      : { accountId: account(t, '3100'), accountControl: 'NONE', debit: amount, credit: '0' }
  return stateOf(postBalancedRaw(t, line, offset))
}

describe('journal_lines: party / control pairing (ADR-0026)', () => {
  let t: LedgerTenant
  let customer: string
  let vendor: string

  beforeAll(async () => {
    t = await createLedgerTenant('JLP')
    ;[customer, vendor] = await asTenant(t, async (tx) => [
      await registerPartyRaw(tx, t, 'CUSTOMER'),
      await registerPartyRaw(tx, t, 'VENDOR'),
    ])
  })

  it('accepts the positive controls: AR+CUSTOMER, AP+VENDOR, NONE and INVENTORY with no party', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: customer,
      }),
    ).toBe('resolved')
    expect(
      await tryLine(t, {
        accountId: account(t, '2100'),
        accountControl: 'AP',
        debit: '0',
        credit: '10.0000',
        partyType: 'VENDOR',
        partyId: vendor,
      }),
    ).toBe('resolved')
    expect(await stateOf(postBalancedRaw(t, ...cashCapital(t)))).toBe('resolved')
    expect(
      await tryLine(t, {
        accountId: account(t, '1300'),
        accountControl: 'INVENTORY',
        debit: '10.0000',
        credit: '0',
      }),
    ).toBe('resolved')
  })

  it('rejects party_type without party_id, and party_id without party_type (23514)', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: null,
      }),
    ).toBe('23514')
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: null,
        partyId: customer,
      }),
    ).toBe('23514')
  })

  it('rejects an AR line with no party (23514) — the row the ADR text, read literally, would admit', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
      }),
    ).toBe('23514')
  })

  it('rejects an AP line with no party (23514)', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '2100'),
        accountControl: 'AP',
        debit: '0',
        credit: '10.0000',
      }),
    ).toBe('23514')
  })

  it('rejects a non-control line carrying a party (23514)', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '1110'),
        accountControl: 'NONE',
        debit: '10.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: customer,
      }),
    ).toBe('23514')
    expect(
      await tryLine(t, {
        accountId: account(t, '1300'),
        accountControl: 'INVENTORY',
        debit: '10.0000',
        credit: '0',
        partyType: 'VENDOR',
        partyId: vendor,
      }),
    ).toBe('23514')
  })

  it('rejects an AR line declaring a VENDOR party (23514, the CHECK)', async () => {
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: 'VENDOR',
        partyId: vendor,
      }),
    ).toBe('23514')
  })

  it('rejects an AR line naming a vendor as if it were a CUSTOMER (23503, the FK)', async () => {
    // party_type says CUSTOMER, so the CHECK passes; (tenant, CUSTOMER, <vendor id>)
    // does not exist in parties, so the composite FK is what refuses it.
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: vendor,
      }),
    ).toBe('23503')
  })

  it('rejects account_control disagreeing with the account (23503)', async () => {
    // Cash (1110) is NONE; claiming AR with a real customer satisfies both
    // CHECKs, and (tenant, cash, AR) is not a row of accounts.
    expect(
      await tryLine(t, {
        accountId: account(t, '1110'),
        accountControl: 'AR',
        debit: '10.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: customer,
      }),
    ).toBe('23503')
    // And the reverse: the AR control account claimed as NONE, no party.
    expect(
      await tryLine(t, {
        accountId: account(t, '1200'),
        accountControl: 'NONE',
        debit: '10.0000',
        credit: '0',
      }),
    ).toBe('23503')
  })
})

describe('journal_lines: the FK, not RLS, is what refuses cross-tenant references', () => {
  it("rejects another tenant's party, written through the BYPASSRLS migration role (23503)", async () => {
    const a = await createLedgerTenant('JLX')
    const b = await createLedgerTenant('JLY')
    const bCustomer = await asTenant(b, (tx) => registerPartyRaw(tx, b, 'CUSTOMER'))

    const client = migrationClient()
    await client.connect()
    try {
      const bypasses = await client.query<{ rolbypassrls: boolean }>(
        'select rolbypassrls from pg_roles where rolname = current_user',
      )
      // The premise: RLS cannot be what stops this, because this role is not subject to it.
      expect(bypasses.rows[0]?.rolbypassrls).toBe(true)

      await client.query('BEGIN')
      const entry = await client.query<{ id: string }>(
        `insert into journal_entries (tenant_id, entry_number, posting_rule, event, occurred_at,
           fiscal_period_id, narration, source_type, source_id, idempotency_key,
           request_fingerprint, created_by, updated_by)
         values ($1, 'JV-2027-900001', 'JOURNAL_VOUCHER_POSTED@1', 'JOURNAL_VOUCHER_POSTED',
           '2026-08-15', $2, 'cross-tenant probe', 'journal_voucher', gen_random_uuid(),
           'xtenant-probe', $3, $4, $4)
         returning id`,
        [a.tenantId, period(a, '2026-08'), 'b'.repeat(64), a.ownerId],
      )
      const state = await stateOf(
        client.query(
          `insert into journal_lines (tenant_id, entry_id, line_number, account_id, account_control,
             debit, credit, party_type, party_id, created_by, updated_by)
           values ($1, $2, 1, $3, 'AR', 10, 0, 'CUSTOMER', $4, $5, $5)`,
          [a.tenantId, entry.rows[0]?.id, account(a, '1200'), bCustomer, a.ownerId],
        ),
      )
      expect(state).toBe('23503')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })
})

describe('accounts.control_kind is pinned once posted to (ADR-0026 Compliance row 3)', () => {
  let t: LedgerTenant

  beforeAll(async () => {
    t = await createLedgerTenant('JLK')
    const customer = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    await postBalancedRaw(
      t,
      {
        accountId: account(t, '1200'),
        accountControl: 'AR',
        debit: '25.0000',
        credit: '0',
        partyType: 'CUSTOMER',
        partyId: customer,
      },
      { accountId: account(t, '4200'), accountControl: 'NONE', debit: '0', credit: '25.0000' },
    )
  })

  it('finsoft_app cannot UPDATE accounts at all (privilege layer, 42501)', async () => {
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(tx, `update accounts set control_kind = 'NONE' where id = $1`, [account(t, '1200')]),
      ),
    )
    expect(state).toBe('42501')
  })

  it('the migration role is refused too — by the posted-immutability trigger (23514)', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      const state = await stateOf(
        client.query(`update accounts set control_kind = 'NONE' where id = $1`, [
          account(t, '1200'),
        ]),
      )
      expect(state).toBe('23514')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })

  it('and by the composite FK on its own, with that trigger disabled (23503)', async () => {
    // DISABLE TRIGGER inside a transaction that is rolled back: transactional
    // DDL, never visible to any other connection, and it holds the table's
    // lock until the ROLLBACK. This proves the FK is an independent control,
    // not a restatement of the trigger.
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'ALTER TABLE accounts DISABLE TRIGGER accounts_enforce_posted_immutability',
      )
      const state = await stateOf(
        client.query(`update accounts set control_kind = 'NONE' where id = $1`, [
          account(t, '1200'),
        ]),
      )
      expect(state).toBe('23503')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })

  it('an account with no lines may still change control kind (the FK only pins posted accounts)', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      // M2-C (migration 018): accounts_enforce_posted_immutability now ALSO
      // rejects ANY change to a protected row (coa-standard.md §8.2/§8.7 R3)
      // — 1300 Inventory (control_kind INVENTORY) is protected regardless of
      // postings, which is a second, independent guard from the one this
      // test exists to isolate. Disabled here, exactly like the sibling
      // test above, so this proves the FK's OWN behaviour ("the FK only
      // pins posted accounts") rather than R3's.
      await client.query(
        'ALTER TABLE accounts DISABLE TRIGGER accounts_enforce_posted_immutability',
      )
      // 1300 Inventory has no lines in this tenant. INVENTORY -> NONE is
      // permitted by every CHECK on accounts.
      const result = await client.query(
        `update accounts set control_kind = 'NONE', version = version + 1 where id = $1`,
        [account(t, '1300')],
      )
      expect(result.rowCount).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })

  it('M2-C: with the trigger ENABLED, the same update is refused — R3 protects a control account regardless of postings', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      await client.query('BEGIN')
      await expect(
        client.query(
          `update accounts set control_kind = 'NONE', version = version + 1 where id = $1`,
          [account(t, '1300')],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  })
})

describe('journal_lines: lines are written only with their entry', () => {
  it('rejects appending lines to an entry committed by an earlier transaction (23514)', async () => {
    const t = await createLedgerTenant('JLA')
    const entryId = await postBalancedRaw(t, ...cashCapital(t))

    const state = await stateOf(
      asTenant(t, (tx) => insertLinesRaw(tx, t, entryId, cashCapital(t, '5.0000'))),
    )
    expect(state).toBe('23514')
  })

  it('rejects a line on a HEADER account (23514)', async () => {
    const t = await createLedgerTenant('JLH')
    const state = await stateOf(
      asTenant(t, async (tx) => {
        const entryId = await insertEntryRaw(tx, t)
        await insertLinesRaw(tx, t, entryId, [
          { accountId: account(t, '1000'), accountControl: 'NONE', debit: '1.0000', credit: '0' },
          { accountId: account(t, '3100'), accountControl: 'NONE', debit: '0', credit: '1.0000' },
        ])
      }),
    )
    expect(state).toBe('23514')
  })
})
