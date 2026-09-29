import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'

/*
 * C10 (ADR-0028): every migration from 014 on carries an `-- Owner:` header
 * naming an existing `modules/<name>` or `packages/<name>` directory (§9's
 * 2026-09-29 amendment, Architecture + Database/Security seats, both
 * countersigned), and every ALTER TABLE, CREATE TRIGGER … ON,
 * CREATE POLICY … ON, CREATE INDEX … ON and GRANT … ON targets a table that
 * a migration with the SAME owner created.
 *
 * 014 (`packages/permissions`) is a platform/RBAC migration, not a
 * `modules/<name>` one — the amendment widens the owner rule to admit it
 * while keeping every one of S4's bans in force for it unchanged. 015
 * (`modules/customers`, M3-C) is the first module migration proper.
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

/**
 * 014 (`packages/permissions`) is the first migration C10 applies to — the
 * §9 amendment's own statement 2 ("C10 applies to every migration from 014
 * on, as signed"). 015 (`modules/customers`) is the first `modules/<name>`
 * migration.
 */
const FIRST_MODULE_MIGRATION = 14

function migrationNumber(filename: string): number {
  const match = /^(\d+)_/.exec(filename)
  if (!match) throw new Error(`migration filename "${filename}" has no leading number`)
  return Number(match[1])
}

/** C10: "quoted and schema-qualified names are normalised before matching." */
export function normalizeIdentifier(raw: string): string {
  return raw.replace(/^"|"$/g, '').replace(/^public\./i, '')
}

/**
 * S4, widened by the §9 2026-09-29 amendment: the owner is either a
 * `modules/<name>` migration or a `packages/<name>` one (platform/kernel
 * master data, e.g. 014's `packages/permissions`). The header's own
 * existence check (`existsSync`, below) is what actually enforces "an
 * existing directory" — this regex only captures the candidate path.
 */
