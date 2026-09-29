import { isGlobalTable, withGlobal } from '@finsoft/database'
import { prepareTestDatabase, rawOn, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { columnPrivileges, columns, policies, tables } from './catalog.ts'

/*
 * Row Level Security, asserted over the live schema. ADR-0004's Compliance
 * section, verbatim where it is specific.
 *
 * ADR-0004:113 calls the property these tests protect "secure by omission":
 * forget the policy and the table is inaccessible, not open. That only holds
 * if forgetting it fails CI. This file is that gate — the one that has to
 * fail in a pull request rather than in production.
 */

/*
 * Pre-tenant policies. ADR-0023 §2, migration 006.
 *
 * A `FOR SELECT … USING (true)` policy breaks three of this file's own
 * assertions: it has no `WITH CHECK` (there is nothing to write), it is not
 * the same `current_setting` comparison as every other policy, and it does
 * not apply to `ALL`. ADR-0023's own words: "the tempting fix — relaxing
 * those assertions — would let any future USING (true) policy on any
 * tenant-owned table pass CI silently." So this is an EXACT-MATCH allowlist,
 * modelled on `GLOBALLY_UNIQUE_INDEX_ALLOWLIST` in schema.spec.ts, not a
 * relaxation of the assertions themselves: every policy NOT named here keeps
 * all three checks at full strength, and this one is instead held to a
 * narrower, specific shape below.
 */
interface PreTenantPolicyExemption {
  readonly table: string
  readonly policy: string
  readonly role: string
  readonly command: 'SELECT'
  readonly columns: readonly string[]
  readonly adr: string
  readonly why: string
}

const PRE_TENANT_POLICY_ALLOWLIST: readonly PreTenantPolicyExemption[] = [
  {
    table: 'refresh_tokens',
    policy: 'refresh_lookup',
    role: 'finsoft_refresh',
    command: 'SELECT',
    columns: ['tenant_id', 'id', 'token_hash'],
    adr: 'ADR-0023',
    why:
      'The refresh path resolves a bare token hash to a tenant BEFORE any tenant is known — ' +
      'establishing the tenant is what the read is for, so a tenant-scoped policy is ' +
      'unenforceable at exactly the point its guarantee is needed. USING (true) is load-bearing ' +
      "as a constant: it lets the planner fold away tenant_isolation's disjunction entirely, " +
      'so the cross-tenant read never evaluates a qual that would raise on an unset tenant.',
  },
]

function isPreTenantPolicy(tableName: string, policyName: string): boolean {
  return PRE_TENANT_POLICY_ALLOWLIST.some((e) => e.table === tableName && e.policy === policyName)
}

describe('row level security', () => {
  beforeAll(prepareTestDatabase, 60_000)
  afterAll(teardownTestDatabase)

  /** Every table carrying tenant_id, straight from the catalog. */
  async function tenantOwnedTables(): Promise<string[]> {
    const withTenantColumn = (await columns())
      .filter((c) => c.column_name === 'tenant_id')
      .map((c) => c.table_name)
    return [...new Set(withTenantColumn)]
  }

  it('enables AND forces RLS on every table carrying tenant_id', async () => {
    const owned = await tenantOwnedTables()
    expect(owned.length, 'no tenant-owned table exists to protect').toBeGreaterThan(0)

    const all = await tables()

    for (const name of owned) {
      const table = all.find((t) => t.table_name === name)
      expect(table, `${name} vanished between catalog reads`).toBeDefined()

      expect(table?.rls_enabled, `${name}: ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`).toBe(
        true,
      )
      expect(
        table?.rls_forced,
        `${name}: ALTER TABLE ${name} FORCE ROW LEVEL SECURITY is missing. Without FORCE the ` +
          'table owner bypasses its own policies, and finsoft_migration owns every table here. ' +
          'ADR-0004:46 treats ENABLE-without-FORCE as unprotected.',
      ).toBe(true)
      expect(
        Number(table?.policy_count ?? 0),
        `${name} has RLS on but no policy. PostgreSQL will deny everything, which is the right ` +
          'failure — but the fix is to add the policy, never to disable RLS (ADR-0004:82).',
      ).toBeGreaterThan(0)
    }
  })

  it('gives every policy on a tenant-owned table a non-null WITH CHECK', async () => {
    const owned = new Set(await tenantOwnedTables())
    const all = (await policies()).filter(
      (p) => owned.has(p.table_name) && !isPreTenantPolicy(p.table_name, p.policy_name),
    )
    expect(all.length).toBeGreaterThan(0)

    for (const policy of all) {
      expect(
        policy.with_check_expression,
        `${policy.table_name}.${policy.policy_name} has USING but no WITH CHECK. Without it a ` +
          "row can be INSERTed stamped with another tenant's tenant_id — a cross-tenant WRITE, " +
          'even though no cross-tenant read occurred (ADR-0004:48).',
      ).not.toBeNull()

      expect(
        policy.using_expression,
        `${policy.table_name}.${policy.policy_name} has no USING clause`,
      ).not.toBeNull()
    }
  })

  it('writes both clauses as the same current_setting comparison and nothing else', async () => {
    const owned = new Set(await tenantOwnedTables())
    const all = (await policies()).filter(
      (p) => owned.has(p.table_name) && !isPreTenantPolicy(p.table_name, p.policy_name),
    )

    for (const policy of all) {
      for (const [label, expression] of [
        ['USING', policy.using_expression],
        ['WITH CHECK', policy.with_check_expression],
      ] as const) {
        expect(expression, `${policy.table_name} ${label}`).toContain('current_setting')
        expect(expression, `${policy.table_name} ${label}`).toContain('app.tenant_id')
        expect(expression, `${policy.table_name} ${label}`).toContain('tenant_id =')

        /*
         * The two-argument form, current_setting('app.tenant_id', true),
         * returns NULL instead of raising when the setting is absent. The
         * comparison then yields NULL, the policy matches nothing, and a
         * missing tenant context turns into a silent empty result that looks
         * exactly like "this tenant has no data". ADR-0004:77 wants the loud
         * failure, so the permissive spelling must not appear.
         */
        expect(
          expression,
          `${policy.table_name} ${label} uses the missing_ok form of current_setting. That turns ` +
            'a missing tenant context from an error into an empty result — the failure mode ' +
            'ADR-0004:77 deliberately refuses.',
        ).not.toMatch(/current_setting\([^)]*,\s*true\s*\)/)

        // A policy predicate runs on every row touched, so it stays a
        // constant comparison — no table lookups, no session user name
        // (ADR-0004:50).
        expect(expression, `${policy.table_name} ${label}`).not.toMatch(
          /\b(select|current_user|session_user)\b/i,
        )
      }
    }
  })

  it('applies each policy to every command, not just SELECT', async () => {
    const owned = new Set(await tenantOwnedTables())
    const all = (await policies()).filter(
      (p) => owned.has(p.table_name) && !isPreTenantPolicy(p.table_name, p.policy_name),
    )

    for (const policy of all) {
      // pg_policy.polcmd: '*' is ALL; r/a/w/d are SELECT/INSERT/UPDATE/DELETE.
      expect(
        policy.command,
        `${policy.table_name}.${policy.policy_name} applies to command ` +
          `'${policy.command}' only. One policy covering ALL is the shape ADR-0004:34 specifies; ` +
          'per-command policies are how one command ends up uncovered.',
      ).toBe('*')
      expect(policy.permissive).toBe('PERMISSIVE')
    }
  })

  describe('PRE_TENANT_POLICY_ALLOWLIST (ADR-0023)', () => {
    it('carries no stale entry', async () => {
      const live = new Set((await policies()).map((p) => `${p.table_name}.${p.policy_name}`))
      for (const e of PRE_TENANT_POLICY_ALLOWLIST) {
        expect(
          live.has(`${e.table}.${e.policy}`),
          `PRE_TENANT_POLICY_ALLOWLIST names ${e.table}.${e.policy} (${e.adr}), which does not ` +
            'exist in the database. Remove the entry — an exemption must not outlive its policy.',
        ).toBe(true)
      }
    })

    it.each(PRE_TENANT_POLICY_ALLOWLIST)(
      '$table.$policy is FOR SELECT, one named role, USING (true) exactly, WITH CHECK null',
      async (exemption) => {
        const policy = (await policies()).find(
          (p) => p.table_name === exemption.table && p.policy_name === exemption.policy,
        )
        expect(policy, `${exemption.table}.${exemption.policy} not found`).toBeDefined()

        expect(
          policy?.command,
          'FOR SELECT only — a narrower command than ALL is the point here',
        ).toBe('r')
        expect(policy?.permissive).toBe('PERMISSIVE')
        expect(
          policy?.roles,
          'the policy must name exactly one role — not PUBLIC, not the general population',
        ).toEqual([exemption.role])

        // USING (true) EXACTLY, per ADR-0023 §2: a narrower qual only works
        // by cost-based OR short-circuit ordering, which is not guaranteed,
        // and any future narrowing turns /auth/refresh into an intermittent
        // 42704 in production.
        expect(policy?.using_expression).toBe('true')
        expect(
          policy?.with_check_expression,
          'FOR SELECT cannot carry a WITH CHECK; asserting NULL positively stops this entry being ' +
            'reused for a FOR ALL policy later without anyone noticing',
        ).toBeNull()
      },
    )

    it.each(PRE_TENANT_POLICY_ALLOWLIST)(
      '$role holds SELECT on exactly the allowlisted columns of $table, and no others',
      async (exemption) => {
        const grants = (await columnPrivileges())
          .filter(
            (g) =>
              g.table_name === exemption.table &&
              g.grantee === exemption.role &&
              g.privilege === 'SELECT',
          )
          .map((g) => g.column_name)

        expect(new Set(grants), `${exemption.role} SELECT columns on ${exemption.table}`).toEqual(
          new Set(exemption.columns),
        )
      },
    )

    it('the exempted role holds no other privilege anywhere it is not named', async () => {
      // The allowlist role must not, for instance, also hold SELECT on
      // `users` — that would be the login-resolver design ADR-0023 rejected,
      // reached silently through a different table.
      for (const exemption of PRE_TENANT_POLICY_ALLOWLIST) {
        const grants = (await columnPrivileges()).filter((g) => g.grantee === exemption.role)
        const tablesTouched = new Set(grants.map((g) => g.table_name))
        expect([...tablesTouched]).toEqual([exemption.table])
      }
    })
  })

  it('leaves global tables out of RLS, deliberately and visibly', async () => {
    const all = await tables()
    for (const table of all) {
      if (!isGlobalTable(table.table_name)) continue
      expect(
        table.rls_enabled,
        `${table.table_name} is on the global allowlist but has RLS enabled. Either it is ` +
          'tenant-owned and the allowlist is wrong, or the RLS is a mistake — both need a ' +
          'decision, not a passing test.',
      ).toBe(false)
    }
  })

  it('has no default for app.tenant_id anywhere (ADR-0004:77)', async () => {
    const settings = await withGlobal((tx) =>
      rawOn<{ setting: string }>(tx, `select unnest(setconfig) as setting from pg_db_role_setting`),
    )

    const leaked = settings.map((s) => s.setting).filter((s) => s.startsWith('app.tenant_id'))

    expect(
      leaked,
      'a database- or role-level default for app.tenant_id exists. current_setting must RAISE ' +
        'when the tenant is unset: a default turns a hard error into silent cross-tenant ' +
        'visibility, which is the opposite of the intended failure mode.',
    ).toEqual([])
  })

  it('confirms the setting is genuinely unset on a fresh transaction', async () => {
    const value = await withGlobal((tx) =>
      rawOn<{ value: string | null }>(tx, `select current_setting('app.tenant_id', true) as value`),
    )

    // The missing_ok form is used *here*, in a test, precisely because the
    // point is to observe absence without the statement aborting.
    expect(value[0]?.value ?? null).toBeNull()
  })
})
