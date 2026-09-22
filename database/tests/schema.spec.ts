import { GLOBAL_TABLES, isGlobalTable } from '@finsoft/database'
import { prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { columns, constraints, indexes, tables } from './catalog.ts'

/*
 * Schema assertions over the live, migrated database. ADR-0003, ADR-0011,
 * IMPLEMENTATION §11, NON_NEGOTIABLES rules 4, 6 and 7.
 *
 * These run against whatever `database/migrations/` actually produced, not
 * against a description of it. Every assertion is written so that the *next*
 * table to be added is covered without anyone editing this file — a rule that
 * only checks `users` would pass forever while the table it should have
 * caught was merged.
 */

/**
 * Tables permitted to have a nullable `created_by` / `updated_by`.
 *
 * `users` is the root of the authorship graph: the first user of a tenant is
 * written by provisioning, when no user of that tenant exists to be named as
 * its author (see the comment block in 002_create_users.sql). The exception
 * is bounded in the schema — at most one such row per tenant — and bounded
 * here, so that a later table which copies `users` as a template and inherits
 * the nullability fails this test instead of quietly shipping anonymous rows.
 *
 * Adding a name to this list is a Database Guardian decision, not a fix.
 */
const NULLABLE_AUTHORSHIP_ALLOWLIST = new Set(['users'])

/** Columns IMPLEMENTATION §11 requires on every tenant-owned table. */
const MANDATORY_COLUMNS = [
  'id',
  'tenant_id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'version',
]

describe('schema', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  it('has applied both migrations, so there is something to assert against', async () => {
    const names = (await tables()).map((t) => t.table_name)
    expect(names).toContain('tenants')
    expect(names).toContain('users')
  })

  it('gives every table a primary key', async () => {
    const without = (await tables()).filter((t) => !t.has_primary_key).map((t) => t.table_name)
    expect(without, 'tables with no primary key').toEqual([])
  })

  it('puts every non-global table under the tenant discriminator (rule 7)', async () => {
    const all = await tables()
    const withTenantColumn = new Set(
      (await columns()).filter((c) => c.column_name === 'tenant_id').map((c) => c.table_name),
    )

    const unaccounted = all
      .map((t) => t.table_name)
      .filter((name) => !isGlobalTable(name) && !withTenantColumn.has(name))

    expect(
      unaccounted,
      `tables with neither a tenant_id nor a place on the global allowlist ` +
        `(${GLOBAL_TABLES.join(', ')}). A new table is tenant-owned unless a reviewed ` +
        `decision says otherwise — ADR-0003:30.`,
    ).toEqual([])
  })

  it('keeps the global allowlist honest: an allowlisted table has no tenant_id', async () => {
    const offenders = (await columns())
      .filter((c) => c.column_name === 'tenant_id' && isGlobalTable(c.table_name))
      .map((c) => c.table_name)

    expect(
      offenders,
      'a table on the global allowlist carries tenant_id. It is tenant-owned and the ' +
        'allowlist in packages/database/src/schema.ts is wrong — which means RLS is not ' +
        'being asserted on it.',
    ).toEqual([])
  })

  it('declares tenant_id as uuid NOT NULL', async () => {
    const tenantColumns = (await columns()).filter(
      (c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name),
    )
    expect(tenantColumns.length).toBeGreaterThan(0)

    for (const column of tenantColumns) {
      expect(column.data_type, `${column.table_name}.tenant_id type`).toBe('uuid')
      expect(column.not_null, `${column.table_name}.tenant_id NOT NULL`).toBe(true)
    }
  })

  it('foreign-keys tenant_id to tenants(id)', async () => {
    const all = await constraints()
    const tenantOwned = new Set(
      (await columns())
        .filter((c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name))
        .map((c) => c.table_name),
    )

    for (const table of tenantOwned) {
      const fk = all.find(
        (c) =>
          c.table_name === table &&
          c.contype === 'f' &&
          c.referenced_table === 'tenants' &&
          /FOREIGN KEY \(tenant_id\)/.test(c.definition),
      )
      expect(fk, `${table} has no FOREIGN KEY (tenant_id) REFERENCES tenants(id)`).toBeDefined()
    }
  })

  it('carries the mandatory column set on every tenant-owned table', async () => {
    const all = await columns()
    const tenantOwned = [
      ...new Set(
        all
          .filter((c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name))
          .map((c) => c.table_name),
      ),
    ]

    for (const table of tenantOwned) {
      const present = new Set(all.filter((c) => c.table_name === table).map((c) => c.column_name))
      const missing = MANDATORY_COLUMNS.filter((column) => !present.has(column))
      expect(missing, `${table} is missing IMPLEMENTATION §11 columns`).toEqual([])
    }
  })

  it('requires authorship, except on the allowlisted root of the user graph', async () => {
    const authorship = (await columns()).filter(
      (c) =>
        (c.column_name === 'created_by' || c.column_name === 'updated_by') &&
        !isGlobalTable(c.table_name),
    )

    for (const column of authorship) {
      if (NULLABLE_AUTHORSHIP_ALLOWLIST.has(column.table_name)) {
        expect(
          column.not_null,
          `${column.table_name}.${column.column_name} is allowlisted as nullable but is NOT NULL — ` +
            'remove it from NULLABLE_AUTHORSHIP_ALLOWLIST.',
        ).toBe(false)
        continue
      }
      expect(
        column.not_null,
        `${column.table_name}.${column.column_name} is nullable. Rule 9: every mutation has an ` +
          'author. If this table genuinely has rows nobody created, that needs a Database ' +
          'Guardian decision and an entry in NULLABLE_AUTHORSHIP_ALLOWLIST — not a nullable column.',
      ).toBe(true)
    }
  })

  it('leads the primary access path with tenant_id (ADR-0003:27)', async () => {
    const all = await indexes()
    const tenantOwned = [
      ...new Set(
        (await columns())
          .filter((c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name))
          .map((c) => c.table_name),
      ),
    ]

    for (const table of tenantOwned) {
      const leading = all.filter((i) => i.table_name === table && i.first_column === 'tenant_id')
      expect(
        leading.length,
        `${table} has no index whose FIRST column is tenant_id. A trailing tenant_id gives the ` +
          `planner no way to read one tenant's rows without reading the others'. Indexes found: ` +
          all
            .filter((i) => i.table_name === table)
            .map((i) => i.definition)
            .join(' | '),
      ).toBeGreaterThan(0)
    }
  })

  it('scopes every unique constraint on tenant-owned data by tenant (ADR-0003:28)', async () => {
    const all = await indexes()
    const tenantOwned = new Set(
      (await columns())
        .filter((c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name))
        .map((c) => c.table_name),
    )

    for (const index of all) {
      if (!tenantOwned.has(index.table_name)) continue
      if (!index.is_unique) continue

      /*
       * The primary key is exempt and only the primary key. `id` is a uuid
       * and globally unique by construction, so it cannot collide across
       * tenants; every *business* uniqueness rule — an email, a document
       * number, a code — must be scoped, or one tenant's data constrains
       * another's.
       */
      if (index.is_primary) continue

      expect(
        index.first_column,
        `${index.index_name} on ${index.table_name} is unique but does not lead with tenant_id: ` +
          `${index.definition}`,
      ).toBe('tenant_id')
    }
  })

  it('never uses ON DELETE CASCADE, and always RESTRICT (rule 4)', async () => {
    const foreignKeys = (await constraints()).filter((c) => c.contype === 'f')
    expect(foreignKeys.length).toBeGreaterThan(0)

    for (const fk of foreignKeys) {
      expect(
        fk.on_delete,
        `${fk.constraint_name} on ${fk.table_name} has ON DELETE ` +
          `'${String(fk.on_delete)}' (a=NO ACTION r=RESTRICT c=CASCADE n=SET NULL d=SET DEFAULT). ` +
          'Rule 4: CASCADE is forbidden on any financial relationship and RESTRICT is the ' +
          'required action — a deletion that silently takes rows with it is the failure mode ' +
          'no-hard-delete exists to prevent. Definition: ' +
          fk.definition,
      ).toBe('r')
    }
  })

  it('has no floating-point or money column anywhere (rule 6)', async () => {
    const forbidden = /^(real|double precision|money|float)/
    const offenders = (await columns())
      .filter((c) => forbidden.test(c.data_type))
      .map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`)

    expect(
      offenders,
      'Rule 6 / ADR-0011: amounts are numeric(19,4), unit costs, rates and quantities are ' +
        'numeric(19,6). float, double precision, real and money are forbidden everywhere in the ' +
        'schema — money included, because its behaviour depends on a server locale setting.',
    ).toEqual([])
  })

  it('constrains every status column to a known set (IMPLEMENTATION §11)', async () => {
    const statusColumns = (await columns()).filter((c) => c.column_name === 'status')
    expect(statusColumns.length).toBeGreaterThan(0)

    const checks = (await constraints()).filter((c) => c.contype === 'c')

    for (const column of statusColumns) {
      const guarded = checks.some(
        (c) => c.table_name === column.table_name && /\bstatus\b/.test(c.definition),
      )
      expect(
        guarded,
        `${column.table_name}.status has no CHECK constraint. A varchar status with no check is ` +
          'a column that will eventually hold a typo, and every report that filters on it will ' +
          'silently miss those rows.',
      ).toBe(true)
      expect(column.not_null, `${column.table_name}.status NOT NULL`).toBe(true)
    }
  })

  it('defaults the optimistic-lock version to 0 on every tenant-owned table', async () => {
    /*
     * Tenant-owned tables only. `schema_migrations.version` is the migration
     * number — same word, different concept, no default and no optimistic
     * locking. Scoping by the global allowlist keeps the two apart without
     * naming either table.
     */
    const versions = (await columns()).filter(
      (c) => c.column_name === 'version' && !isGlobalTable(c.table_name),
    )
    expect(versions.length).toBeGreaterThan(0)

    for (const column of versions) {
      expect(column.not_null, `${column.table_name}.version NOT NULL`).toBe(true)
      expect(column.has_default, `${column.table_name}.version has a default`).toBe(true)
      expect(column.data_type, `${column.table_name}.version type`).toBe('integer')
    }
  })

  it('never generates an id from a sequence the application can guess (rule 12)', async () => {
    /*
     * Identifiers are uuid, not serial. This is not about aesthetics: a
     * sequential integer key invites MAX(id)+1 as the "obvious" way to get
     * the next document number, which rule 12 forbids because it produces
     * duplicates under concurrency. Making the id a uuid removes the
     * temptation before the numbering table exists.
     */
    const ids = (await columns()).filter((c) => c.column_name === 'id')
    expect(ids.length).toBeGreaterThan(0)

    for (const column of ids) {
      if (column.table_name === 'schema_migrations') continue
      expect(
        column.data_type,
        `${column.table_name}.id is ${column.data_type}. Rule 12: document numbers and keys ` +
          'come from the server, never from MAX(id)+1.',
      ).toBe('uuid')
    }
  })
})
