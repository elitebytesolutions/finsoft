import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'

/*
 * C10 (ADR-0028): every module migration (015 on, M3-C's own renumbering —
 * see 015_create_customers.sql's own header) carries an `-- Owner:` header,
 * and every ALTER TABLE, CREATE TRIGGER … ON, CREATE POLICY … ON,
 * CREATE INDEX … ON and GRANT … ON targets a table that a migration with
 * the SAME owner created.
 *
 * S4: also rejects outright, in a module migration: ALTER POLICY, DROP,
 * CREATE RULE, REVOKE, ALTER … OWNER, CREATE FUNCTION … SECURITY DEFINER,
 * CREATE VIEW without security_invoker = true, ALTER DEFAULT PRIVILEGES,
 * ALTER ROLE, SET ROLE, and DISABLE/NO FORCE ROW LEVEL SECURITY.
 *
 * This is a TEXT check over database/migrations/*.sql — ESLint does not
 * read SQL (eslint.config.mjs's own repeated note), and dependency-cruiser
 * only sees the TypeScript module graph, so ownership has to be its own
 * gate. A regex-based extraction, not a full SQL parser, matching the
 * pragmatic style eslint.config.mjs already uses for journalWriteSyntax /
 * partiesWriteSyntax (a keyword + identifier pattern) rather than a new
 * dependency on a SQL grammar.
 */

const MIGRATIONS_DIR = join(REPO_ROOT, 'database/migrations')

/** M3-C's renumbering (015_create_customers.sql's own header) — C10 applies from here on. */
const FIRST_MODULE_MIGRATION = 15

function migrationNumber(filename: string): number {
  const match = /^(\d+)_/.exec(filename)
  if (!match) throw new Error(`migration filename "${filename}" has no leading number`)
  return Number(match[1])
}

/** C10: "quoted and schema-qualified names are normalised before matching." */
export function normalizeIdentifier(raw: string): string {
  return raw.replace(/^"|"$/g, '').replace(/^public\./i, '')
}

export function ownerOf(sql: string): string | null {
  const match = /^--\s*Owner:\s*(modules\/[a-zA-Z0-9_-]+)\s*$/m.exec(sql)
  return match?.[1] ?? null
}

export function tablesCreatedBy(sql: string): string[] {
  const names: string[] = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(sql))) names.push(normalizeIdentifier(match[1] as string))
  return names
}

export interface TargetedConstruct {
  readonly kind: string
  readonly table: string
}

/** ALTER TABLE, CREATE TRIGGER … ON, CREATE POLICY … ON, CREATE INDEX … ON. GRANT/REVOKE are checked separately, below, fail-closed. */
export function targetedConstructs(sql: string): TargetedConstruct[] {
  const out: TargetedConstruct[] = []
  const patterns: readonly [string, RegExp][] = [
    ['ALTER TABLE', /ALTER\s+TABLE\s+(?:ONLY\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi],
    [
      'CREATE TRIGGER',
      /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+\S+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+[\w\s,]+?\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gis,
    ],
    ['CREATE POLICY', /CREATE\s+POLICY\s+\S+\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi],
    [
      'CREATE INDEX',
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?\S+\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi,
    ],
  ]
  for (const [kind, re] of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(sql)))
      out.push({ kind, table: normalizeIdentifier(match[1] as string) })
  }
  return out
}

/*
 * S-GRANT (Security seat, Council review): GRANT/REVOKE were previously
 * checked with the SAME lenient "keyword ... ON <ident> ... TO|FROM"
 * pattern as ALTER TABLE/CREATE TRIGGER/CREATE POLICY/CREATE INDEX above —
 * which means any statement shaped differently than that one pattern
 * silently matched NOTHING and was never checked at all: a role-membership
 * grant with no ON clause (`GRANT finsoft_migration TO finsoft_app`), a
 * schema-wide grant (`GRANT UPDATE ON ALL TABLES IN SCHEMA public TO x`),
 * the `TABLE`/`SEQUENCE` keyword before the identifier
 * (`GRANT SELECT ON TABLE parties TO x`), a schema-qualified name the old
 * regex could not see because it does not allow a dot
 * (`GRANT ... ON public.parties`), a multi-role REVOKE
 * (`REVOKE ... FROM a, b`), `FROM PUBLIC CASCADE`, and any GRANT/REVOKE on a
 * table this migration does not own — every one of these passed silently.
 *
 * This is the fail-closed replacement: split into statements, and every
 * statement containing the word GRANT or REVOKE must match one of a SMALL,
 * explicit set of allowed shapes, in full (`^...$`), or it is an offense —
 * an unrecognised GRANT/REVOKE shape is refused, not skipped. A shape that
 * DOES match still has its table checked against `ownedTables`.
 */

