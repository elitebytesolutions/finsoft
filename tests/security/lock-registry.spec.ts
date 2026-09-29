import { readdirSync, readFileSync } from 'node:fs'
import { join, relative as relativePath } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'

/*
 * docs/LOCK_REGISTRY.md's own enforcement clause, built. ADR-0020's own
 * migration was the second claimant of the one-argument advisory-lock space
 * and its first draft claimed to be "the first" — a claim nothing in the
 * repository checked. LOCK_REGISTRY.md: "A CI assertion fails if
 * pg_advisory appears in any file this register does not name... Not yet
 * built; it is a merge condition on migration 009."
 *
 * This is that assertion: every source file naming `pg_advisory_lock` or
 * `pg_advisory_xact_lock` must be one this file explicitly allowlists, and
 * every allowlisted file's entry states which LOCK_REGISTRY.md position it
 * is. Adding a new advisory lock anywhere else in the repository — or
 * changing what an existing one does — now requires editing this list,
 * which is the point: a lock with no governing record does not get a free
 * pass by simply existing.
 */

const PG_ADVISORY_PATTERN = /\bpg_advisory(_xact)?_lock\b/

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  'build',
])

/** A plain recursive walk rather than a glob library or git status: robust regardless of what is staged or committed, and to whichever glob semantics this Node version's built-ins happen to support. */
function findSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue
      findSourceFiles(full, out)
    } else if (/\.(ts|tsx|sql)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

interface AllowlistEntry {
  readonly path: string
  readonly position: string
  readonly why: string
}

const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    path: 'packages/database/src/migrate/apply.ts',
    position: '1',
    why: "The migration-runner lock, FND-006. `hashtext('finsoft.migrations')::bigint`.",
  },
  {
    path: 'packages/database/src/audit/writer.ts',
    position: '6 (terminal)',
    why: "ADR-0020 §5. recordAudit's per-tenant chain append lock.",
  },
  {
    path: 'packages/database/src/audit/anchor.ts',
    position: '6 (terminal)',
    why: 'ADR-0020 §5. Tenant provisioning takes the same lock creating the seq=0 anchor.',
  },
  {
    path: 'database/migrations/009_create_audit_log.sql',
    position: '6 (terminal)',
    why: 'The existing-tenant backfill DO block takes the same lock per tenant, under the migration lock.',
  },
  {
    path: 'database/tests/trigger-mutation-lock.ts',
    position: '(not registered — test infrastructure)',
    why:
      'A plain (one-argument, session-scoped) pg_advisory_lock/unlock pair used ONLY by this test ' +
      'suite to serialise tests that disable an audit_log trigger against tests asserting it is ' +
      'enabled. Never imported by application code, never taken in a request or job path. Registered ' +
      'in LOCK_REGISTRY.md\'s own "test-only advisory lock" section — not a claimant of that ' +
      "registry's production ordering, but named there for the same reason this allowlist exists at " +
      'all: an unregistered pg_advisory call looks safe right up until a second claimant appears.',
  },
  {
    path: 'database/tests/audit-log-concurrency.spec.ts',
    position: '6 (terminal) — exercised directly, not claimed',
    why:
      'Tests reproduce the exact key expression from ADR-0020 §5 / LOCK_REGISTRY.md to hold or omit ' +
      "the real lock while proving the writer's own behaviour around it (the two-connection FOR " +
      'SHARE test, and the omitted-lock unique-constraint variant).',
  },
  {
    path: 'database/tests/audit-lock-timeout.spec.ts',
    position: '6 (terminal) — exercised directly, not claimed',
    why: "TD-001's lock_timeout test holds the real lock on a second connection to force recordAudit to wait.",
  },
]

