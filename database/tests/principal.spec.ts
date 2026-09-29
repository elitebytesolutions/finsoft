import { postingPrincipalOf, withTenant, type TenantTx } from '@finsoft/database'
import {
  createTenantFixture,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
  type TenantFixture,
} from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * M2-A T3 final review, Item 1 (Architecture + Security seats): the kernel
 * never imports TenantContext (M1-X T2); it reads the acting principal
 * through `postingPrincipalOf(tx)` instead — the ONLY narrow, read-only
 * accessor `packages/accounting-kernel` uses for it.
 *
 * The property that matters is not just "it returns the right values" —
 * `TenantContext.require()` already proves that. It is that
 * `postingPrincipalOf` hands back a FROZEN COPY, never the live
 * `AsyncLocalStorage` store object: a caller that casts past
 * `Readonly<PostingPrincipal>`'s type-level protection and mutates what it
 * got back must not be able to reach — let alone change — the ambient
 * principal the rest of the transaction, or a second accessor call, still
 * relies on.
 */

let tenant: TenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  tenant = await createTenantFixture('PRIN')
}, 60_000)

afterAll(async () => teardownTestDatabase())

function asPrincipal() {
  return runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
    withTenant(async (tx) => postingPrincipalOf(tx)),
  )
}

describe('postingPrincipalOf — the frozen-copy accessor', () => {
  it('returns the ambient tenantId and userId', async () => {
    const principal = await asPrincipal()
    expect(principal.tenantId).toBe(tenant.tenantId)
    expect(principal.userId).toBe(tenant.ownerId)
  })

  it('returns a frozen object, not a plain one', async () => {
    const principal = await asPrincipal()
    expect(Object.isFrozen(principal)).toBe(true)
  })

  it('a caller that casts past readonly and tries to mutate it gets a TypeError, and the ambient principal is unchanged', async () => {
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const principal = postingPrincipalOf(tx) as { tenantId: string; userId: string | null }

        expect(() => {
          principal.tenantId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
        }).toThrow(TypeError)

        // A second, independent read still sees the real ambient principal —
        // the mutation attempt on the first copy never reached it.
        const again = postingPrincipalOf(tx)
        expect(again.tenantId).toBe(tenant.tenantId)
      }),
    )
  })

  it('two calls return distinct objects, equal in value but not by reference', async () => {
    await runAs({ tenantId: tenant.tenantId, userId: tenant.ownerId }, () =>
      withTenant(async (tx) => {
        const first = postingPrincipalOf(tx)
        const second = postingPrincipalOf(tx)
        expect(first).not.toBe(second)
        expect(first).toEqual(second)
      }),
    )
  })

  it('throws on a handle withTenant did not issue (ADR-0013:98, the same fence every other query uses)', () => {
    const forged = {} as TenantTx
    expect(() => postingPrincipalOf(forged)).toThrow()
  })
})
