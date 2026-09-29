import { withGlobal } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * EXACT-SET ACL on the accounting-core tables, migrations 010-013 (DB-C4's
 * shape, copied from rbac.spec.ts so the two read identically).
 *
 * This file exists because the first draft of 010-013 revoked only UPDATE,
 * never INSERT. ALTER DEFAULT PRIVILEGES hands every new table TABLE-level
 * INSERT, which silently makes every column-scoped INSERT grant decorative —
 * finsoft_app could have inserted a journal entry born status = 'REVERSED',
 * or chosen its own created_at and defeated the line gate. "A privilege
 * statement's success is not evidence that it did anything" (migration 005):
 * the literal set PostgreSQL reports is asserted, column by column.
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

/** PUBLIC's exact column-level ACL, from pg_attribute.attacl. */
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
  'accounts',
  'fiscal_periods',
  'parties',
  'journal_entries',
  'journal_lines',
  'document_sequences',
] as const

const EXPECTED: Record<
  (typeof TABLES)[number],
  { columns: string[]; insert: string[]; update: string[] }
> = {
  // 010: INSERT for provisioning's seed, no UPDATE at all in the MVP.
  accounts: {
    columns: [
      ...MANDATORY,
      'code',
      'name',
      'type',
      'normal_balance',
      'kind',
      'control_kind',
      'role',
      'restricted',
      'parent_id',
      'is_active',
    ].sort(),
    insert: [
      'tenant_id',
      'code',
      'name',
      'type',
      'normal_balance',
      'kind',
      'control_kind',
      'role',
      'restricted',
      'parent_id',
      'is_active',
      'created_by',
      'updated_by',
    ],
    update: [],
  },
  // 011: created OPEN (status not insertable), transitions write stamps only.
  fiscal_periods: {
    columns: [
      ...MANDATORY,
      'fiscal_year',
      'period_index',
      'period_start',
      'period_end',
      'label',
      'status',
      'closed_at',
      'closed_by',
      'reopened_at',
      'reopened_by',
      'reopen_reason',
      'locked_at',
      'locked_by',
    ].sort(),
    insert: [
      'tenant_id',
      'fiscal_year',
      'period_index',
      'period_start',
      'period_end',
      'label',
      'created_by',
      'updated_by',
    ],
    update: [
      'status',
      'closed_at',
      'closed_by',
      'reopened_at',
      'reopened_by',
      'reopen_reason',
      'locked_at',
      'locked_by',
      'updated_at',
      'updated_by',
      'version',
    ],
  },
  // 012 / ADR-0026 statement 1: INSERT-only, id is the database's.
  parties: {
    columns: [...MANDATORY, 'party_type'].sort(),
    insert: ['tenant_id', 'party_type', 'created_by', 'updated_by'],
    update: [],
  },
  // 012: born POSTED (status not insertable); UPDATE is the reversal transition only.
  journal_entries: {
    columns: [
      ...MANDATORY,
      'entry_number',
      'posting_rule',
      'event',
      'occurred_at',
      'fiscal_period_id',
      'status',
      'narration',
      'reference',
      'source_type',
      'source_id',
      'idempotency_key',
      'request_fingerprint',
      'reversal_of',
      'reversal_reason',
      'reversed_by',
      'reversed_at',
    ].sort(),
    insert: [
      'tenant_id',
      'entry_number',
      'posting_rule',
      'event',
      'occurred_at',
      'fiscal_period_id',
      'narration',
      'reference',
      'source_type',
      'source_id',
      'idempotency_key',
      'request_fingerprint',
      'reversal_of',
      'reversal_reason',
      'created_by',
      'updated_by',
    ],
    update: ['status', 'reversed_by', 'reversed_at', 'updated_at', 'updated_by', 'version'],
  },
  // 012: INSERT only, ever.
  journal_lines: {
    columns: [
      ...MANDATORY,
      'entry_id',
      'line_number',
      'account_id',
      'account_control',
      'debit',
      'credit',
      'party_type',
      'party_id',
      'memo',
    ].sort(),
    insert: [
      'tenant_id',
      'entry_id',
      'line_number',
      'account_id',
      'account_control',
      'debit',
      'credit',
      'party_type',
      'party_id',
      'memo',
      'created_by',
      'updated_by',
    ],
    update: [],
  },
  // 013 / K7: the counter itself is not insertable (born 1), only advanced.
  document_sequences: {
    columns: [...MANDATORY, 'series', 'scope', 'fiscal_year', 'last_number'].sort(),
    insert: ['tenant_id', 'series', 'scope', 'fiscal_year', 'created_by', 'updated_by'],
    update: ['last_number', 'updated_at', 'updated_by', 'version'],
  },
}

describe('exact-set ACL on the accounting-core tables (migrations 010-013)', () => {
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
      if (spec.columns.includes('status')) {
        expect(actual.has('status'), `${table}.status must not be INSERT-able`).toBe(false)
      }
    })

    it(`${table}: finsoft_app may UPDATE exactly the mutable columns`, async () => {
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
  }
})