export function ownerOf(sql: string): string | null {
  const match = /^--\s*Owner:\s*((?:modules|packages)\/[a-zA-Z0-9_-]+)\s*$/m.exec(sql)
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

/** `GRANT INSERT (<cols>) ...` / `GRANT UPDATE (<cols>) ...` — the column-scoped re-grant S4 exception (a) requires after a REVOKE. */
const COLUMN_SCOPED_REGRANT = /^GRANT\s+(?:INSERT|UPDATE)\s*\(/i

export function grantRevokeOffenses(sql: string, ownedTables: ReadonlySet<string>): string[] {
  const offenses: string[] = []
  // S4 exception (a) (ADR-0028 §9, Security seat): a REVOKE INSERT, UPDATE
  // on a table is allowed only if the SAME migration then re-grants a
  // column list to finsoft_app on that same table. Tracked across the
  // whole file — the re-grant need not immediately follow the REVOKE
  // statement-for-statement, only be present somewhere in the same file.
  const revokedTables = new Set<string>()
  const regrantedTables = new Set<string>()

  for (const statement of splitStatements(sql)) {
    const isGrant = /\bGRANT\b/i.test(statement)
    const isRevoke = /\bREVOKE\b/i.test(statement)
    if (!isGrant && !isRevoke) continue

    const shapes = isGrant ? GRANT_SHAPES : [REVOKE_SHAPE]
    const match = shapes
      .map((re) => re.exec(statement))
      .find((m): m is RegExpExecArray => m !== null)

    if (!match) {
      offenses.push(`unrecognised ${isGrant ? 'GRANT' : 'REVOKE'} shape: ${statement}`)
      continue
    }

    const table = normalizeIdentifier(match[1] as string)
    if (!ownedTables.has(table)) {
      offenses.push(
        `${isGrant ? 'GRANT' : 'REVOKE'} on a table this migration's owner did not create ("${table}"): ${statement}`,
      )
    }

    if (isRevoke) revokedTables.add(table)
    if (isGrant && COLUMN_SCOPED_REGRANT.test(statement)) regrantedTables.add(table)
  }

  for (const table of revokedTables) {
    if (!regrantedTables.has(table)) {
      offenses.push(
        `REVOKE on "${table}" has no column-scoped re-GRANT (INSERT or UPDATE) to finsoft_app in the same migration (S4 exception (a))`,
      )
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
  /*
   * Security seat, second review of 91f330f (low, "do it anyway, it's
   * cheap"): a GRANT/REVOKE built as a string and run from a DO block, or
   * via a bare EXECUTE, is dynamic SQL — S-GRANT's statement-shape check
   * above only ever sees the literal text of the migration file, so a
   * grant assembled at runtime inside one of these is invisible to it.
   * Banning both constructs outright closes that, the same way S4 already
   * bans every other way this file could smuggle DDL/DCL past the checks
   * that read it as text.
   *
   * `EXECUTE` is NOT banned when followed by FUNCTION or PROCEDURE —
   * `CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION x()` is ordinary,
   * static trigger syntax (015_create_customers.sql uses it twice) and has
   * nothing to do with dynamic SQL.
   */
  {
    name: 'DO block (anonymous PL/pgSQL — dynamic SQL is invisible to S-GRANT)',
    re: /\bDO\s+\$/i,
  },
  {
    name: 'EXECUTE (dynamic SQL — not EXECUTE FUNCTION/PROCEDURE, which is ordinary trigger syntax)',
    re: /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)/i,
  },
]

/*
 * ADR-0028 §9, note dated 2026-09-29 (Architecture seat, M2-C). The checker
 * only scans migrations >= FIRST_MODULE_MIGRATION for `tablesCreatedBy`, so
 * a migration owned by `packages/accounting-kernel` that targets a table
 * created BEFORE 014 (migration 018 on `accounts`, from migration 010) would
 * otherwise see that table as belonging to no owner at all. This map is
 * EXPLICIT and narrow — only the pre-014 tables a >= 014 migration actually
 * needs to reference today — never a general "everything before 014 belongs
 * to X" inference.
 */
export const PRE_014_TABLE_OWNERS: Readonly<Record<string, string>> = {
  accounts: 'packages/accounting-kernel',
  fiscal_periods: 'packages/accounting-kernel',
  parties: 'packages/accounting-kernel',
  journal_entries: 'packages/accounting-kernel',
  journal_lines: 'packages/accounting-kernel',
  document_sequences: 'packages/accounting-kernel',
}

/** Every table a migration file (>= 014) creates, keyed by its declared owner, seeded with PRE_014_TABLE_OWNERS. */
export function buildOwnerTables(
  files: readonly string[],
  read: (file: string) => string,
): Map<string, Set<string>> {
  const ownerTables = new Map<string, Set<string>>()
  for (const [table, owner] of Object.entries(PRE_014_TABLE_OWNERS)) {
    const set = ownerTables.get(owner) ?? new Set<string>()
    set.add(table)
    ownerTables.set(owner, set)
  }
  for (const file of files) {
    const sql = read(file)
    const owner = ownerOf(sql)
    if (!owner) continue
    const set = ownerTables.get(owner) ?? new Set<string>()
    for (const table of tablesCreatedBy(sql)) set.add(table)
    ownerTables.set(owner, set)
  }
  return ownerTables
}

/*
 * ADR-0028 §9, note dated 2026-09-29 (Security seat, M2-C). S4 for
 * `packages/<name>` owners: all bans apply, with exactly three exceptions
 * (verbatim text in the ADR note). Exception (a) — REVOKE INSERT, UPDATE ON
 * an owned table FROM finsoft_app, only if the same migration re-grants a
 * column list — reuses the one allowed REVOKE shape (REVOKE_SHAPE above),
 * gated on table ownership via `ownedTables` (which `buildOwnerTables`,
 * above, now resolves correctly across the 014 boundary), TIGHTENED
 * (Council review, M2-C) so `grantRevokeOffenses` itself enforces the
 * "same migration re-grants a column list" half — a bare REVOKE with no
 * companion GRANT INSERT/UPDATE(...) is its own offense, not merely
 * unchecked. Exceptions (b) and (c) are new, owner-gated allowances below.
 */

/**
 * S4 exception (b), `packages/<name>` owners only: a `SECURITY DEFINER`
 * function is allowed only if the SAME migration also pins
 * `search_path = pg_catalog, public`, revokes EXECUTE from PUBLIC, and then
 * grants EXECUTE explicitly. A pragmatic, whole-file regex check — matching
 * this file's existing style — not a statement-scoped parse: the point is
 * that all three companion statements are present, not that they attach to
 * one specific CREATE FUNCTION in a file with several.
 */
export function isAllowedSecurityDefiner(sql: string): boolean {
  const pinnedSearchPath = /SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\b/is.test(sql)
  const revokeExecuteFromPublic = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\b[^;]*\bFROM\s+PUBLIC\b/is.test(
    sql,
  )
  const explicitGrantExecute = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\b/is.test(sql)
  return pinnedSearchPath && revokeExecuteFromPublic && explicitGrantExecute
}

/**
 * S4 exception (c), `packages/<name>` owners only: every `OWNER TO`
 * occurrence in the file must be an `ALTER FUNCTION ... OWNER TO ...` —
 * never `ALTER TABLE`, `ALTER INDEX`, or any other object. This function
 * checks only the SHAPE; that the named role is NOLOGIN, NOBYPASSRLS and
 * owns nothing else is `schema.spec.ts`'s job, against a real database.
 */
export function isAllowedFunctionOwnerChange(sql: string): boolean {
  const ownerToStatements =
    stripComments(sql).match(/\bALTER\s+\w+\b[^;]*\bOWNER\s+TO\b[^;]*/gis) ?? []
  if (ownerToStatements.length === 0) return false
  return ownerToStatements.every((statement) => /^ALTER\s+FUNCTION\b/is.test(statement.trim()))
}

const EXECUTE_BAN_RE = /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)/gi

/**
 * Exception (b)'s own companion statements — `GRANT EXECUTE ON FUNCTION ...`
 * / `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` — use the word EXECUTE in a
 * way the base EXECUTE-ban (dynamic SQL) pattern also matches, since it is
 * not `EXECUTE FUNCTION`/`EXECUTE PROCEDURE` (ordinary trigger syntax). This
 * checks that EVERY such match in the file is one of those two safe shapes,
 * not a genuine dynamic `EXECUTE '...'` — which stays banned even here.
 */
export function everyExecuteOccurrenceIsGrantOrRevoke(sql: string): boolean {
  const matches = [...sql.matchAll(EXECUTE_BAN_RE)]
  if (matches.length === 0) return true
  return matches.every((m) => {
    const start = m.index ?? 0
    const before = sql.slice(Math.max(0, start - 12), start)
    const after = sql.slice(start + m[0].length, start + m[0].length + 24)
    return /\b(?:GRANT|REVOKE)\s*$/i.test(before) && /^\s+ON\s+FUNCTION\b/i.test(after)
  })
}

/**
 * S4's forbidden-construct scan, owner-aware (ADR-0028 §9 notes above). A
 * `modules/<name>` owner (or no owner at all) gets the unconditional ban,
 * unchanged. A `packages/<name>` owner gets the two narrow exceptions —
 * exception (b) also exempts the EXECUTE-ban pattern where it fires only on
 * that exception's own `GRANT|REVOKE EXECUTE ON FUNCTION` companion
 * statements, never on a genuine dynamic EXECUTE.
 */
export function forbiddenOffenses(sql: string, owner: string | null): string[] {
  const isPackageOwner = owner !== null && owner.startsWith('packages/')
  const allowedDefiner = isPackageOwner && isAllowedSecurityDefiner(sql)
  const offenses: string[] = []

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (!pattern.re.test(sql)) continue

    if (allowedDefiner && pattern.name === 'CREATE FUNCTION ... SECURITY DEFINER') continue
    if (
      allowedDefiner &&
      pattern.name.startsWith('EXECUTE (dynamic SQL') &&
      everyExecuteOccurrenceIsGrantOrRevoke(sql)
    ) {
      continue
    }
    if (isPackageOwner && pattern.name === 'ALTER ... OWNER' && isAllowedFunctionOwnerChange(sql)) {
      continue
    }
    offenses.push(pattern.name)
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

  it('finds at least one migration to check (014 on)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)(
    '%s carries an "-- Owner: modules/<name>" or "packages/<name>" header naming an existing directory',
    (file) => {
      const sql = read(file)
      const owner = ownerOf(sql)
      expect(
        owner,
        `${file} has no "-- Owner: modules/<name>" or "packages/<name>" header`,
      ).not.toBeNull()
      expect(
        existsSync(join(REPO_ROOT, owner as string)),
        `${file}'s Owner (${String(owner)}) does not name an existing directory`,
      ).toBe(true)
    },
  )

  it('every targeted table belongs to a migration with the same owner', () => {
    const ownerTables = buildOwnerTables(files, read)

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

  it.each(files)(
    "%s contains none of S4's outright-forbidden constructs (packages/<name> exceptions apply)",
    (file) => {
      const sql = read(file)
      const owner = ownerOf(sql)
      const hits = forbiddenOffenses(sql, owner)
      expect(hits, `${file} contains a forbidden construct`).toEqual([])
    },
  )

  it.each(files)('%s: every GRANT/REVOKE matches an explicitly allowed shape (S-GRANT)', (file) => {
    const sql = read(file)
    const owner = ownerOf(sql)
    const ownerTables = buildOwnerTables(files, read)
    const owned = owner ? (ownerTables.get(owner) ?? new Set<string>()) : new Set<string>()
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
      [
        'DO block (anonymous PL/pgSQL — dynamic SQL is invisible to S-GRANT)',
        'DO $$ BEGIN PERFORM 1; END $$;',
      ],
      [
        'EXECUTE (dynamic SQL — not EXECUTE FUNCTION/PROCEDURE, which is ordinary trigger syntax)',
        "EXECUTE 'GRANT SELECT ON customers TO finsoft_app';",
      ],
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

    it('REVOKE ... ON a table this migration did not create is rejected (and, with no re-grant either, both offenses fire)', () => {
      const offenses = grantRevokeOffenses(
        'REVOKE INSERT, UPDATE ON parties FROM finsoft_app;',
        new Set(['customers']),
      )
      expect(offenses).toHaveLength(2)
      expect(offenses.some((o) => /did not create/.test(o))).toBe(true)
      expect(offenses.some((o) => /no column-scoped re-GRANT/.test(o))).toBe(true)
    })

    it('the one allowed REVOKE idiom passes: INSERT, UPDATE ON an owned table FROM finsoft_app, WITH a column-scoped re-grant', () => {
      // S4 exception (a): the REVOKE alone is not enough — the same
      // migration must also re-grant a column list to finsoft_app.
      const offenses = grantRevokeOffenses(
        'REVOKE INSERT, UPDATE ON customers FROM finsoft_app;\n' +
          'GRANT INSERT (id) ON customers TO finsoft_app;',
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
      [
        'REVOKE ... FROM a, b (multi-role)',
        'REVOKE INSERT, UPDATE ON customers FROM finsoft_app, readonly_support;',
      ],
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

    /*
     * S-OWNER (§9's 2026-09-29 amendment, Architecture + Database/Security
     * seats): the owner rule widened from `modules/<name>` only to
     * `modules/<name>` OR `packages/<name>`, still gated on the directory
     * actually existing — a header cannot claim ownership on behalf of a
     * package that was never created.
     */
    it('S-OWNER: a "-- Owner: packages/<name>" header is recognised and, for an existing package, passes', () => {
      const owner = ownerOf(
        '-- Owner: packages/permissions\nINSERT INTO role_permissions DEFAULT VALUES;',
      )
      expect(owner).toBe('packages/permissions')
      expect(existsSync(join(REPO_ROOT, owner as string))).toBe(true)
    })

    it("S-OWNER: migration 014's real header names packages/permissions and passes", () => {
      const sql = read('014_add_account_and_period_permissions.sql')
      const owner = ownerOf(sql)
      expect(owner).toBe('packages/permissions')
      expect(existsSync(join(REPO_ROOT, owner as string))).toBe(true)
    })

    it('S-OWNER: a "-- Owner: packages/<name>" header naming a directory that does not exist is rejected', () => {
      const owner = ownerOf('-- Owner: packages/does-not-exist\nCREATE TABLE t (id uuid);')
      expect(owner).toBe('packages/does-not-exist')
      expect(existsSync(join(REPO_ROOT, owner as string))).toBe(false)
    })

    it('S-OWNER: a "-- Owner: modules/<name>" header naming a directory that does not exist is still rejected', () => {
      const owner = ownerOf('-- Owner: modules/does-not-exist\nCREATE TABLE t (id uuid);')
      expect(owner).toBe('modules/does-not-exist')
      expect(existsSync(join(REPO_ROOT, owner as string))).toBe(false)
    })

    /*
     * Security seat, second review of 91f330f: the exact escape named in
     * review — a GRANT built as a string and run from a DO block — trips
     * BOTH the DO-block ban and the EXECUTE ban, so it cannot survive by
     * evading one while a fix for the other is still pending.
     */
    it('the named escape — a GRANT built as a string, run from a DO block — is rejected by both new bans', () => {
      const fixture = `
        DO $$
        BEGIN
          EXECUTE 'GRANT SELECT ON ' || quote_ident('customers') || ' TO finsoft_app';
        END $$;
      `
      const hits = FORBIDDEN_PATTERNS.filter((p) => p.re.test(fixture)).map((p) => p.name)
      expect(hits).toContain('DO block (anonymous PL/pgSQL — dynamic SQL is invisible to S-GRANT)')
      expect(hits).toContain(
        'EXECUTE (dynamic SQL — not EXECUTE FUNCTION/PROCEDURE, which is ordinary trigger syntax)',
      )
    })

    /*
     * Positive control: 015_create_customers.sql's own two triggers use
     * `FOR EACH ROW EXECUTE FUNCTION ...` — ordinary, static trigger
     * syntax that has to keep passing, or the EXECUTE ban would be a
     * false positive on every trigger this schema (or any future module)
     * ever creates.
     */
    it('EXECUTE FUNCTION / EXECUTE PROCEDURE (trigger syntax) is NOT rejected', () => {
      const hits = FORBIDDEN_PATTERNS.filter((p) =>
        p.re.test('CREATE TRIGGER t BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION f();'),
      ).map((p) => p.name)
      expect(hits).toEqual([])
    })

    it("015_create_customers.sql's real EXECUTE FUNCTION triggers still pass (no false positive)", () => {
      const sql = read('015_create_customers.sql')
      const hits = FORBIDDEN_PATTERNS.filter((p) => p.re.test(sql)).map((p) => p.name)
      expect(hits).toEqual([])
    })

    it('normalises a quoted and/or schema-qualified identifier before matching', () => {
      expect(normalizeIdentifier('customers')).toBe('customers')
      expect(normalizeIdentifier('"customers"')).toBe('customers')
      expect(normalizeIdentifier('public.customers')).toBe('customers')
    })

    /*
     * S4 exceptions for packages/<name> owners (ADR-0028 §9, note dated
     * 2026-09-29, Security seat). Each of (b) and (c) gets a failing
     * fixture (missing a companion statement, or the wrong owner) and a
     * passing fixture (the full allowed shape) — plus proof that a
     * modules/<name> owner gets NONE of this: the unconditional ban stays.
     */
    describe('S4 exceptions for packages/<name> owners (ADR-0028 §9, 2026-09-29)', () => {
      const definerFixture = `
        CREATE FUNCTION coa_seed(template_id text) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public AS $fn$
        BEGIN
          NULL;
        END;
        $fn$;
        REVOKE EXECUTE ON FUNCTION coa_seed(text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION coa_seed(text) TO finsoft_app;
      `

      it('(b) full shape: SECURITY DEFINER + pinned search_path + REVOKE EXECUTE FROM PUBLIC + explicit GRANT EXECUTE passes for a packages/<name> owner', () => {
        expect(isAllowedSecurityDefiner(definerFixture)).toBe(true)
        expect(forbiddenOffenses(definerFixture, 'packages/accounting-kernel')).toEqual([])
      })

      it('(b) is rejected for a packages/<name> owner when search_path is not pinned to exactly pg_catalog, public', () => {
        const missingSearchPath = definerFixture.replace(
          'SET search_path = pg_catalog, public',
          'SET search_path = pg_catalog, pg_temp',
        )
        expect(isAllowedSecurityDefiner(missingSearchPath)).toBe(false)
        expect(forbiddenOffenses(missingSearchPath, 'packages/accounting-kernel')).toContain(
          'CREATE FUNCTION ... SECURITY DEFINER',
        )
      })

      it('(b) is rejected for a packages/<name> owner when EXECUTE is not revoked from PUBLIC', () => {
        const missingRevoke = definerFixture.replace(
          'REVOKE EXECUTE ON FUNCTION coa_seed(text) FROM PUBLIC;',
          '',
        )
        expect(isAllowedSecurityDefiner(missingRevoke)).toBe(false)
        expect(forbiddenOffenses(missingRevoke, 'packages/accounting-kernel')).toContain(
          'CREATE FUNCTION ... SECURITY DEFINER',
        )
      })

      it('(b) is rejected for a packages/<name> owner when there is no explicit GRANT EXECUTE', () => {
        const missingGrant = definerFixture.replace(
          'GRANT EXECUTE ON FUNCTION coa_seed(text) TO finsoft_app;',
          '',
        )
        expect(isAllowedSecurityDefiner(missingGrant)).toBe(false)
        expect(forbiddenOffenses(missingGrant, 'packages/accounting-kernel')).toContain(
          'CREATE FUNCTION ... SECURITY DEFINER',
        )
      })

      it('(b) the exception does NOT apply to a modules/<name> owner — the unconditional ban stands', () => {
        expect(forbiddenOffenses(definerFixture, 'modules/customers')).toContain(
          'CREATE FUNCTION ... SECURITY DEFINER',
        )
      })

      it('(b) the exception does NOT apply with no owner at all', () => {
        expect(forbiddenOffenses(definerFixture, null)).toContain(
          'CREATE FUNCTION ... SECURITY DEFINER',
        )
      })

      const ownerFixture = 'ALTER FUNCTION coa_seed(text) OWNER TO finsoft_coa_seed;'

      it('(c) ALTER FUNCTION ... OWNER TO ... passes for a packages/<name> owner', () => {
        expect(isAllowedFunctionOwnerChange(ownerFixture)).toBe(true)
        expect(forbiddenOffenses(ownerFixture, 'packages/accounting-kernel')).toEqual([])
      })

      it('(c) ALTER TABLE ... OWNER TO ... is still rejected for a packages/<name> owner — only ALTER FUNCTION qualifies', () => {
        const tableOwnerFixture = 'ALTER TABLE accounts OWNER TO someone;'
        expect(isAllowedFunctionOwnerChange(tableOwnerFixture)).toBe(false)
        expect(forbiddenOffenses(tableOwnerFixture, 'packages/accounting-kernel')).toContain(
          'ALTER ... OWNER',
        )
      })

      it('(c) a file mixing an allowed ALTER FUNCTION OWNER TO with a disallowed ALTER TABLE OWNER TO is rejected', () => {
        const mixed = `${ownerFixture}\nALTER TABLE accounts OWNER TO someone;`
        expect(isAllowedFunctionOwnerChange(mixed)).toBe(false)
        expect(forbiddenOffenses(mixed, 'packages/accounting-kernel')).toContain('ALTER ... OWNER')
      })

      it('(c) the exception does NOT apply to a modules/<name> owner — the unconditional ban stands', () => {
        expect(forbiddenOffenses(ownerFixture, 'modules/customers')).toContain('ALTER ... OWNER')
      })

      it('(a) REVOKE INSERT, UPDATE on an owned table, followed by a column-scoped re-GRANT, passes for a packages/<name> owner once the table resolves as owned', () => {
        const revokeThenRegrant =
          'REVOKE INSERT, UPDATE ON accounts FROM finsoft_app;\n' +
          'GRANT INSERT (code) ON accounts TO finsoft_app;'
        const owned = new Set(['accounts'])
        expect(grantRevokeOffenses(revokeThenRegrant, owned)).toEqual([])
      })

      it('(a) is rejected: a REVOKE with NO re-grant at all — the checker must enforce the companion GRANT, not just accept the REVOKE shape', () => {
        const revokeOnly = 'REVOKE INSERT, UPDATE ON accounts FROM finsoft_app;'
        const owned = new Set(['accounts'])
        const offenses = grantRevokeOffenses(revokeOnly, owned)
        expect(offenses).toHaveLength(1)
        expect(offenses[0]).toMatch(/no column-scoped re-GRANT/)
      })

      it('(a) a re-grant that is NOT column-scoped (a bare GRANT UPDATE with no column list) does not satisfy the requirement', () => {
        // GRANT_SHAPES itself already refuses a column-less GRANT UPDATE as
        // an unrecognised shape, so this also proves the unrecognised-shape
        // offense fires rather than a false "re-grant satisfied".
        const revokeThenBareGrant =
          'REVOKE INSERT, UPDATE ON accounts FROM finsoft_app;\nGRANT UPDATE ON accounts TO finsoft_app;'
        const owned = new Set(['accounts'])
        const offenses = grantRevokeOffenses(revokeThenBareGrant, owned)
        expect(offenses.some((o) => /unrecognised GRANT shape/.test(o))).toBe(true)
        expect(offenses.some((o) => /no column-scoped re-GRANT/.test(o))).toBe(true)
      })

      it('(a) the same REVOKE is rejected if the table does not resolve as owned (the pre-014 map is what makes it resolve for migration 018) — now two offenses: unowned AND no re-grant', () => {
        const revokeFixture = 'REVOKE INSERT, UPDATE ON accounts FROM finsoft_app;'
        const offenses = grantRevokeOffenses(revokeFixture, new Set())
        expect(offenses).toHaveLength(2)
        expect(offenses.some((o) => /did not create/.test(o))).toBe(true)
        expect(offenses.some((o) => /no column-scoped re-GRANT/.test(o))).toBe(true)
      })
    })

    describe('pre-014 owner map (ADR-0028 §9, note dated 2026-09-29)', () => {
      it('resolves accounts (migration 010) to packages/accounting-kernel', () => {
        const ownerTables = buildOwnerTables(files, read)
        expect(ownerTables.get('packages/accounting-kernel')?.has('accounts')).toBe(true)
      })

      it("018's real ALTER TABLE/CREATE TRIGGER/CREATE INDEX/GRANT on accounts pass, now that accounts resolves as owned", () => {
        const migration018 = '018_accounts_create_and_edit.sql'
        if (!existsSync(join(MIGRATIONS_DIR, migration018))) return // not yet present in this checkout
        const sql = read(migration018)
        const owner = ownerOf(sql)
        expect(owner).toBe('packages/accounting-kernel')

        const ownerTables = buildOwnerTables(files, read)
        const allowed = ownerTables.get(owner as string) ?? new Set<string>()
        const offenders = targetedConstructs(sql).filter((c) => !allowed.has(c.table))
        expect(offenders).toEqual([])

        expect(grantRevokeOffenses(sql, allowed)).toEqual([])
      })
    })
  })
})
