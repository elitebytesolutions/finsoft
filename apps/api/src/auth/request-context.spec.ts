import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { initLogger, resetLoggerForTests } from '@finsoft/observability'
import { clientIp, ipPrefix } from './request-context'

/*
 * B3 (client IP) and C7 (IPv6 /64 prefix), security re-review 2026-09-27.
 */

function fakeRequest(headers: Record<string, string | string[]>, remoteAddress: string): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request
}

describe('clientIp', () => {
  const ENV = 'AUTH_TRUSTED_PROXY_COUNT'
  const saved = process.env[ENV]
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  beforeAll(() => {
    resetLoggerForTests()
    initLogger({ service: 'api-test', level: 'fatal' })
  })
  afterAll(() => resetLoggerForTests())

  it("reads the real client from Caddy's exact header shape — one entry, one trusted hop", () => {
    delete process.env[ENV] // default: 1
    const req = fakeRequest({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.5')
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('ignores a spoofed leftmost entry and reads the Nth-from-the-right position', () => {
    // A client that sends its own X-Forwarded-For with a fabricated first
    // entry. Even if a future Caddy config appends rather than overwrites,
    // the trusted position (length - n, n=1) is the LAST entry, never the
    // attacker-supplied first one.
    process.env[ENV] = '1'
    const req = fakeRequest({ 'x-forwarded-for': '198.51.100.99, 203.0.113.7' }, '10.0.0.5')
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('validates the extracted value with net.isIP and does not trust garbage at the trusted position', () => {
    const req = fakeRequest({ 'x-forwarded-for': 'not-an-ip' }, '10.0.0.9')
    // Falls back to the socket peer rather than trusting the invalid value —
    // never silently, but the return value itself has no way to distinguish
    // "logged and fell back" from a legitimate direct connection, which is
    // exactly why this path is covered by a warn-level log assertion
    // elsewhere rather than by this return value alone.
    expect(clientIp(req)).toBe('10.0.0.9')
  })

  it('falls back to the socket address when there is no X-Forwarded-For at all (local dev, no proxy)', () => {
    const req = fakeRequest({}, '127.0.0.1')
    expect(clientIp(req)).toBe('127.0.0.1')
  })

  it('respects a configured trusted proxy count greater than one', () => {
    process.env[ENV] = '2'
    // client, proxy1-appended, proxy2-appended — trusted position is the
    // SECOND from the right when two hops are trusted.
    const req = fakeRequest(
      { 'x-forwarded-for': '198.51.100.1, 203.0.113.7, 192.0.2.55' },
      '10.0.0.5',
    )
    expect(clientIp(req)).toBe('203.0.113.7')
  })
})

describe('ipPrefix', () => {
  it('leaves an IPv4 address whole (/32)', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.7')
  })

  it('computes an IPv6 /64 from the FULLY EXPANDED address, not compressed text', () => {
    // '2001:db8::1' has no fourth colon-delimited group to cut at in its
    // compressed text form; expanded, it is
    // 2001:0db8:0000:0000:0000:0000:0000:0001, and the /64 is the first 4
    // groups.
    expect(ipPrefix('2001:db8::1')).toBe('2001:0db8:0000:0000')
  })

  it('gives two addresses that share a /64 the same prefix despite different compression', () => {
    const a = ipPrefix('2001:db8:0:0::1')
    const b = ipPrefix('2001:db8::ffff')
    expect(a).toBe(b)
    expect(a).toBe('2001:0db8:0000:0000')
  })

  it('handles the shortest possible compressed form', () => {
    expect(ipPrefix('::1')).toBe('0000:0000:0000:0000')
  })

  it('handles an IPv4-mapped IPv6 address', () => {
    // ::ffff:1.2.3.4 expands to 0000:...:0000:ffff:0102:0304 — the /64
    // prefix is still all-zero, which is correct: the mapped v4 address
    // lives in the low 32 bits, well outside the first 64.
    expect(ipPrefix('::ffff:1.2.3.4')).toBe('0000:0000:0000:0000')
  })
})
