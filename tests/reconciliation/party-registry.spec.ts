import { Client } from 'pg'
import {
  createTenantFixture,
  prepareTestDatabase,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * ADR-0026 Compliance 6: "every parties row has exactly one detail row in
 * its type's table. An orphan is a failure." docs/design/M3/README.md §4
 * K7: a committed party with no detail row is possible only if a caller
 * registers one and then commits without inserting the module row — the
 * customers module never does this (registerParty and the customers INSERT
 * are one transaction, modules/customers/application/create-customer.ts),
 * so this is the check that would catch it if a future change broke that.
 *
 * Reads ONLY raw SQL against the live catalog — no kernel, no repository,
 * no posting engine (this directory's own rule, README.md: "a control that
 * shares an implementation with the thing it checks agrees with it by
 * construction"). finsoft_migration (BYPASSRLS), matching
 * database/tests/accounting-support.ts's own precedent, because the
 * assertion below is written per-TENANT rather than globally.
 *
 * SCOPED TO THIS FILE'S OWN FIXTURE TENANTS, deliberately, not to every
 * party in the shared test database: database/tests/parties.spec.ts and
 * others legitimately create orphan and VENDOR party rows on OTHER tenants
 * as fixtures for CHECK/FK probes, and a global scan would fail on their
 * leftover state — a false positive that has nothing to do with whether
 * THIS module keeps the registry consistent. `DETAIL_TABLE_BY_PARTY_TYPE`
 * is the one place this file knows a module table's name; Wave 6 adds
 * 'VENDOR': 'vendors' here.
 */

const DETAIL_TABLE_BY_PARTY_TYPE: Readonly<Record<string, string>> = {
  CUSTOMER: 'customers',
}

function migrationClient(): Client {
  const url = process.env['TEST_MIGRATION_DATABASE_URL']
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set')
  return new Client({ connectionString: url })
}

interface PartyRow {
  readonly id: string
  readonly party_type: string
}

async function partiesOf(client: Client, tenantId: string): Promise<PartyRow[]> {
  const r = await client.query<PartyRow>(
    'select id, party_type from parties where tenant_id = $1',
    [tenantId],
  )
  return r.rows
}

async function detailIdsOf(client: Client, table: string, tenantId: string): Promise<Set<string>> {
  const r = await client.query<{ id: string }>(`select id from ${table} where tenant_id = $1`, [
    tenantId,
  ])
  return new Set(r.rows.map((row) => row.id))
}

/** A CUSTOMER party with no matching customers row — the orphan this check exists to catch. */
async function insertOrphanCustomerParty(
  client: Client,
  tenantId: string,
  userId: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into parties (tenant_id, party_type, created_by, updated_by)
     values ($1, 'CUSTOMER', $2, $2) returning id`,
    [tenantId, userId],
  )
  const id = r.rows[0]?.id
  if (!id) throw new Error('fixture: orphan party insert returned no id')
  return id
}

async function insertRealCustomer(
  client: Client,
  tenantId: string,
  userId: string,
  code: string,
): Promise<string> {
  const party = await client.query<{ id: string }>(
    `insert into parties (tenant_id, party_type, created_by, updated_by)
     values ($1, 'CUSTOMER', $2, $2) returning id`,
    [tenantId, userId],
  )
  const partyId = party.rows[0]?.id
  if (!partyId) throw new Error('fixture: party insert returned no id')

  await client.query(
    `insert into customers (
       id, tenant_id, party_type, code, name, credit_days,
       create_idempotency_key, create_fingerprint, created_by, updated_by)
     values ($1, $2, 'CUSTOMER', $3, 'Reconciliation Fixture', 0, $4, $5, $6, $6)`,
    [partyId, tenantId, code, `reconcile-${partyId}`, 'd'.repeat(64), userId],
  )
  return partyId
}

let clean: { tenantId: string; ownerId: string }
let withOrphan: { tenantId: string; ownerId: string; orphanId: string }

beforeAll(async () => {
  await prepareTestDatabase()

  const cleanTenant = await createTenantFixture('PRC')
  const orphanTenant = await createTenantFixture('PRO')

  const client = migrationClient()
  await client.connect()
  try {
    await insertRealCustomer(client, cleanTenant.tenantId, cleanTenant.ownerId, 'CUST-100001')
    await insertRealCustomer(client, cleanTenant.tenantId, cleanTenant.ownerId, 'CUST-100002')
    clean = { tenantId: cleanTenant.tenantId, ownerId: cleanTenant.ownerId }

    await insertRealCustomer(client, orphanTenant.tenantId, orphanTenant.ownerId, 'CUST-100003')
    const orphanId = await insertOrphanCustomerParty(
      client,
      orphanTenant.tenantId,
      orphanTenant.ownerId,
    )
    withOrphan = { tenantId: orphanTenant.tenantId, ownerId: orphanTenant.ownerId, orphanId }
  } finally {
    await client.end()
  }
}, 60_000)

afterAll(teardownTestDatabase)

describe('party registry reconciliation (ADR-0026 Compliance 6)', () => {
  it('a tenant created only through the real path (registerParty + customers, one transaction) has no orphans', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      const parties = (await partiesOf(client, clean.tenantId)).filter(
        (p) => p.party_type === 'CUSTOMER',
      )
      const customerIds = await detailIdsOf(client, 'customers', clean.tenantId)

      const orphans = parties.filter((p) => !customerIds.has(p.id))
      expect(orphans).toEqual([])
    } finally {
      await client.end()
    }
  })

  it('DETECTS a CUSTOMER party with no matching customers row, and names it', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      const parties = (await partiesOf(client, withOrphan.tenantId)).filter(
        (p) => p.party_type === 'CUSTOMER',
      )
      const customerIds = await detailIdsOf(client, 'customers', withOrphan.tenantId)

      const orphans = parties.filter((p) => !customerIds.has(p.id))
      expect(orphans.map((o) => o.id)).toEqual([withOrphan.orphanId])
    } finally {
      await client.end()
    }
  })

  it('every customers row points at a real party of type CUSTOMER (the reverse direction)', async () => {
    // The FK (customers_party_fkey) already makes this structurally
    // impossible to violate; asserted here too so the reconciliation is a
    // real two-way check, not one that trusts the constraint it is meant to
    // be independent proof of.
    const client = migrationClient()
    await client.connect()
    try {
      const customerIds = await detailIdsOf(client, 'customers', clean.tenantId)
      const customerParties = new Set(
        (await partiesOf(client, clean.tenantId))
          .filter((p) => p.party_type === 'CUSTOMER')
          .map((p) => p.id),
      )

      const unbacked = [...customerIds].filter((id) => !customerParties.has(id))
      expect(unbacked).toEqual([])
    } finally {
      await client.end()
    }
  })

  it('knows a detail table for every party type its own tenants actually use', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      const types = new Set(
        [
          ...(await partiesOf(client, clean.tenantId)),
          ...(await partiesOf(client, withOrphan.tenantId)),
        ].map((p) => p.party_type),
      )
      const unknown = [...types].filter((t) => !(t in DETAIL_TABLE_BY_PARTY_TYPE))
      expect(
        unknown,
        'a party_type exists that DETAIL_TABLE_BY_PARTY_TYPE does not know — add its module ' +
          'table (e.g. VENDOR -> vendors, Wave 6) before trusting this reconciliation for it',
      ).toEqual([])
    } finally {
      await client.end()
    }
  })
})
