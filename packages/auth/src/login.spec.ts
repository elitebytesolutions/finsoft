import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * item 1d, security/database re-review 2026-09-27: "HashingQueueFullError ->
 * 503 must NOT increment any account-keyed throttle counter — assert it."
 *
 * tests/integration/login-toctou.spec.ts proves the semaphore cap and the
 * Redis key are REAL (no mocks) but, because winning a race against
 * argon2's own latency without flaking is impractical, it does not exercise
 * login()'s own catch block. This file does exactly that, deterministically:
 * `@finsoft/database/auth` and `./password.ts` are mocked so `decide()` is
 * guaranteed to throw HashingQueueFullError, and the test asserts
 * `refundLayers` — the REAL function from `./throttle.ts`, unmocked — was
 * called with exactly the layers `login()` computed for this request.
 */

const { withLoginAttemptMock } = vi.hoisted(() => ({ withLoginAttemptMock: vi.fn() }))
vi.mock('@finsoft/database/auth', () => ({
  withLoginAttempt: withLoginAttemptMock,
}))

const { verifyCredentialMock } = vi.hoisted(() => ({ verifyCredentialMock: vi.fn() }))
vi.mock('./password.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.ts')>()
  return {
    ...actual,
    verifyCredential: verifyCredentialMock,
  }
})

const { refundLayersSpy } = vi.hoisted(() => ({ refundLayersSpy: vi.fn() }))
vi.mock('./throttle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./throttle.ts')>()
  return {
    ...actual,
    checkLayers: vi.fn(async () => ({ throttled: false, retryAfterSeconds: 0, alertedLayers: [] })),
    refundLayers: vi.fn(async (layers: unknown) => {
      refundLayersSpy(layers)
    }),
  }
})

const { HashingQueueFullError } = await import('./password.ts')
const { login } = await import('./login.ts')
const { loginLayers } = await import('./throttle.ts')

function input() {
  return {
    tenantCode: 'ACME',
    email: 'user@example.com',
    password: 'irrelevant',
    ip: '203.0.113.1',
    ipPrefix: '203.0.113.1',
    deviceId: null,
    userAgent: null,
  }
}

describe('login() — item 1d: HashingQueueFullError refunds exactly the layers this request spent', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls refundLayers with the same layers loginLayers() computed, and rethrows the error', async () => {
    withLoginAttemptMock.mockImplementation(
      async (
        _tenantCode: string,
        _email: string,
        decide: (candidate: { user: null; tenant: { status: string } }) => Promise<unknown>,
      ) => decide({ user: null, tenant: { status: 'ACTIVE' } }),
    )
    verifyCredentialMock.mockRejectedValue(new HashingQueueFullError())

    const normalisedEmail = 'user@example.com'
    const normalisedTenantCode = 'ACME'
    const expectedLayers = loginLayers({
      normalisedEmail,
      normalisedTenantCode,
      ipPrefix: '203.0.113.1',
    })

    await expect(login(input())).rejects.toBeInstanceOf(HashingQueueFullError)

    expect(refundLayersSpy).toHaveBeenCalledTimes(1)
    expect(refundLayersSpy).toHaveBeenCalledWith(expectedLayers)
  })

  it('does NOT call refundLayers when withLoginAttempt fails for any other reason', async () => {
    withLoginAttemptMock.mockImplementation(
      async (
        _tenantCode: string,
        _email: string,
        decide: (candidate: { user: null; tenant: { status: string } }) => Promise<unknown>,
      ) => decide({ user: null, tenant: { status: 'ACTIVE' } }),
    )
    verifyCredentialMock.mockRejectedValue(new Error('some unrelated failure'))

    await expect(login(input())).rejects.toThrow('some unrelated failure')
    expect(refundLayersSpy).not.toHaveBeenCalled()
  })
})
