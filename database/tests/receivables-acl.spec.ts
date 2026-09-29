import { withGlobal } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * EXACT-SET ACL and forbid-mutation triggers on the receivables tables,
 * migrations 016-017. Security seat, Council review of efb7e3f (S-A):
 * "posted invoice lines are editable" — the first draft REVOKEd nothing on
 * sales_invoice_lines, customer_receipt_draft_allocations or
 * customer_receipt_allocations before granting a narrow column list, so the
 * bootstrap role's own default-privilege setting (FND-005) left finsoft_app
 * with table-level UPDATE underneath the narrow grant. Mirrors
 * database/tests/accounting-acl.spec.ts's own pattern and header note
 * exactly, one table at a time — "a privilege statement's success is not
 * evidence that it did anything" (migration 005).
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

async function columnsOf(table: string): Promise<string[]> {
  const rows = await withGlobal((tx) =>
    rawOn<{ column_name: string }>(
      tx,
      `select a.attname as column_name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
        where c.relname = $1 and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [table],
    ),
  )
  return rows.map((r) => r.column_name)
}

async function mayColumn(
  role: string,
  table: string,
  column: string,
  priv: string,
): Promise<boolean> {
  const value = await withGlobal((tx) =>
    scalarOn<boolean>(tx, 'select has_column_privilege($1, $2, $3, $4)', [
      role,
      table,
      column,
      priv,
    ]),
  )
  return value === true
}

/** The exact set of columns `role` may exercise `priv` on, computed column by column. */
async function columnPrivilegeSet(role: string, table: string, priv: string): Promise<Set<string>> {
  const columns = await columnsOf(table)
  const granted = await Promise.all(columns.map((c) => mayColumn(role, table, c, priv)))
  return new Set(columns.filter((_, i) => granted[i]))
}

/** The exact (grantee, privilege) set in pg_class.relacl. */
async function tableAcl(table: string): Promise<Set<string>> {
  const rows = await withGlobal((tx) =>
    rawOn<{ grantee: string; privilege_type: string }>(
      tx,
      `select case when acl.grantee = 0 then 'PUBLIC' else acl.grantee::regrole::text end as grantee,
              acl.privilege_type
         from pg_class c
        cross join lateral aclexplode(c.relacl) acl
        where c.relname = $1`,
      [table],
    ),
  )
  return new Set(rows.map((r) => `${r.grantee}:${r.privilege_type}`))
}

const grantsOf = (acl: Set<string>, grantee: string): string[] =>
  [...acl]
    .filter((entry) => entry.startsWith(`${grantee}:`))
    .map((entry) => entry.slice(grantee.length + 1))
    .sort()

async function publicColumnGrants(table: string): Promise<string[]> {
  const rows = await withGlobal((tx) =>
    rawOn<{ column_name: string; privilege_type: string }>(
      tx,
      `select a.attname as column_name, acl.privilege_type
         from (
           select att.attname, att.attacl
             from pg_attribute att
             join pg_class c on c.oid = att.attrelid
            where c.relname = $1
              and att.attnum > 0
              and not att.attisdropped
              and att.attacl is not null
         ) a
        cross join lateral aclexplode(a.attacl) acl
        where acl.grantee = 0`,
      [table],
    ),
  )
  return rows.map((r) => `${r.column_name}:${r.privilege_type}`)
}

async function enabledTriggers(table: string): Promise<Map<string, string>> {
  const rows = await withGlobal((tx) =>
    rawOn<{ tgname: string; tgenabled: string }>(
      tx,
      `select t.tgname, t.tgenabled
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
        where c.relname = $1 and not t.tgisinternal`,
      [table],
    ),
  )
  return new Map(rows.map((r) => [r.tgname, r.tgenabled]))
}

const MANDATORY = [
  'id',
  'tenant_id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'version',
]

const TABLES = [
  'sales_invoices',
  'sales_invoice_lines',
  'customer_receipts',
  'customer_receipt_draft_allocations',
  'customer_receipt_allocations',
] as const

const EXPECTED: Record<
  (typeof TABLES)[number],
  { columns: string[]; insert: string[]; update: string[]; requiredTriggers: string[] }
> = {
  sales_invoices: {
    columns: [
      ...MANDATORY,
      'customer_id',
      'status',
      'number',
      'invoice_date',
      'due_date',
      'narration',
      'net_amount',
      'lines_revision',
      'posted_at',
      'posted_by',
      'post_idempotency_key',
      'post_fingerprint',
      'reversed_at',
      'reversed_by',
      'reversal_reason',
      'reverse_idempotency_key',
      'reverse_fingerprint',
      'cancelled_at',
      'cancelled_by',
      'create_idempotency_key',
      'create_fingerprint',
    ].sort(),
    insert: [
      'tenant_id',
      'customer_id',
      'status',
      'invoice_date',
      'due_date',
      'narration',
      'net_amount',
      'lines_revision',
      'create_idempotency_key',
      'create_fingerprint',
      'created_by',
      'updated_by',
    ],
    update: [
      'customer_id',
      'status',
      'number',
      'invoice_date',
      'due_date',
      'narration',
      'net_amount',
      'lines_revision',
      'posted_at',
      'posted_by',
      'reversed_at',
      'reversed_by',
      'reversal_reason',
      'cancelled_at',
      'cancelled_by',
      'post_idempotency_key',
      'post_fingerprint',
      'reverse_idempotency_key',
      'reverse_fingerprint',
      'updated_by',
      'version',
    ],
    requiredTriggers: ['sales_invoices_set_updated_at', 'sales_invoices_enforce_transition'],
  },
  // Insert-only (modules.md §7): no UPDATE grant, and the forbid-mutation
  // trigger is the role-independent backstop — see this file's header.
  sales_invoice_lines: {
    columns: [
      ...MANDATORY,
      'invoice_id',
      'revision',
      'line_no',
      'kind',
      'description',
      'quantity',
      'unit_price',
      'line_net',
    ].sort(),
    insert: [
      'tenant_id',
      'invoice_id',
      'revision',
      'line_no',
      'kind',
      'description',
      'quantity',
      'unit_price',
      'line_net',
      'created_by',
      'updated_by',
    ],
    update: [],
    requiredTriggers: [
      'sales_invoice_lines_enforce_revision',
      'sales_invoice_lines_no_update',
      'sales_invoice_lines_no_delete',
      'sales_invoice_lines_no_truncate',
    ],
  },
  customer_receipts: {
    columns: [
      ...MANDATORY,
      'customer_id',
      'status',
      'number',
      'receipt_date',
      'method',
      'amount',
      'reference',
      'narration',
      'proposals_revision',
      'posted_at',
      'posted_by',
      'post_idempotency_key',
      'post_fingerprint',
      'reversed_at',
      'reversed_by',
      'reversal_reason',
      'reverse_idempotency_key',
      'reverse_fingerprint',
      'cancelled_at',
      'cancelled_by',
      'create_idempotency_key',
      'create_fingerprint',
    ].sort(),
    insert: [
      'tenant_id',
      'customer_id',
      'status',
      'receipt_date',
      'method',
      'amount',
      'reference',
      'narration',
      'proposals_revision',
      'create_idempotency_key',
      'create_fingerprint',
      'created_by',
      'updated_by',
    ],
    update: [
      'customer_id',
      'status',
      'number',
      'receipt_date',
      'method',
      'amount',
      'reference',
      'narration',
      'proposals_revision',
      'posted_at',
      'posted_by',
      'reversed_at',
      'reversed_by',
      'reversal_reason',
      'cancelled_at',
      'cancelled_by',
      'post_idempotency_key',
      'post_fingerprint',
      'reverse_idempotency_key',
      'reverse_fingerprint',
      'updated_by',
      'version',
    ],
    requiredTriggers: ['customer_receipts_set_updated_at', 'customer_receipts_enforce_transition'],
  },
  // Insert-only proposals (modules.md §6-§7): no UPDATE grant.
  customer_receipt_draft_allocations: {
    columns: [...MANDATORY, 'receipt_id', 'revision', 'invoice_id', 'amount'].sort(),
    insert: [
      'tenant_id',
      'receipt_id',
      'revision',
      'invoice_id',
      'amount',
      'created_by',
      'updated_by',
    ],
    update: [],
    requiredTriggers: [
      'customer_receipt_draft_allocations_enforce_revision',
      'customer_receipt_draft_allocations_no_update',
      'customer_receipt_draft_allocations_no_delete',
      'customer_receipt_draft_allocations_no_truncate',
    ],
  },
  // LIVE -> VOIDED is the one legitimate UPDATE (modules.md §5-§6); DELETE
  // and TRUNCATE are still forbidden for every role (rule 4).
  customer_receipt_allocations: {
    columns: [
      ...MANDATORY,
      'receipt_id',
      'invoice_id',
      'amount',
      'status',
      'voided_at',
      'voided_by',
    ].sort(),
    insert: [
      'tenant_id',
      'receipt_id',
      'invoice_id',
      'amount',
      'status',
      'created_by',
      'updated_by',
    ],
    update: ['status', 'voided_at', 'voided_by', 'updated_by', 'version'],
    requiredTriggers: [
      'customer_receipt_allocations_set_updated_at',
      'customer_receipt_allocations_enforce_transition',
      'customer_receipt_allocations_no_delete',
      'customer_receipt_allocations_no_truncate',
      'customer_receipt_allocations_check_sum',
    ],
  },
}

describe('exact-set ACL on the receivables tables (migrations 016-017)', () => {
  for (const table of TABLES) {
    const spec = EXPECTED[table]

    it(`${table}: has exactly the migration's column set`, async () => {
      expect((await columnsOf(table)).sort()).toEqual(spec.columns)
    })

    it(`${table}: finsoft_app may INSERT exactly the DEFAULT-excluded columns`, async () => {
      const actual = await columnPrivilegeSet('finsoft_app', table, 'INSERT')
      expect([...actual].sort()).toEqual([...spec.insert].sort())
      for (const forbidden of ['id', 'created_at', 'updated_at', 'version']) {
        expect(actual.has(forbidden), `${table}.${forbidden} must not be INSERT-able`).toBe(false)
      }
    })

    it(`${table}: finsoft_app may UPDATE exactly the mutable columns (S-A)`, async () => {
      const actual = await columnPrivilegeSet('finsoft_app', table, 'UPDATE')
      expect([...actual].sort()).toEqual([...spec.update].sort())
    })

    it(`${table}: finsoft_app may SELECT every column`, async () => {
      const select = await columnPrivilegeSet('finsoft_app', table, 'SELECT')
      expect([...select].sort()).toEqual(spec.columns)
    })

    it(`${table}: finsoft_app holds no table-level DELETE or TRUNCATE (rule 4)`, async () => {
      for (const priv of ['DELETE', 'TRUNCATE']) {
        const granted = await withGlobal((tx) =>
          scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
            'finsoft_app',
            table,
            priv,
          ]),
        )
        expect(granted, `finsoft_app ${priv} on ${table}`).toBe(false)
      }
    })

    it(`${table}: readonly_support may SELECT every column and nothing else`, async () => {
      const select = await columnPrivilegeSet('readonly_support', table, 'SELECT')
      expect([...select].sort()).toEqual(spec.columns)

      for (const priv of ['INSERT', 'UPDATE']) {
        const set = await columnPrivilegeSet('readonly_support', table, priv)
        expect([...set], `readonly_support ${priv} on ${table}`).toEqual([])
      }

      const del = await withGlobal((tx) =>
        scalarOn<boolean>(tx, 'select has_table_privilege($1, $2, $3)', [
          'readonly_support',
          table,
          'DELETE',
        ]),
      )
      expect(del).toBe(false)
    })

    it(`${table}: PUBLIC holds no column-level grant at all`, async () => {
      expect(await publicColumnGrants(table)).toEqual([])
    })

    it(`${table}: the table-level ACL grants finsoft_app and readonly_support SELECT only, nothing to PUBLIC`, async () => {
      const acl = await tableAcl(table)
      expect(grantsOf(acl, 'finsoft_app')).toEqual(['SELECT'])
      expect(grantsOf(acl, 'readonly_support')).toEqual(['SELECT'])
      expect(grantsOf(acl, 'PUBLIC')).toEqual([])
    })

    it(`${table}: carries every required trigger, ENABLED ('O')`, async () => {
      const triggers = await enabledTriggers(table)
      for (const name of spec.requiredTriggers) {
        expect(triggers.get(name), `${table}: ${name} is missing`).toBeDefined()
        expect(triggers.get(name), `${table}: ${name} is not enabled ('O')`).toBe('O')
      }
    })
  }

  it('the three purely insert-only tables have no legitimate UPDATE path at all — grants and triggers agree', () => {
    for (const table of ['sales_invoice_lines', 'customer_receipt_draft_allocations'] as const) {
      expect(EXPECTED[table].update).toEqual([])
      expect(EXPECTED[table].requiredTriggers).toContain(`${table}_no_update`)
    }
  })
})
