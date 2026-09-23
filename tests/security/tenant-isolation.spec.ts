import {
  BaseRepository,
  TenantContextError,
  TransactionScopeError,
  withGlobal,
  withTenant,
  type TenantTx,
} from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  rawOn,
  runAs,
  scalarOn,
  sqlstate,
  teardownTestDatabase,
  unique,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The tenant isolation gate. FND-007/008.
 *
 * ADR-0004:139 and rule 8. Five things must be true, and every one of them is
 * executed as **finsoft_app** — the production-style restricted role, no
 * BYPASSRLS, no SUPERUSER, owner of nothing. The harness refuses to start
 * against any other role, because a suite like this run as a superuser passes
 * completely while proving nothing.
 *
 *   1. Tenant A cannot read or modify tenant B's records.
 *   2. Missing tenant context cannot expose tenant data — it must ERROR,
 *      not return rows.
 *   3. A pooled connection cannot carry the previous tenant to its next
 *      borrower.
 *   4. A failed operation rolls back the entire transaction.
 *   5. Cross-tenant foreign-key relationships are rejected.
 *
 * Rule 8 phrases the first one as a property of raw SQL, not of the
 * repository layer: "a raw SELECT * FROM journal_entries executed by the
 * application role must return only the current tenant's rows". So these
 * tests mostly use `rawOn` — the unmediated query an attacker, or a coding
 * agent improvising, would actually run. Passing them through a repository
 * that adds `WHERE tenant_id = ?` would test the wrong layer.
 */

let alpha: TenantFixture
let beta: TenantFixture

/**
 * The two ways PostgreSQL refuses a tenant-owned table when no tenant is set.
 *
 * Which one you get depends on the history of the *connection*, and this is
 * worth knowing before someone writes a catch block against one of them:
 *
 *   42704  unrecognized configuration parameter
 *          The connection has never had app.tenant_id set. The custom GUC
 *          does not exist, so current_setting raises.
 *
 *   22P02  invalid input syntax for type uuid: ""
 *          The connection HAS carried a tenant at some point. A
 *          transaction-scoped set_config creates the placeholder for the rest
 *          of the session; at commit the value reverts — not to "absent", but
 *          to the empty string. current_setting then returns '' and the
 *          ::uuid cast raises.
 *
 * The distinction is a curiosity; the property that matters is that both
 * abort the statement. Neither returns a row, and '' cannot match any
 * tenant_id, so there is no third outcome in which data escapes. ADR-0004:77
 * asks for the loud failure and gets it either way.
 */
const NO_TENANT_SQLSTATES = new Set(['42704', '22P02'])

const isNoTenantError = (error: unknown): boolean => {
  const code = sqlstate(error)
  return code !== undefined && NO_TENANT_SQLSTATES.has(code)
}

/** A concrete repository, only to exercise layer three of the four. */
class UserRepository extends BaseRepository<'users'> {
  constructor() {
    super('users')
  }

  listIds(tx: TenantTx): Promise<{ id: string; tenant_id: string }[]> {
    return this.scopedSelect(tx).select(['users.id', 'users.tenant_id']).execute()
  }

  create(tx: TenantTx, email: string, fullName: string): Promise<{ id: string }> {
    return this.scopedInsert(tx, { email, full_name: fullName })
      .returning('id')
      .executeTakeFirstOrThrow()
  }
}

