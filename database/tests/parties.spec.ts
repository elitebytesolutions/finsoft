import { prepareTestDatabase, rawOn, teardownTestDatabase } from '@finsoft/database/testing'
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

  it('refuses UPDATE, DELETE and TRUNCATE to the OWNING migration role — the trigger, not the grants (42501)', async () => {
    const t = await createLedgerTenant('PTO')
    const id = await asTenant(t, (tx) => registerPartyRaw(tx, t, 'CUSTOMER'))

    const client = migrationClient()
    await client.connect()
    try {
      // finsoft_migration owns parties (roles.spec.ts): the privilege layer
      // does not apply to it, so each refusal below is parties_forbid_mutation.
      const owner = await client.query<{ owner: string }>(
        `select relowner::regrole::text as owner from pg_class where oid = 'parties'::regclass`,
      )
      expect(owner.rows[0]?.owner).toBe('finsoft_migration')

      for (const statement of [
        `update parties set party_type = 'VENDOR' where id = '${id}'`,
        `update parties set version = version + 1 where id = '${id}'`,
        `delete from parties where id = '${id}'`,
        // Listed first so ITS before-truncate trigger fires first; every
        // other table here is named only because the FK forbids truncating
        // parties or customers alone. customers (M3-C, migration 015) has a
        // foreign key into parties (ADR-0026 statement 4); sales_invoices
        // and customer_receipts (M3-P, migrations 016-017) each have a
        // foreign key into customers; sales_invoice_lines,
        // customer_receipt_draft_allocations and customer_receipt_allocations
        // each have a foreign key into sales_invoices (and the latter two
        // into customer_receipts too). Omitting any of them now fails at
        // the FK check (0A000) before the trigger even runs, rather than at
        // parties_forbid_mutation.
        'truncate parties, journal_lines, customers, sales_invoices, sales_invoice_lines, ' +
          'customer_receipts, customer_receipt_draft_allocations, customer_receipt_allocations',
      ]) {
        await client.query('BEGIN')
        try {
          // Take every table in the order a posting does (journal_lines,
          // then parties via the FK check; customers alongside parties,
          // since it is the other referencing table this TRUNCATE must
          // name) so TRUNCATE's own acquisition order can never deadlock
          // (40P01) against a concurrent posting on a shared test cluster.
          // Observed once without this.
          await client.query(
            'lock table journal_lines, parties, customers, sales_invoices, sales_invoice_lines, ' +
              'customer_receipts, customer_receipt_draft_allocations, customer_receipt_allocations ' +
              'in access exclusive mode',
          )
          await expect(client.query(statement), statement).rejects.toMatchObject({
            code: '42501',
            message: expect.stringMatching(/^parties is insert-only/),
          })
        } finally {
          await client.query('ROLLBACK')
        }
      }
    } finally {
      await client.end()
    }

    const still = await asTenant(t, (tx) =>
      rawOn<{ party_type: string }>(tx, 'select party_type from parties where id = $1', [id]),
    )
    expect(still).toEqual([{ party_type: 'CUSTOMER' }])
  })

  it('has all three forbid-mutation triggers ENABLED (tgenabled = O), not merely present', async () => {
    // The owner can ALTER TABLE parties DISABLE TRIGGER; presence alone is
    // not the assertion (same doctrine as audit_log, ADR-0020 Compliance).
    const client = migrationClient()
    await client.connect()
    try {
      const r = await client.query<{ tgname: string; tgenabled: string }>(
        `select t.tgname, t.tgenabled
           from pg_trigger t
          where t.tgrelid = 'parties'::regclass and not t.tgisinternal
          order by t.tgname`,
      )
      expect(r.rows.map((x) => x.tgname)).toEqual([
        'parties_no_delete',
        'parties_no_truncate',
        'parties_no_update',
      ])
      for (const row of r.rows) {
        expect(row.tgenabled, `${row.tgname} is not enabled ('O')`).toBe('O')
      }
    } finally {
      await client.end()
    }
  })

  it('carries the ADR-0026 Compliance 8 index exactly: (tenant_id, party_id, account_id) WHERE party_id IS NOT NULL', async () => {
    const client = migrationClient()
    await client.connect()
    try {
      const r = await client.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
          where tablename = 'journal_lines' and indexdef ilike '%party_id%'`,
      )
      expect(r.rows).toEqual([
        {
          indexname: 'journal_lines_tenant_party_account_idx',
          indexdef:
            'CREATE INDEX journal_lines_tenant_party_account_idx ON public.journal_lines USING btree (tenant_id, party_id, account_id) WHERE (party_id IS NOT NULL)',
        },
      ])
    } finally {
      await client.end()
    }
  })
})
