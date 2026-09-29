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

/** ALTER TABLE, CREATE TRIGGER … ON, CREATE POLICY … ON, CREATE INDEX … ON, GRANT … ON. */
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
    ['GRANT', /GRANT\s+[\w\s,()]+?\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+(?:TO|FROM)/gi],
    ['REVOKE', /REVOKE\s+[\w\s,()]+?\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+FROM/gi],
  ]
  for (const [kind, re] of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(sql)))
      out.push({ kind, table: normalizeIdentifier(match[1] as string) })
  }
  return out
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

/*
 * REVOKE is narrowed rather than blanket-banned. S4 lists REVOKE among the
 * outright-forbidden constructs, and read absolutely it would reject the
 * `REVOKE INSERT, UPDATE ON <table> FROM finsoft_app` line every migration
 * in this schema opens its Grants section with (001, 008 — "008's lesson",
 * 012, 013 all carry it) — it is what makes the column-scoped GRANT that
 * follows actually narrow, since `ALTER DEFAULT PRIVILEGES` (set once,
 * platform-wide, itself on the FORBIDDEN_PATTERNS list above so a MODULE
 * can never set it) already hands every new table full table-level SELECT,
 * INSERT, UPDATE to finsoft_app. Forbidding this migration to narrow that
 * back down would leave finsoft_app able to INSERT customers.id,
 * customers.code and customers.create_idempotency_key directly — exactly
 * the privilege-layer hole the column-scoped grant exists to close, and a
 * real regression, not a compliance nicety. Reported as a DECISION in this
 * lane's delivery report for the Security seat to confirm or narrow
 * further: what is checked here is only the ONE idiom the existing schema
 * already establishes as required — REVOKE INSERT, UPDATE (and nothing
 * else) FROM finsoft_app (and no other role) ON a table THIS migration's
 * own owner created. Any REVOKE outside that exact shape still fails.
 */
function revokeOffenses(sql: string, ownedTables: ReadonlySet<string>): string[] {
  const offenses: string[] = []
  const re =
    /REVOKE\s+([\w\s,]+?)\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+FROM\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*;/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(sql))) {
    const privileges = (match[1] as string)
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .sort()
    const table = normalizeIdentifier(match[2] as string)
    const role = normalizeIdentifier(match[3] as string)
    const isTheOneAllowedIdiom =
      privileges.join(',') === 'INSERT,UPDATE' && role === 'finsoft_app' && ownedTables.has(table)
    if (!isTheOneAllowedIdiom) {
      offenses.push(`REVOKE ${match[1]} ON ${table} FROM ${role}`)
    }
  }
  return offenses
}

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

  it.each(files)('%s REVOKEs nothing except the one allowed idiom (S4, narrowed)', (file) => {
    const sql = read(file)
    const owned = new Set(tablesCreatedBy(sql))
    expect(
      revokeOffenses(sql, owned),
      `${file} has a REVOKE outside the one allowed idiom`,
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
      const offenses = revokeOffenses(
        'REVOKE SELECT ON customers FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toEqual(['REVOKE SELECT ON customers FROM finsoft_app'])
    })

    it('REVOKE ... FROM a role other than finsoft_app is rejected', () => {
      const offenses = revokeOffenses(
        'REVOKE INSERT, UPDATE ON customers FROM readonly_support;',
        new Set(['customers']),
      )
      expect(offenses).toEqual(['REVOKE INSERT, UPDATE ON customers FROM readonly_support'])
    })

    it('REVOKE ... ON a table this migration did not create is rejected', () => {
      const offenses = revokeOffenses(
        'REVOKE INSERT, UPDATE ON parties FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toEqual(['REVOKE INSERT, UPDATE ON parties FROM finsoft_app'])
    })

    it('the one allowed REVOKE idiom passes: INSERT, UPDATE ON an owned table FROM finsoft_app', () => {
      const offenses = revokeOffenses(
        'REVOKE INSERT, UPDATE ON customers FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toEqual([])
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