/** `--` and block comments stripped first, so prose mentioning GRANT/REVOKE cannot look like SQL. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Naive `;`-split — adequate here: no GRANT/REVOKE statement in this schema's migrations contains a semicolon inside a string or a dollar-quoted body. */
function splitStatements(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

const QUALIFIED_IDENT = '(?:public\\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?'
const GRANTEE_ROLE = '(?:finsoft_app|readonly_support)'
const COLUMN_LIST = '\\([^)]*\\)'

/**
 * Each shape is FULLY ANCHORED (`^...$`, case-insensitive, `s` flag so `.`
 * is never relied on but whitespace — including newlines in a wrapped
 * column list — matches `\s`) and captures the table name in group 1. A
 * statement that satisfies none of these is rejected outright, whatever it
 * says — this is the "fails closed" property S-GRANT asks for.
 */
const GRANT_SHAPES: readonly RegExp[] = [
  // GRANT SELECT ON <table> TO finsoft_app|readonly_support;
  new RegExp(`^GRANT\\s+SELECT\\s+ON\\s+(${QUALIFIED_IDENT})\\s+TO\\s+${GRANTEE_ROLE}$`, 'is'),
  // GRANT INSERT (<cols>) ON <table> TO finsoft_app;  (column-scoped, finsoft_app only)
  new RegExp(
    `^GRANT\\s+INSERT\\s+${COLUMN_LIST}\\s+ON\\s+(${QUALIFIED_IDENT})\\s+TO\\s+finsoft_app$`,
    'is',
  ),
  // GRANT UPDATE (<cols>) ON <table> TO finsoft_app;  (column-scoped, finsoft_app only)
  new RegExp(
    `^GRANT\\s+UPDATE\\s+${COLUMN_LIST}\\s+ON\\s+(${QUALIFIED_IDENT})\\s+TO\\s+finsoft_app$`,
    'is',
  ),
]

/** The one allowed REVOKE idiom — see this file's earlier header note on why it is not a blanket ban. */
const REVOKE_SHAPE = new RegExp(
  `^REVOKE\\s+INSERT\\s*,\\s*UPDATE\\s+ON\\s+(${QUALIFIED_IDENT})\\s+FROM\\s+finsoft_app$`,
  'is',
)

export function grantRevokeOffenses(sql: string, ownedTables: ReadonlySet<string>): string[] {
  const offenses: string[] = []

  for (const statement of splitStatements(sql)) {
    const isGrant = /\bGRANT\b/i.test(statement)
    const isRevoke = /\bREVOKE\b/i.test(statement)
    if (!isGrant && !isRevoke) continue

    const shapes = isGrant ? GRANT_SHAPES : [REVOKE_SHAPE]
    const match = shapes.map((re) => re.exec(statement)).find((m): m is RegExpExecArray => m !== null)

    if (!match) {
      offenses.push(`unrecognised ${isGrant ? 'GRANT' : 'REVOKE'} shape: ${statement}`)
      continue
    }

    const table = normalizeIdentifier(match[1] as string)
    if (!ownedTables.has(table)) {
      offenses.push(`${isGrant ? 'GRANT' : 'REVOKE'} on a table this migration's owner did not create ("${table}"): ${statement}`)
    }
  }

  return offenses
}

/** S4's outright-forbidden constructs. */
export const FORBIDDEN_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'ALTER POLICY', re: /\bALTER\s+POLICY\b/i },
  {
    name: 'DROP',
    re: /\bDROP\s+(TABLE|INDEX|TRIGGER|POLICY|FUNCTION|VIEW|SCHEMA|TYPE|COLUMN|CONSTRAINT|ROLE)\b/i,
  },
  { name: 'CREATE RULE', re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i },
  { name: 'ALTER ... OWNER', re: /\bOWNER\s+TO\b/i },
  { name: 'CREATE FUNCTION ... SECURITY DEFINER', re: /\bSECURITY\s+DEFINER\b/i },
  { name: 'ALTER DEFAULT PRIVILEGES', re: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i },
  { name: 'ALTER ROLE', re: /\bALTER\s+ROLE\b/i },
  { name: 'SET ROLE', re: /\bSET\s+ROLE\b/i },
  { name: 'DISABLE ROW LEVEL SECURITY', re: /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i },
  { name: 'NO FORCE ROW LEVEL SECURITY', re: /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i },
]