describe('LOCK_REGISTRY.md enforcement: pg_advisory appears only where registered', () => {
  it('finds no pg_advisory_lock/pg_advisory_xact_lock outside the allowlist', () => {
    const allowedPaths = new Set(ALLOWLIST.map((e) => e.path.replaceAll('\\', '/')))
    const offenders: string[] = []

    // This file's own name, the ALLOWLIST entries below and this very
    // sentence necessarily contain the string "pg_advisory..." in plain text
    // (as data, in a regex, and in prose) — it is the enforcement mechanism,
    // not a caller, and is excluded from scanning itself for exactly that
    // reason. A literal, not import.meta.url: tests/security has no
    // package.json of its own, so tsc resolves this file as CommonJS under
    // NodeNext and rejects import.meta outright.
    const SELF = 'tests/security/lock-registry.spec.ts'

    for (const absolute of findSourceFiles(REPO_ROOT)) {
      const normalised = relativePath(REPO_ROOT, absolute).replaceAll('\\', '/')
      if (allowedPaths.has(normalised) || normalised === SELF) continue

      const content = readFileSync(absolute, 'utf8')
      if (PG_ADVISORY_PATTERN.test(content)) {
        offenders.push(normalised)
      }
    }

    expect(
      offenders,
      `pg_advisory_lock/pg_advisory_xact_lock found outside the LOCK_REGISTRY.md allowlist: ` +
        `${offenders.join(', ')}. Add a docs/LOCK_REGISTRY.md entry (Architecture Guardian approves ` +
        "the position, Database Guardian reviews the SQL) and an entry in this file's ALLOWLIST, " +
        'or remove the lock.',
    ).toEqual([])
  })

  it('finds no explicit row lock on audit_log outside migration 009 (LOCK_REGISTRY.md "Row locks on audit_log")', () => {
    // audit_log_enforce_linkage()'s own FOR SHARE (migration 009) is the ONE
    // sanctioned application-visible row lock on this table — everything
    // else is either the implicit KEY SHARE its own foreign keys take, or
    // forbidden. Comments are stripped first (the same technique
    // packages/database/src/migrate/migrations.ts's own destructive-statement
    // scanner uses) because this repository's own documentation of the
    // mechanism — this file's neighbours among them — legitimately says
    // "FOR SHARE" and "audit_log" in the same paragraph without that being a
    // query.
    const rowLockNearAuditLog =
      /\baudit_log\b[\s\S]{0,400}?\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i
    const sanctioned = 'database/migrations/009_create_audit_log.sql'

    const offenders: string[] = []
    for (const absolute of findSourceFiles(REPO_ROOT)) {
      const normalised = relativePath(REPO_ROOT, absolute).replaceAll('\\', '/')
      if (normalised === sanctioned || normalised === 'tests/security/lock-registry.spec.ts')
        continue

      const withoutComments = readFileSync(absolute, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/--[^\n]*/g, ' ')

      if (rowLockNearAuditLog.test(withoutComments)) offenders.push(normalised)
    }

    expect(
      offenders,
      `a FOR UPDATE/NO KEY UPDATE/SHARE/KEY SHARE clause appears near "audit_log" in code (not a ` +
        `comment) outside migration 009: ${offenders.join(', ')}. The only sanctioned application ` +
        "row lock on this table is audit_log_enforce_linkage()'s FOR SHARE — see LOCK_REGISTRY.md " +
        '"Row locks on audit_log".',
    ).toEqual([])
  })

  it('every allowlisted file still exists and still contains a pg_advisory call', () => {
    // The inverse check: an entry that outlives the code it names is exactly
    // the kind of stale exemption ADR-0021's own allowlists are tested
    // against elsewhere in this repository.
    for (const entry of ALLOWLIST) {
      const full = join(REPO_ROOT, entry.path)
      let content: string
      try {
        content = readFileSync(full, 'utf8')
      } catch {
        throw new Error(`ALLOWLIST names "${entry.path}", which does not exist. Remove the entry.`)
      }
      expect(
        PG_ADVISORY_PATTERN.test(content),
        `ALLOWLIST names "${entry.path}" but it no longer calls pg_advisory_lock/pg_advisory_xact_lock. ` +
          'Remove the entry — an exemption must not outlive the lock it names.',
      ).toBe(true)
    }
  })
})
