import { afterEach, describe, expect, it } from 'vitest'
import { assertProductionCookieSecurity, refreshCookieName, refreshCookiePath } from './cookie'

/*
 * ADR-0023's Open list left the __Host- vs __Secure- choice per environment,
 * but never left "no prefix at all" as an option for production. This is
 * the catalogue-assertion equivalent for that gate: a synchronous function
 * called once at boot (apps/api/src/main.ts), not per request.
 */
describe('assertProductionCookieSecurity', () => {
  const ENV_KEYS = ['NODE_ENV', 'AUTH_REFRESH_COOKIE_NAME', 'AUTH_REFRESH_COOKIE_PATH'] as const
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('does nothing outside production, regardless of cookie name', () => {
    process.env['NODE_ENV'] = 'test'
    delete process.env['AUTH_REFRESH_COOKIE_NAME']
    expect(() => assertProductionCookieSecurity()).not.toThrow()
  })

  it('refuses to start in production with the unprefixed default', () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['AUTH_REFRESH_COOKIE_NAME']
    expect(() => assertProductionCookieSecurity()).toThrow(/neither the __Host- nor the __Secure-/)
  })

  it('refuses to start in production with an explicit unprefixed name', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['AUTH_REFRESH_COOKIE_NAME'] = 'finsoft_rt'
    expect(() => assertProductionCookieSecurity()).toThrow(/finsoft_rt/)
  })

  it('accepts __Host- in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['AUTH_REFRESH_COOKIE_NAME'] = '__Host-finsoft_rt'
    process.env['AUTH_REFRESH_COOKIE_PATH'] = '/'
    expect(() => assertProductionCookieSecurity()).not.toThrow()
  })

  it('accepts __Secure- in production', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['AUTH_REFRESH_COOKIE_NAME'] = '__Secure-finsoft_rt'
    process.env['AUTH_REFRESH_COOKIE_PATH'] = '/api/auth'
    expect(() => assertProductionCookieSecurity()).not.toThrow()
  })
})

describe('refreshCookieName (existing __Host-/path consistency check, exercised at boot too)', () => {
  const ENV_KEYS = ['AUTH_REFRESH_COOKIE_NAME', 'AUTH_REFRESH_COOKIE_PATH'] as const
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('rejects __Host- paired with a non-root path', () => {
    process.env['AUTH_REFRESH_COOKIE_NAME'] = '__Host-finsoft_rt'
    process.env['AUTH_REFRESH_COOKIE_PATH'] = '/api/auth'
    expect(() => refreshCookieName()).toThrow(/requires Path=\//)
  })

  it('accepts __Host- paired with Path=/', () => {
    process.env['AUTH_REFRESH_COOKIE_NAME'] = '__Host-finsoft_rt'
    process.env['AUTH_REFRESH_COOKIE_PATH'] = '/'
    expect(refreshCookieName()).toBe('__Host-finsoft_rt')
    expect(refreshCookiePath()).toBe('/')
  })
})
