import { describe, expect, it } from 'vitest'
import { rawSearchParam, safeNextPath } from '@/lib/api/safe-next-path'

/*
 * The open-redirect gate on `?next=` (security review, this task): the login
 * screen's "already signed in" redirect and the silent-refresh-on-load path
 * both hand `next` to the router unchecked before this existed. Every case
 * here is a string an attacker could put in a link; none of them may reach
 * `navigate()` unmodified.
 */

describe('safeNextPath', () => {
  it('falls back to /dashboard when next is absent', () => {
    expect(safeNextPath(null)).toBe('/dashboard')
    expect(safeNextPath(undefined)).toBe('/dashboard')
    expect(safeNextPath('')).toBe('/dashboard')
  })

  it('accepts a valid same-origin relative path', () => {
    expect(safeNextPath('/customers')).toBe('/customers')
  })

  it('accepts a valid path carrying its own query string', () => {
    expect(safeNextPath('/reports/trial-balance?x=1')).toBe('/reports/trial-balance?x=1')
  })

  it('rejects an absolute URL to another origin', () => {
    expect(safeNextPath('https://evil.example/login')).toBe('/dashboard')
  })

  it('rejects a protocol-relative URL', () => {
    expect(safeNextPath('//evil.example')).toBe('/dashboard')
  })

  it('rejects a leading-slash-backslash path (browsers treat \\ as /)', () => {
    expect(safeNextPath('/\\evil')).toBe('/dashboard')
  })

  it('rejects a bare double-backslash path', () => {
    expect(safeNextPath('\\\\evil')).toBe('/dashboard')
  })

  it('rejects a javascript: scheme with no leading slash at all', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe('/dashboard')
  })

  it('rejects a percent-encoded protocol-relative URL, decoded once', () => {
    expect(safeNextPath('%2F%2Fevil')).toBe('/dashboard')
  })

  it('rejects a percent-encoded backslash after a real leading slash', () => {
    expect(safeNextPath('/%5Cevil')).toBe('/dashboard')
  })

  it('rejects a doubly-encoded payload (one decode pass leaves it unresolved, not "//")', () => {
    // %2525 -> %25 -> '%'; the result never starts with '/', so it is
    // rejected as not-a-path rather than resolved into something dangerous.
    expect(safeNextPath('%252F%252Fevil')).toBe('/dashboard')
  })

  it('rejects a value with an embedded control character', () => {
    expect(safeNextPath('/foo%0Abar')).toBe('/dashboard') // %0A -> \n
    expect(safeNextPath('/foo%00bar')).toBe('/dashboard') // %00 -> NUL
  })

  it('falls back on malformed percent-encoding rather than throwing', () => {
    expect(safeNextPath('/foo%')).toBe('/dashboard')
    expect(() => safeNextPath('/foo%')).not.toThrow()
  })

  it('rejects a path with no leading slash', () => {
    expect(safeNextPath('customers')).toBe('/dashboard')
  })

  it('honours a custom fallback', () => {
    expect(safeNextPath('//evil.example', '/unauthorized')).toBe('/unauthorized')
  })
})

describe('rawSearchParam', () => {
  it('returns the RAW, still-encoded value — never decoded here', () => {
    expect(rawSearchParam('?next=%2F%2Fevil', 'next')).toBe('%2F%2Fevil')
  })

  it('finds the key among several params', () => {
    expect(rawSearchParam('?reason=expired&next=%2Fcustomers&x=1', 'next')).toBe('%2Fcustomers')
  })

  it('returns null when the key is absent', () => {
    expect(rawSearchParam('?reason=expired', 'next')).toBeNull()
    expect(rawSearchParam('', 'next')).toBeNull()
  })

  it('works whether or not the leading "?" is included', () => {
    expect(rawSearchParam('next=%2Fcustomers', 'next')).toBe('%2Fcustomers')
  })

  it('returns the first match for a repeated key, like URLSearchParams.get', () => {
    expect(rawSearchParam('?next=%2Fa&next=%2Fb', 'next')).toBe('%2Fa')
  })

  it('returns an empty string for a key with no value', () => {
    expect(rawSearchParam('?next=&x=1', 'next')).toBe('')
  })
})