/** CREATE VIEW is allowed only WITH (security_invoker = true) — S4. */
export function viewsWithoutSecurityInvoker(sql: string): string[] {
  const names: string[] = []
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:\([^)]*\))?\s*(?:WITH\s*\(([^)]*)\))?\s+AS/gis
  let match: RegExpExecArray | null
  while ((match = re.exec(sql))) {
    const options = match[2] ?? ''
    if (!/security_invoker\s*=\s*true/i.test(options)) {
      names.push(normalizeIdentifier(match[1] as string))
    }
  }
  return names
}

function moduleMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .filter((f) => migrationNumber(f) >= FIRST_MODULE_MIGRATION)
    .sort()
}

function read(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
}

describe('migration ownership (C10, ADR-0028)', () => {
  const files = moduleMigrationFiles()

  it('finds at least one module migration to check (015 on)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)(
    '%s carries an "-- Owner: modules/<name>" header naming an existing directory',
    (file) => {
      const sql = read(file)
      const owner = ownerOf(sql)
      expect(owner, `${file} has no "-- Owner: modules/<name>" header`).not.toBeNull()
      expect(
        existsSync(join(REPO_ROOT, owner as string)),
        `${file}'s Owner (${String(owner)}) does not name an existing directory`,
      ).toBe(true)
    },
  )

  it('every targeted table belongs to a migration with the same owner', () => {
    const ownerTables = new Map<string, Set<string>>()
    for (const file of files) {
      const sql = read(file)
      const owner = ownerOf(sql)
      if (!owner) continue
      const set = ownerTables.get(owner) ?? new Set<string>()
      for (const table of tablesCreatedBy(sql)) set.add(table)
      ownerTables.set(owner, set)
    }

    const offenders: string[] = []
    for (const file of files) {
      const sql = read(file)
      const owner = ownerOf(sql)
      if (!owner) continue
      const allowed = ownerTables.get(owner) ?? new Set<string>()
      for (const construct of targetedConstructs(sql)) {
        if (!allowed.has(construct.table)) {
          offenders.push(`${file} (${owner}): ${construct.kind} on "${construct.table}"`)
        }
      }
    }

    expect(
      offenders,
      'a module migration targets a table it (or its owner) did not create',
    ).toEqual([])
  })

  it.each(files)("%s contains none of S4's outright-forbidden constructs", (file) => {
    const sql = read(file)
    const hits = FORBIDDEN_PATTERNS.filter((p) => p.re.test(sql)).map((p) => p.name)
    expect(hits, `${file} contains a forbidden construct`).toEqual([])
  })

  it.each(files)('%s: every GRANT/REVOKE matches an explicitly allowed shape (S-GRANT)', (file) => {
    const sql = read(file)
    const owned = new Set(tablesCreatedBy(sql))
    expect(
      grantRevokeOffenses(sql, owned),
      `${file} has a GRANT/REVOKE that does not match an allowed shape, or targets an unowned table`,
    ).toEqual([])
  })

  it.each(files)('%s creates no view without security_invoker = true', (file) => {
    expect(viewsWithoutSecurityInvoker(read(file))).toEqual([])
  })

  describe('the checker actually fires — one fixture per S4 construct', () => {
    const cases: readonly [string, string][] = [
      ['ALTER POLICY', 'ALTER POLICY tenant_isolation ON customers USING (true);'],
      ['DROP', 'DROP TABLE customers;'],
      ['CREATE RULE', 'CREATE RULE x AS ON INSERT TO customers DO NOTHING;'],
      ['ALTER ... OWNER', 'ALTER TABLE customers OWNER TO someone;'],
      [
        'CREATE FUNCTION ... SECURITY DEFINER',
        'CREATE FUNCTION f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
      ],
      [
        'ALTER DEFAULT PRIVILEGES',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO finsoft_app;',
      ],
      ['ALTER ROLE', 'ALTER ROLE finsoft_app WITH BYPASSRLS;'],
      ['SET ROLE', 'SET ROLE finsoft_migration;'],
      ['DISABLE ROW LEVEL SECURITY', 'ALTER TABLE customers DISABLE ROW LEVEL SECURITY;'],
      ['NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE customers NO FORCE ROW LEVEL SECURITY;'],
    ]

    it.each(cases)('%s is rejected', (name, fixture) => {
      const hits = FORBIDDEN_PATTERNS.filter((p) => p.re.test(fixture)).map((p) => p.name)
      expect(hits).toContain(name)
    })

    it('REVOKE SELECT (the wrong privilege list) is rejected even on an owned table', () => {
      const offenses = grantRevokeOffenses(
        'REVOKE SELECT ON customers FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toHaveLength(1)
    })

    it('REVOKE ... FROM a role other than finsoft_app is rejected', () => {
      const offenses = grantRevokeOffenses(
        'REVOKE INSERT, UPDATE ON customers FROM readonly_support;',
        new Set(['customers']),
      )
      expect(offenses).toHaveLength(1)
    })

    it('REVOKE ... ON a table this migration did not create is rejected', () => {
      const offenses = grantRevokeOffenses(
        'REVOKE INSERT, UPDATE ON parties FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toHaveLength(1)
    })

    it('the one allowed REVOKE idiom passes: INSERT, UPDATE ON an owned table FROM finsoft_app', () => {
      const offenses = grantRevokeOffenses(
        'REVOKE INSERT, UPDATE ON customers FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toEqual([])
    })

    /*
     * S-GRANT (Security seat, Council review): the seven escapes named in
     * review, each proved to have passed the OLD lenient regex and proved
     * here to be rejected by the fail-closed replacement. The owned-table
     * set is ('customers') throughout — every one of these names a
     * different table, a non-table grantee, or no recognisable shape at
     * all, so none can pass on a table-ownership technicality either.
     */
    const escapeFixtures: readonly [string, string][] = [
      [
        'GRANT ... ON ALL TABLES IN SCHEMA (schema-wide, no single table)',
        'GRANT UPDATE ON ALL TABLES IN SCHEMA public TO finsoft_app;',
      ],
      [
        'GRANT <role> TO <role> (role membership, no ON clause at all)',
        'GRANT finsoft_migration TO finsoft_app;',
      ],
      [
        "GRANT SELECT ON TABLE parties ... (the 'TABLE' keyword before the identifier)",
        'GRANT SELECT ON TABLE parties TO finsoft_app;',
      ],
      [
        'GRANT ... ON public.parties (schema-qualified, and the wrong table)',
        'GRANT SELECT ON public.parties TO finsoft_app;',
      ],
      ['REVOKE ... ON TABLE x ...', 'REVOKE INSERT, UPDATE ON TABLE customers FROM finsoft_app;'],
      ['REVOKE ... FROM PUBLIC CASCADE', 'REVOKE ALL ON customers FROM PUBLIC CASCADE;'],
      ['REVOKE ... FROM a, b (multi-role)', 'REVOKE INSERT, UPDATE ON customers FROM finsoft_app, readonly_support;'],
    ]

    it.each(escapeFixtures)('%s is rejected, not silently skipped', (_label, fixture) => {
      const offenses = grantRevokeOffenses(fixture, new Set(['customers']))
      expect(offenses, fixture).toHaveLength(1)
    })

    it('every real GRANT/REVOKE this schema actually issues still passes (no false positive)', () => {
      // The narrow allowed shapes exist to admit real, reviewed migrations —
      // proved against migration 015's own text, not just against fixtures.
      const sql = read('015_create_customers.sql')
      const owned = new Set(tablesCreatedBy(sql))
      expect(grantRevokeOffenses(sql, owned)).toEqual([])
    })

    it('CREATE VIEW with no options is rejected', () => {
      expect(viewsWithoutSecurityInvoker('CREATE VIEW v AS SELECT 1;')).toEqual(['v'])
    })

    it('CREATE VIEW WITH (security_invoker = true) is accepted', () => {
      expect(
        viewsWithoutSecurityInvoker('CREATE VIEW v WITH (security_invoker = true) AS SELECT 1;'),
      ).toEqual([])
    })

    it('a migration ALTERing a table it did not create is rejected by the ownership check', () => {
      const sql = `-- Owner: modules/customers\nCREATE TABLE customers (id uuid);\nALTER TABLE parties ADD COLUMN x text;`
      const owner = ownerOf(sql)
      expect(owner).toBe('modules/customers')
      const allowed = new Set(tablesCreatedBy(sql))
      const offenders = targetedConstructs(sql).filter((c) => !allowed.has(c.table))
      expect(offenders.map((o) => o.table)).toContain('parties')
    })

    it('a migration with no Owner header is rejected', () => {
      expect(ownerOf('CREATE TABLE customers (id uuid);')).toBeNull()
    })

    it('normalises a quoted and/or schema-qualified identifier before matching', () => {
      expect(normalizeIdentifier('customers')).toBe('customers')
      expect(normalizeIdentifier('"customers"')).toBe('customers')
      expect(normalizeIdentifier('public.customers')).toBe('customers')
    })
  })
})
