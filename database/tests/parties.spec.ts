import { prepareTestDatabase, rawOn, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asTenant, createLedgerTenant, registerPartyRaw, stateOf } from './accounting-support.ts'
import { tables } from './catalog.ts'

/*
 * parties — ADR-0026 statement 1, migration 012.
 *
 * The kernel's party register: party_type CUSTOMER | VENDOR, INSERT-only for
 * finsoft_app, RLS enabled and forced. The exact column-level ACL is in
 * accounting-acl.spec.ts; this file proves the behaviour those grants and
 * constraints produce against real writes.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe('parties', () => {
  it('accepts CUSTOMER and VENDOR, and rejects any other party_type (23514)', async () => {
    const t = await createLedgerTenant('PTY')
    await asTenant(t, async (tx) => {
      await registerPartyRaw(tx, t, 'CUSTOMER')
      await registerPartyRaw(tx, t, 'VENDOR')
    })

    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `insert into parties (tenant_id, party_type, created_by, updated_by) values ($1, 'SUPPLIER', $2, $2)`,
          [t.tenantId, t.ownerId],
        ),
      ),
    )
    expect(state).toBe('23514')
  })

  it('refuses finsoft_app an UPDATE — a party type never changes (42501)', async () => {
    const t = await createLedgerTenant('PTU')
    const id = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))

    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(tx, `update parties set party_type = 'VENDOR' where id = $1`, [id]),
      ),
    )
    expect(state).toBe('42501')
  })

  it('refuses finsoft_app a DELETE (rule 4, 42501)', async () => {
    const t = await createLedgerTenant('PTD')
    const id = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'VENDOR'))

    const state = await stateOf(
      asTenant(t, (tx) => rawOn(tx, `delete from parties where id = $1`, [id])),
    )
    expect(state).toBe('42501')
  })

  it('refuses a caller-chosen id (column-scoped INSERT, 42501)', async () => {
    const t = await createLedgerTenant('PTI')
    const state = await stateOf(
      asTenant(t, (tx) =>
        rawOn(
          tx,
          `insert into parties (id, tenant_id, party_type, created_by, updated_by)
           values (gen_random_uuid(), $1, 'CUSTOMER', $2, $2)`,
          [t.tenantId, t.ownerId],
        ),
      ),
    )
    expect(state).toBe('42501')
  })

  it('is enabled AND forced under RLS', async () => {
    const row = (await tables()).find((x) => x.table_name === 'parties')
    expect(row?.rls_enabled).toBe(true)
    expect(row?.rls_forced).toBe(true)
  })

  it("hides another tenant's party, and refuses writing a party into another tenant", async () => {
    const a = await createLedgerTenant('PTA')
    const b = await createLedgerTenant('PTB')
    const bParty = await asTenant(b, (tx) => registerPartyRaw(tx, b, 'CUSTOMER'))

    const seen = await asTenant(a, (tx) =>
      rawOn<{ id: string }>(tx, `select id from parties where id = $1`, [bParty]),
    )
    expect(seen).toEqual([])

    // WITH CHECK: a row stamped with B's tenant_id, written under A's context.
    const state = await stateOf(
      asTenant(a, (tx) =>
        rawOn(
          tx,
          `insert into parties (tenant_id, party_type, created_by, updated_by) values ($1, 'CUSTOMER', $2, $2)`,
          [b.tenantId, b.ownerId],
        ),
      ),
    )
    expect(state).toBe('42501')
  })
})