describe('tenant isolation', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    alpha = await createTenantFixture('A')
    beta = await createTenantFixture('B')
  }, 60_000)

  afterAll(teardownTestDatabase)

  const asAlpha = <T>(fn: () => Promise<T>): Promise<T> =>
    runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, fn)
  const asBeta = <T>(fn: () => Promise<T>): Promise<T> =>
    runAs({ tenantId: beta.tenantId, userId: beta.ownerId }, fn)

  it('set up two distinct tenants, each with a user', () => {
    expect(alpha.tenantId).not.toBe(beta.tenantId)
    expect(alpha.ownerId).not.toBe(beta.ownerId)
  })

  /* ================================================================ *
   * 1. Tenant A cannot read or modify tenant B's records
   * ================================================================ */

  describe('1. cross-tenant read and write', () => {
    it('returns only the current tenant from a bare SELECT * (rule 8)', async () => {
      const rows = await asAlpha(() =>
        withTenant((tx) => rawOn<{ id: string; tenant_id: string }>(tx, 'select * from users')),
      )

      expect(rows.length).toBeGreaterThan(0)
      const foreign = rows.filter((r) => r.tenant_id !== alpha.tenantId)
      expect(
        foreign,
        "a bare SELECT * returned another tenant's rows. Rule 8 classifies this as Sev-1, not " +
          'as a bug ticket.',
      ).toEqual([])
      expect(rows.map((r) => r.id)).not.toContain(beta.ownerId)
    })

    it("cannot fetch tenant B's row by its primary key", async () => {
      const found = await asAlpha(() =>
        withTenant((tx) =>
          scalarOn<number>(tx, 'select count(*)::int from users where id = $1', [beta.ownerId]),
        ),
      )
      expect(found).toBe(0)
    })

    it("cannot UPDATE tenant B's row, and leaves it untouched", async () => {
      const before = await asBeta(() =>
        withTenant((tx) =>
          scalarOn<string>(tx, 'select full_name from users where id = $1', [beta.ownerId]),
        ),
      )

      const affected = await asAlpha(() =>
        withTenant(async (tx) => {
          const rows = await rawOn<{ id: string }>(
            tx,
            'update users set full_name = $2 where id = $1 returning id',
            [beta.ownerId, 'OVERWRITTEN BY TENANT A'],
          )
          return rows.length
        }),
      )

      expect(affected, 'the UPDATE matched a row it should not have been able to see').toBe(0)

      const after = await asBeta(() =>
        withTenant((tx) =>
          scalarOn<string>(tx, 'select full_name from users where id = $1', [beta.ownerId]),
        ),
      )
      expect(after).toBe(before)
    })

    it("rejects an INSERT stamped with tenant B's id (the WITH CHECK clause)", async () => {
      const attempt = asAlpha(() =>
        withTenant((tx) =>
          rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $5)`,
            [beta.tenantId, `smuggled.${unique()}@example.test`, 'Smuggled', null, null],
          ),
        ),
      )

      /*
       * 42501 — "new row violates row-level security policy". This is the
       * failure ADR-0004:48 spells out: without WITH CHECK the row would be
       * written under another tenant's id, a cross-tenant WRITE with no
       * cross-tenant read anywhere in sight.
       */
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => sqlstate(error) === '42501',
        'expected SQLSTATE 42501, new row violates row-level security policy',
      )
    })

    it('scopes the repository layer to the context tenant as well', async () => {
      const repository = new UserRepository()

      const alphaIds = await asAlpha(() => withTenant((tx) => repository.listIds(tx)))
      const betaIds = await asBeta(() => withTenant((tx) => repository.listIds(tx)))

      expect(alphaIds.every((r) => r.tenant_id === alpha.tenantId)).toBe(true)
      expect(betaIds.every((r) => r.tenant_id === beta.tenantId)).toBe(true)
      expect(alphaIds.map((r) => r.id)).not.toContain(beta.ownerId)
    })

    it('stamps tenant_id on insert from the context, not from the caller', async () => {
      const repository = new UserRepository()
      const email = `stamped.${unique()}@example.test`

      const created = await asAlpha(() =>
        withTenant((tx) => repository.create(tx, email, 'Stamped By Context')),
      )

      const owner = await asAlpha(() =>
        withTenant((tx) =>
          scalarOn<string>(tx, 'select tenant_id from users where id = $1', [created.id]),
        ),
      )
      expect(owner).toBe(alpha.tenantId)

      // And it is invisible to the other tenant.
      const seenByBeta = await asBeta(() =>
        withTenant((tx) =>
          scalarOn<number>(tx, 'select count(*)::int from users where id = $1', [created.id]),
        ),
      )
      expect(seenByBeta).toBe(0)
    })

    it('rejects a forged TenantTx at runtime, not just in the type checker', async () => {
      const repository = new UserRepository()

      await withGlobal(async (tx) => {
        // The cast ADR-0013:98 warns about: it compiles, it reviews as "just
        // a type assertion", and it hands unscoped access to code that is
        // supposed to be tenant-bound. The registry in transaction.ts is what
        // catches it.
        const forged = tx as unknown as TenantTx

        // The `async` matters: scopedSelect rejects the handle synchronously,
        // so without it the throw escapes the promise `rejects` is watching.
        await expect(asAlpha(async () => repository.listIds(forged))).rejects.toBeInstanceOf(
          TransactionScopeError,
        )
      })
    })
  })

  /* ================================================================ *
   * 2. Missing tenant context cannot expose tenant data
   * ================================================================ */

  describe('2. missing tenant context', () => {
    it('refuses to open a tenant transaction with no context', async () => {
      await expect(withTenant(async () => 'unreachable')).rejects.toBeInstanceOf(TenantContextError)
    })

    it('ERRORS rather than returning rows when app.tenant_id is unset', async () => {
      /*
       * The important half of this test is the precondition. RLS policy
       * predicates are evaluated per row, so a query against an EMPTY table
       * never evaluates current_setting and never raises — it just returns
       * nothing, which looks identical to working correctly. Assert there is
       * data to leak before asserting that it does not leak.
       */
      const rowsExist = await asAlpha(() =>
        withTenant((tx) => scalarOn<number>(tx, 'select count(*)::int from users')),
      )
      expect(rowsExist, 'no rows in users — this test would pass vacuously').toBeGreaterThan(0)

      const attempt = withGlobal((tx) => rawOn(tx, 'select * from users'))

      /*
       * It raises. ADR-0004:77 — no cluster default exists for
       * app.tenant_id, precisely so that this cannot resolve to something
       * permissive. A default would turn the hard error into a silent read
       * of every tenant.
       *
       * The assertion is on the class of failure, not one SQLSTATE: see
       * NO_TENANT_SQLSTATES above. Pinning it to 42704 would make the test
       * depend on whether this pooled connection had previously carried a
       * tenant, which is not a property anything should depend on.
       */
      await expect(attempt).rejects.toSatisfy(
        isNoTenantError,
        'expected the policy predicate to raise: 42704 on a connection that never carried a ' +
          'tenant, 22P02 on one that did',
      )
    })

    it('errors on a write with no tenant context too', async () => {
      const attempt = withGlobal((tx) =>
        rawOn(
          tx,
          `insert into users (tenant_id, email, full_name, created_by, updated_by)
           values ($1, $2, $3, null, null)`,
          [alpha.tenantId, `nocontext.${unique()}@example.test`, 'No Context'],
        ),
      )

      await expect(attempt).rejects.toSatisfy(
        isNoTenantError,
        'expected the policy predicate to raise on the write path as well',
      )
    })

    it('cannot address a tenant-owned table inside withGlobal — compile time', () => {
      /*
       * Never invoked. The assertion is that `tsc -p tests/security` rejects
       * the marked line: @ts-expect-error fails the typecheck if the error
       * stops occurring, which is what would happen if `users` were ever
       * added to the GlobalDatabase view.
       */
      const neverCalled = async (): Promise<unknown> =>
        withGlobal(async (tx) =>
          // @ts-expect-error ADR-0013:104 — withGlobal is typed against a global-tables-only view.
          tx.selectFrom('users').selectAll().execute(),
        )

      expect(typeof neverCalled).toBe('function')
    })

    it('offers no parameter a request body could be passed into — compile time', () => {
      const neverCalled = async (): Promise<unknown> =>
        // @ts-expect-error ADR-0013:88 — withTenant takes no tenant argument, by design.
        withTenant(alpha.tenantId, async () => undefined)

      expect(typeof neverCalled).toBe('function')
      expect(withTenant.length, 'withTenant accepts exactly one argument: the callback.').toBe(1)
    })
  })

  /* ================================================================ *
   * 3. A pooled connection carries nothing to its next borrower
   * ================================================================ */

  describe('3. connection reuse', () => {
    it('leaves no app.tenant_id on the connection after the transaction commits', async () => {
      const pid = await asAlpha(() =>
        withTenant(async (tx) => {
          const inside = await scalarOn<string>(tx, "select current_setting('app.tenant_id')")
          expect(inside, 'the wrapper did not set the tenant it was asked for').toBe(alpha.tenantId)
          return scalarOn<string>(tx, 'select pg_backend_pid()::text')
        }),
      )

      const next = await withGlobal(async (tx) => ({
        pid: await scalarOn<string>(tx, 'select pg_backend_pid()::text'),
        tenant: await scalarOn<string | null>(
          tx,
          "select current_setting('app.tenant_id', true) as tenant",
        ),
      }))

      /*
       * The pool is pinned to one connection for this suite, so "the next
       * borrower" is guaranteed to be the same backend. Without that pin the
       * test would usually get a different connection and pass while testing
       * nothing at all.
       */
      expect(next.pid, 'expected the same pooled connection to be reused').toBe(pid)

      /*
       * The setting reverts to the empty string rather than disappearing —
       * see NO_TENANT_SQLSTATES. What ADR-0004:140 actually requires is that
       * the connection carries NO TENANT to its next borrower, so that is
       * what is asserted: not the previous tenant, not any tenant, nothing
       * that could ever match a tenant_id.
       */
      expect(
        next.tenant,
        'the tenant id survived the commit and is still set on a pooled connection. ' +
          'set_config(..., true) is transaction-scoped precisely so this cannot happen ' +
          '(ADR-0004:74) — a session-scoped SET here is a cross-tenant read with no error ' +
          'and no log line.',
      ).not.toBe(alpha.tenantId)
      expect(next.tenant === null || next.tenant === '').toBe(true)
    })

    it('makes the reused connection unable to read tenant data again', async () => {
      await asBeta(() =>
        withTenant((tx) => scalarOn<number>(tx, 'select count(*)::int from users')),
      )

      // Same connection, immediately afterwards, with no tenant established.
      const attempt = withGlobal((tx) => rawOn(tx, 'select * from users'))
      await expect(attempt).rejects.toSatisfy(
        isNoTenantError,
        'a connection that has just finished serving one tenant must not be able to read any ' +
          'tenant on its next use',
      )
    })

    it('switches tenants cleanly on the same connection', async () => {
      const first = await asAlpha(() =>
        withTenant((tx) => scalarOn<string>(tx, "select current_setting('app.tenant_id')")),
      )
      const second = await asBeta(() =>
        withTenant((tx) => scalarOn<string>(tx, "select current_setting('app.tenant_id')")),
      )
      const third = await asAlpha(() =>
        withTenant((tx) => scalarOn<string>(tx, "select current_setting('app.tenant_id')")),
      )

      expect(first).toBe(alpha.tenantId)
      expect(second).toBe(beta.tenantId)
      expect(third).toBe(alpha.tenantId)
    })
  })

  /* ================================================================ *
   * 4. A failed operation rolls back the entire transaction
   * ================================================================ */

  describe('4. rollback', () => {
    it('discards everything when application code throws', async () => {
      const email = `rollback.app.${unique()}@example.test`

      const attempt = asAlpha(() =>
        withTenant(async (tx) => {
          await rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4)`,
            [alpha.tenantId, email, 'Doomed', alpha.ownerId],
          )

          // Visible inside the transaction, which is what makes the absence
          // afterwards meaningful rather than an insert that never ran.
          const visible = await scalarOn<number>(
            tx,
            'select count(*)::int from users where email = $1',
            [email],
          )
          expect(visible).toBe(1)

          throw new Error('posting failed after the insert')
        }),
      )

      await expect(attempt).rejects.toThrow('posting failed after the insert')

      const survived = await asAlpha(() =>
        withTenant((tx) =>
          scalarOn<number>(tx, 'select count(*)::int from users where email = $1', [email]),
        ),
      )
      expect(
        survived,
        'a row survived a failed transaction. ARCHITECTURE §7: the transaction is the unit of ' +
          'correctness — journal, stock, audit and outbox commit together or not at all.',
      ).toBe(0)
    })

    it('discards earlier writes when a later statement violates a constraint', async () => {
      const first = `rollback.db.a.${unique()}@example.test`
      const duplicate = `rollback.db.b.${unique()}@example.test`

      // Seed a row the second insert will collide with.
      await asAlpha(() =>
        withTenant((tx) =>
          rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4)`,
            [alpha.tenantId, duplicate, 'Existing', alpha.ownerId],
          ),
        ),
      )

      const attempt = asAlpha(() =>
        withTenant(async (tx) => {
          await rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4)`,
            [alpha.tenantId, first, 'Would Have Been Fine', alpha.ownerId],
          )
          // Same address, different case: users_tenant_email_key is on
          // lower(email), so this is the same login.
          await rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4)`,
            [alpha.tenantId, duplicate.toUpperCase(), 'Collides', alpha.ownerId],
          )
        }),
      )

      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => sqlstate(error) === '23505',
        'expected SQLSTATE 23505, unique violation',
      )

      const survived = await asAlpha(() =>
        withTenant((tx) =>
          scalarOn<number>(tx, 'select count(*)::int from users where email = $1', [first]),
        ),
      )
      expect(survived, 'the first insert outlived the failed transaction').toBe(0)
    })
  })

  /* ================================================================ *
   * 5. Cross-tenant foreign keys are rejected
   * ================================================================ */

  describe('5. cross-tenant references', () => {
    it("refuses a row in tenant A that references tenant B's row", async () => {
      const attempt = asAlpha(() =>
        withTenant((tx) =>
          rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4)`,
            [alpha.tenantId, `crosstenant.${unique()}@example.test`, 'Cross Tenant', beta.ownerId],
          ),
        ),
      )

      /*
       * 23503 — foreign key violation, from the composite key
       * (tenant_id, created_by) -> users (tenant_id, id).
       *
       * RLS alone does NOT cover this case. PostgreSQL performs referential
       * integrity checks with row security off, so a plain
       * `created_by REFERENCES users(id)` would have accepted tenant B's user
       * id from inside tenant A's context without complaint. ADR-0003:29's
       * "composite or backed by a check" is what actually closes it, and
       * FinancialInvariantSuite Invariant 7 — no journal line references
       * another tenant's account — depends on every later table doing the
       * same.
       */
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => sqlstate(error) === '23503',
        'expected SQLSTATE 23503, foreign key violation',
      )
    })

    it('accepts the same insert when the reference is in-tenant', async () => {
      const email = `intenant.${unique()}@example.test`

      const created = await asAlpha(() =>
        withTenant((tx) =>
          rawOn<{ id: string }>(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, $4, $4) returning id`,
            [alpha.tenantId, email, 'In Tenant', alpha.ownerId],
          ),
        ),
      )

      expect(created).toHaveLength(1)
    })

    it('declares the authorship foreign keys as composite on tenant_id', async () => {
      const definitions = await withGlobal((tx) =>
        rawOn<{ conname: string; definition: string }>(
          tx,
          `select con.conname, pg_get_constraintdef(con.oid) as definition
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
            where c.relname = 'users' and con.contype = 'f'
              and con.conname <> 'users_tenant_id_fkey'`,
        ),
      )

      expect(definitions.length).toBeGreaterThan(0)
      for (const fk of definitions) {
        expect(
          fk.definition,
          `${fk.conname} is a single-column foreign key between tenant-owned tables. Referential ` +
            'integrity checks bypass row security, so only a composite key on tenant_id stops a ' +
            "row pointing at another tenant's row (ADR-0003:29).",
        ).toMatch(/FOREIGN KEY \(tenant_id, \w+\) REFERENCES users\(tenant_id, id\)/)
      }
    })

    it('permits at most one provisioned owner per tenant', async () => {
      // A second user with no created_by would be a second row claiming to
      // predate every user of its tenant. The partial unique index in 002
      // refuses it, which is what keeps the nullable authorship columns a
      // bounded exception rather than an open door.
      const attempt = asAlpha(() =>
        withTenant((tx) =>
          rawOn(
            tx,
            `insert into users (tenant_id, email, full_name, created_by, updated_by)
             values ($1, $2, $3, null, null)`,
            [alpha.tenantId, `secondowner.${unique()}@example.test`, 'Second Owner'],
          ),
        ),
      )

      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => sqlstate(error) === '23505',
        'expected SQLSTATE 23505 from users_one_provisioned_owner_per_tenant',
      )
    })
  })
})
