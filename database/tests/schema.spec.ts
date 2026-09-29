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

/*
 * Unique indexes on tenant-owned tables that may omit `tenant_id`. ADR-0021.
 *
 * ADR-0003:28 reads without qualification: "Every unique constraint on
 * tenant-owned data is scoped by tenant." ADR-0021 supersedes that bullet,
 * and bullet 110, for a deliberately narrow class — and this list is the
 * whole class.
 *
 * THE REASON THE RULE IS TIGHT IS NOT THE ONE THE OLD COMMENT HERE GAVE.
 * That comment justified tenant-scoping as "one tenant's data constrains
 * another's" — a tenant choosing an email or a code and being refused because
 * a neighbour took it. That is the lesser harm. The larger one is that
 * UNIQUE INDEX ENFORCEMENT IS NOT SUBJECT TO ROW LEVEL SECURITY. PostgreSQL
 * checks the index across rows the current role cannot SELECT, so a globally
 * unique index is a hole through ADR-0004's backstop. Measured on this
 * schema, as finsoft_app under RLS in tenant A against a hash held only by
 * tenant B:
 *
 *   SELECT ... WHERE token_hash = <B's hash>   ->  0 rows
 *   INSERT ... token_hash = <B's hash>         ->  23505
 *
 * A 23505 is therefore a cross-tenant existence oracle, and one tenant's row
 * can fail another tenant's insert.
 *
 * ADR-0021's gate is NECESSITY, not provenance: the uniqueness must be relied
 * on by a lookup that runs BEFORE a tenant context exists, so that a scoped
 * constraint would be unenforceable at the moment its guarantee is needed.
 * "The value is system-generated" is explicitly NOT a criterion — it
 * describes how a value is produced, not why scoping cannot work, and every
 * column with a DEFAULT satisfies it.
 *
 * Adding a name to this list is an Architecture Guardian and Database
 * Guardian decision recorded in an ADR, not a fix for a red test.
 */
interface GloballyUniqueExemption {
  readonly index: string
  readonly table: string
  /** The ADR that admits it. */
  readonly adr: string
  readonly why: string
}

const GLOBALLY_UNIQUE_INDEX_ALLOWLIST: readonly GloballyUniqueExemption[] = [
  {
    index: 'rt_token_hash_key',
    table: 'refresh_tokens',
    adr: 'ADR-0021',
    why:
      'A refresh token is presented as a bare cookie value with no tenant context — establishing the tenant IS the lookup. ' +
      'Under (tenant_id, token_hash) the same hash could legitimately exist in two tenants, so the lookup would have to ' +
      'tolerate several rows and pick one, in response to an unauthenticated request. Picking wrong spends the wrong ' +
      "tenant's token or revokes the wrong tenant's family: a cross-tenant write, rule 8.",
  },
]

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

/**
 * Tables exempt from the mandatory column set. ADR-0020 Compliance: "The
 * mandatory column set — audit_log is exempt."
 *
 * `occurred_at` and `actor_user_id` already carry when/by-whom as HASHED
 * columns, so `created_at`/`created_by` would duplicate them unhashed.
 * `updated_at`/`updated_by`/`version` describe an UPDATE this table can never
 * have (it is append-only, enforced by grants and a trigger rejecting
 * UPDATE/DELETE for every role) — there is no optimistic lock and no last
 * writer to record. Including any of the five, unhashed, on the one table
 * whose entire purpose is that its contents cannot change without detection
 * would be exactly backwards.
 *
 * Adding a name to this list is a Database Guardian decision, not a fix.
 */
const MANDATORY_COLUMN_SET_ALLOWLIST = new Set(['audit_log'])

/**
 * Tables owned by the kernels (ARCHITECTURE §5: kernels know nothing about
 * feature modules). ADR-0026 statement 4: module tables reference kernel
 * tables — `customers.id` -> `parties.id` — never the reverse. A kernel
 * table with a foreign key into a module table would make the kernel's
 * schema depend on a module's, the dependency direction dependency-cruiser
 * forbids in TypeScript, reintroduced one layer down where nothing checks it.
 *
 * Adding a table here is an Architecture Guardian and Database Guardian
 * decision — it is a claim that the table belongs to a kernel.
 */
const KERNEL_TABLES = new Set([
  'accounts',
  'fiscal_periods',
  'parties',
  'journal_entries',
  'journal_lines',
  'document_sequences',
])

