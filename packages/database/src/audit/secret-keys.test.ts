import { describe, expect, it } from 'vitest'
import { AuditSecretKeyError, assertNoSecretLikeKeys } from './secret-keys.ts'

describe('assertNoSecretLikeKeys', () => {
  it('accepts an event with no secret-shaped keys', () => {
    expect(() =>
      assertNoSecretLikeKeys({ action: 'x', entityType: 'y', nested: { field: 'z' } }),
    ).not.toThrow()
  })

  it.each([
    'password',
    'Password',
    'user_password',
    'secret',
    'client_secret',
    'token',
    'access_token',
    'refresh',
    'refresh_token',
    'otp',
    'totp',
    'recovery',
    'recovery_code',
    'apikey',
    'api_key',
    'authorization',
    'authorisation',
    'cookie',
    'session_id',
    'sessionid',
    'password_hash',
  ])('rejects a top-level key named "%s"', (key) => {
    expect(() => assertNoSecretLikeKeys({ [key]: 'x' })).toThrow(AuditSecretKeyError)
  })

  it('rejects a secret-shaped key at any nesting depth', () => {
    expect(() => assertNoSecretLikeKeys({ a: { b: { c: { token: 'x' } } } })).toThrow(
      AuditSecretKeyError,
    )
  })

  it('rejects a secret-shaped key inside an array of objects', () => {
    expect(() => assertNoSecretLikeKeys({ items: ['ok', { password: 'x' }] })).toThrow(
      AuditSecretKeyError,
    )
  })

  it('names the offending path and key in the error', () => {
    try {
      assertNoSecretLikeKeys({ user: { password: 'x' } })
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AuditSecretKeyError)
      expect((error as AuditSecretKeyError).key).toBe('password')
      expect((error as AuditSecretKeyError).path).toBe('$.user')
    }
  })

  it('does not reject an unrelated key that merely contains a similar substring in its value', () => {
    // The pattern matches KEY NAMES, not values — a value happening to look
    // like a token is not itself a secret leak of the key/value pair.
    expect(() => assertNoSecretLikeKeys({ note: 'the token was expired' })).not.toThrow()
  })
})
