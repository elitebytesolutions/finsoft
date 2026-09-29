import { describe, expect, it } from 'vitest'
import { isWellFormedRequestId, resolveRequestId } from './request-id.ts'

/* M1-C: the header is trusted only when it is already a well-formed UUID. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('isWellFormedRequestId', () => {
  it('accepts a v4 UUID', () => {
    expect(isWellFormedRequestId('9f8e7d6c-5b4a-4321-9876-543210fedcba')).toBe(true)
  })

  it('accepts a UUID of another RFC 4122 version (e.g. v1)', () => {
    // Not the shape this process mints, but still a genuine correlation id
    // an upstream caller may hand in — see request-id.ts's header comment.
    expect(isWellFormedRequestId('9f8e7d6c-5b4a-1321-8876-543210fedcba')).toBe(true)
  })

  it('accepts uppercase hex', () => {
    expect(isWellFormedRequestId('9F8E7D6C-5B4A-4321-9876-543210FEDCBA')).toBe(true)
  })

  it('rejects a non-UUID string', () => {
    expect(isWellFormedRequestId('not-a-uuid')).toBe(false)
  })

  it('rejects a UUID with extra trailing characters (anchored match)', () => {
    expect(isWellFormedRequestId('9f8e7d6c-5b4a-4321-9876-543210fedcba-extra')).toBe(false)
  })

  it('rejects a UUID embedded inside a longer string', () => {
    expect(isWellFormedRequestId('prefix 9f8e7d6c-5b4a-4321-9876-543210fedcba suffix')).toBe(false)
  })

  it('rejects an oversized string', () => {
    expect(isWellFormedRequestId('a'.repeat(10_000))).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isWellFormedRequestId('')).toBe(false)
  })

  it('rejects an array (a repeated header)', () => {
    expect(isWellFormedRequestId(['9f8e7d6c-5b4a-4321-9876-543210fedcba', 'second-value'])).toBe(
      false,
    )
  })

  it('rejects undefined', () => {
    expect(isWellFormedRequestId(undefined)).toBe(false)
  })

  it('rejects a non-string type smuggled through', () => {
    expect(isWellFormedRequestId(12345)).toBe(false)
  })
})

describe('resolveRequestId', () => {
  it('adopts a well-formed inbound id, lowercased', () => {
    const inbound = '9F8E7D6C-5B4A-4321-9876-543210FEDCBA'
    expect(resolveRequestId(inbound)).toBe('9f8e7d6c-5b4a-4321-9876-543210fedcba')
  })

  it('mints a fresh UUID when the header is absent', () => {
    const id = resolveRequestId(undefined)
    expect(id).toMatch(UUID_RE)
  })

  it('mints a fresh UUID when the header is malformed', () => {
    const id = resolveRequestId('; DROP TABLE audit_log; --')
    expect(id).toMatch(UUID_RE)
  })

  it('mints a fresh UUID when the header is oversized', () => {
    const id = resolveRequestId('a'.repeat(10_000))
    expect(id).toMatch(UUID_RE)
  })

  it('mints a fresh UUID for a repeated header (array value)', () => {
    const id = resolveRequestId(['9f8e7d6c-5b4a-4321-9876-543210fedcba', 'second'])
    expect(id).toMatch(UUID_RE)
  })

  it('two malformed inputs never collide on the same minted id', () => {
    const a = resolveRequestId('garbage-one')
    const b = resolveRequestId('garbage-two')
    expect(a).not.toBe(b)
  })
})