/** Platform tables every tenant-owned table may reference: the tenant and the author. */
const PLATFORM_TABLES = new Set(['tenants', 'users'])

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
      if (MANDATORY_COLUMN_SET_ALLOWLIST.has(table)) continue
      const present = new Set(all.filter((c) => c.table_name === table).map((c) => c.column_name))
      const missing = MANDATORY_COLUMNS.filter((column) => !present.has(column))
      expect(missing, `${table} is missing IMPLEMENTATION §11 columns`).toEqual([])
    }
  })

  it('carries no stale entry in MANDATORY_COLUMN_SET_ALLOWLIST', async () => {
    // Same discipline as GLOBALLY_UNIQUE_INDEX_ALLOWLIST below: an exemption
    // must not outlive the table it names.
    const names = new Set((await tables()).map((t) => t.table_name))
    for (const table of MANDATORY_COLUMN_SET_ALLOWLIST) {
      expect(
        names.has(table),
        `MANDATORY_COLUMN_SET_ALLOWLIST names "${table}", which does not exist`,
      ).toBe(true)
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
       * The surrogate primary key is exempt. ADR-0021 §1 — the exemption
       * lives there now rather than in this comment, which is the point:
       * a LEVEL 1 rule whose only carve-out was documented in a test file
       * was a rule whose meaning was set by whoever last edited the test.
       */
      if (index.is_primary) continue

      const exemption = GLOBALLY_UNIQUE_INDEX_ALLOWLIST.find(
        (e) => e.index === index.index_name && e.table === index.table_name,
      )
      if (exemption) continue

      expect(
        index.first_column,
        `${index.index_name} on ${index.table_name} is unique but does not lead with tenant_id: ` +
          `${index.definition}. A unique index on tenant-owned data that omits tenant_id is a hole ` +
          `through RLS — enforcement is not subject to row security, so a 23505 is a cross-tenant ` +
          `existence oracle. If this is genuinely necessary, it needs an ADR and an entry in ` +
          `GLOBALLY_UNIQUE_INDEX_ALLOWLIST, not a change to this assertion.`,
      ).toBe('tenant_id')
    }
  })

  it('carries no stale entry in GLOBALLY_UNIQUE_INDEX_ALLOWLIST', async () => {
    /*
     * ADR-0021 condition 4. An exemption that outlives the index it names is
     * how the next table inherits a carve-out nobody argued for: someone
     * copies the pattern, the allowlist already contains a plausible-looking
     * name, and the gate stays green. Failing on a stale entry makes the
     * exemption expire with its index.
     */
    const live = new Set((await indexes()).map((i) => `${i.table_name}.${i.index_name}`))

    for (const e of GLOBALLY_UNIQUE_INDEX_ALLOWLIST) {
      expect(
        live.has(`${e.table}.${e.index}`),
        `GLOBALLY_UNIQUE_INDEX_ALLOWLIST names ${e.table}.${e.index} (${e.adr}), which does not ` +
          `exist in the database. Remove the entry — an exemption must not outlive its index.`,
      ).toBe(true)
    }
  })

  it('a kernel-owned table references only kernel or platform tables (ADR-0026 §4)', async () => {
    const offenders = (await constraints())
      .filter((c) => c.contype === 'f' && KERNEL_TABLES.has(c.table_name))
      .filter(
        (c) =>
          c.referenced_table === null ||
          !(KERNEL_TABLES.has(c.referenced_table) || PLATFORM_TABLES.has(c.referenced_table)),
      )
      .map((c) => `${c.table_name}.${c.constraint_name} -> ${String(c.referenced_table)}`)

    expect(
      offenders,
      'a kernel table has a foreign key into a non-kernel, non-platform table. Module tables ' +
        'reference kernel tables (customers.id -> parties.id), never the reverse (ADR-0026).',
    ).toEqual([])
  })

  it('carries no stale entry in KERNEL_TABLES', async () => {
    const names = new Set((await tables()).map((t) => t.table_name))
    for (const table of KERNEL_TABLES) {
      expect(names.has(table), `KERNEL_TABLES names "${table}", which does not exist`).toBe(true)
    }
  })

  it('makes every foreign key from a tenant table to a tenant table composite on tenant_id (S3, ADR-0028)', async () => {
    // PostgreSQL foreign-key checks run with row security OFF (ADR-0026's
    // own reasoning, generalised): a single-column reference from one
    // tenant-owned table to another would let tenant B insert a row
    // pointing at tenant A's, and would tell B whether that id exists —
    // both a tenant boundary break and a cross-tenant existence oracle.
    // Only a composite key carrying tenant_id on BOTH sides closes it.
    const all = await constraints()
    const tenantOwned = new Set(
      (await columns())
        .filter((c) => c.column_name === 'tenant_id' && !isGlobalTable(c.table_name))
        .map((c) => c.table_name),
    )

    // S3 (Security seat, Council review, 2026-09-29): checks BOTH sides.
    // The original check only proved the REFERENCING column list leads with
    // tenant_id; a FOREIGN KEY (tenant_id, x) REFERENCES t (id, y) — with a
    // composite LOCAL key but a single-column, non-tenant-leading REFERENCED
    // key — would still pass it while being exactly the same RLS-blind
    // existence oracle it exists to catch, one side over.
    const offenders = all
      .filter((c) => c.contype === 'f')
      .filter((c) => c.referenced_table !== null && c.referenced_table !== 'tenants')
      .filter((c) => tenantOwned.has(c.table_name) && tenantOwned.has(c.referenced_table as string))
      .filter(
        (c) =>
          !/^FOREIGN KEY \(tenant_id,[^)]*\)\s+REFERENCES\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?\(tenant_id,/i.test(
            c.definition,
          ),
      )
      .map(
        (c) =>
          `${c.table_name}.${c.constraint_name} -> ${String(c.referenced_table)}: ${c.definition}`,
      )

    expect(
      offenders,
      'a tenant-to-tenant foreign key is not composite on tenant_id, leading, on BOTH the ' +
        'referencing AND the referenced column list. A single-column reference on either side ' +
        'bypasses RLS at the referential-integrity check (S3, ADR-0028).',
    ).toEqual([])
  })

  it('S3 fixture: a composite local key against a non-tenant-leading referenced key is still an offender', () => {
    // Pure regex check, mirroring the live query above — proves the fix
    // actually inspects the REFERENCES side, not only the FOREIGN KEY side.
    const re =
      /^FOREIGN KEY \(tenant_id,[^)]*\)\s+REFERENCES\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?\(tenant_id,/i
    expect(re.test('FOREIGN KEY (tenant_id, x) REFERENCES t(id, y)')).toBe(false)
    expect(re.test('FOREIGN KEY (tenant_id, x) REFERENCES t(tenant_id, y)')).toBe(true)
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
