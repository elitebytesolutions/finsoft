import { randomUUID } from 'node:crypto'
import type { TenantTx } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asTenant,
  createLedgerTenant,
  migrationClient,
  registerPartyRaw,
  stateOf,
} from './accounting-support.ts'
import { tables } from './catalog.ts'

/*
 * customers — migration 015 (M3-C), ADR-0026 Compliance row 5, ADR-0028
 * S3 (composite tenant FK) and S4 (customers present under RLS).
 *
 * Written with RAW SQL as finsoft_app, deliberately NOT through
 * modules/customers: this file tests what the DATABASE refuses,
 * independently of whether the module would ever send the row —
 * database/tests/accounting-support.ts's own header, applied to the first
 * module table.
 */

const FINGERPRINT = 'c'.repeat(64)

async function insertCustomerRaw(
  tx: TenantTx,
  t: TenantFixture,
  opts: {
    readonly id: string
    readonly code?: string
    readonly partyType?: string
    readonly name?: string
    readonly ntn?: string | null
    readonly creditDays?: number
  },
): Promise<void> {
  await rawOn(
    tx,
    `insert into customers (
       id, tenant_id, party_type, code, name, ntn, credit_days,
       create_idempotency_key, create_fingerprint, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      opts.id,
      t.tenantId,
      opts.partyType ?? 'CUSTOMER',
      opts.code ?? `CUST-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
      opts.name ?? 'Fixture Customer',
      opts.ntn ?? null,
      opts.creditDays ?? 0,
      `idem-${randomUUID()}`,
      FINGERPRINT,
      t.ownerId,
    ],
  )
}

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe('customers', () => {
  it('ADR-0026 Compliance 5: a customer with no registered party is refused (23503)', async () => {
    const t = await createLedgerTenant('CNP')
    const state = await stateOf(asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: randomUUID() })))
    expect(state).toBe('23503')
  })

  it('ADR-0026 Compliance 5: a customer row on a VENDOR party is refused (23503)', async () => {
    const t = await createLedgerTenant('CVP')
    const vendorPartyId = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'VENDOR'))

    const state = await stateOf(
      asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: vendorPartyId, partyType: 'CUSTOMER' })),
    )
    // The composite FK (tenant_id, party_type, id) -> parties(tenant_id,
    // party_type, id) cannot match a VENDOR party row against a customers
    // row that claims party_type = 'CUSTOMER'.
    expect(state).toBe('23503')
  })

  it("ADR-0026 Compliance 5: customers.party_type is constant 'CUSTOMER' (23514)", async () => {
    const t = await createLedgerTenant('CPT')
    const partyId = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))

    const state = await stateOf(
      asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: partyId, partyType: 'VENDOR' })),
    )
    expect(state).toBe('23514')
  })

  it('accepts a customer whose id is a registered CUSTOMER party, in the same transaction', async () => {
    const t = await createLedgerTenant('COK')
    const id = await asTenant(t, async (tx) => {
      const partyId = await registerPartyRaw(tx, t, 'CUSTOMER')
      await insertCustomerRaw(tx, t, { id: partyId })
      return partyId
    })
    expect(id).toBeTruthy()
  })

  it('rejects an ntn that does not match 7 digits + optional hyphen + check digit (23514)', async () => {
    const t = await createLedgerTenant('CNT')
    const partyId = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    const state = await stateOf(
      asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: partyId, ntn: 'not-an-ntn' })),
    )
    expect(state).toBe('23514')
  })

  it('rejects creditDays outside 0-365 (23514)', async () => {
    const t = await createLedgerTenant('CCD')
    const partyId = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    const state = await stateOf(
      asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: partyId, creditDays: 400 })),
    )
    expect(state).toBe('23514')
  })

  it('enforces UNIQUE (tenant_id, code) (23505)', async () => {
    const t = await createLedgerTenant('CUC')
    const codeValue = `CUST-${String(Math.floor(Math.random() * 900_000) + 100_000)}`
    const first = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    await asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: first, code: codeValue }))

    const second = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    const state = await stateOf(
      asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: second, code: codeValue })),
    )
    expect(state).toBe('23505')
  })

  it('is enabled AND forced under RLS (S4)', async () => {
    const row = (await tables()).find((x) => x.table_name === 'customers')
    expect(row?.rls_enabled).toBe(true)
    expect(row?.rls_forced).toBe(true)
  })

  it("hides another tenant's customer, and refuses writing a customer into another tenant", async () => {
    const a = await createLedgerTenant('CTA')
    const b = await createLedgerTenant('CTB')
    const bParty = await asTenant(b, (tx) => registerPartyRaw(tx, b, 'CUSTOMER'))
    await asTenant(b, (tx) => insertCustomerRaw(tx, b, { id: bParty }))

    const seen = await asTenant(a, (tx) =>
      rawOn<{ id: string }>(tx, `select id from customers where id = $1`, [bParty]),
    )
    expect(seen).toEqual([])

    // WITH CHECK: a customer row stamped with B's tenant_id and B's own
    // party, written under A's session — refused by RLS before the FK is
    // even reached, because A cannot see B's party either.
    const aParty = await asTenant(a, (tx) => registerPartyRaw(tx, a, 'CUSTOMER'))
    const state = await stateOf(asTenant(a, (tx) => insertCustomerRaw(tx, b, { id: aParty })))
    expect(state).toBe('42501')
  })

  it('grants finsoft_app no DELETE (rule 4)', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      const r = await client.query<{ has_delete: boolean }>(
        `select has_table_privilege('finsoft_app', 'customers', 'DELETE') as has_delete`,
      )
      expect(r.rows[0]?.has_delete).toBe(false)
    } finally {
      await client.end()
    }
  })

  it('keeps id, tenant_id, party_type and code immutable, even for the owning migration role (42501)', async () => {
    const t = await createLedgerTenant('CIM')
    const id = await asTenant(t, async (tx) => {
      const partyId = await registerPartyRaw(tx, t, 'CUSTOMER')
      await insertCustomerRaw(tx, t, {
        id: partyId,
        code: `CUST-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
      })
      return partyId
    })

    const client = migrationClient()
    await client.connect()
    try {
      for (const statement of [
        `update customers set code = 'CUST-999999' where id = '${id}'`,
        `update customers set party_type = 'VENDOR' where id = '${id}'`,
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({
          code: '23514',
        })
      }
    } finally {
      await client.end()
    }
  })

  it('carries the mandatory column set, and the party FK is composite on tenant_id (S3)', async () => {
    const t = await createLedgerTenant('CCS')
    const partyId = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))
    await asTenant(t, (tx) => insertCustomerRaw(tx, t, { id: partyId }))

    const client = migrationClient()
    await client.connect()
    try {
      const r = await client.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conrelid = 'customers'::regclass and conname = 'customers_party_fkey'`,
      )
      expect(r.rows[0]?.definition).toMatch(/^FOREIGN KEY \(tenant_id, party_type, id\)/)
    } finally {
      await client.end()
    }
  })
})
