import { describe, expect, it } from 'vitest'
import { AuditCanonicalizationError } from './canonical.ts'
import { normalizeIp } from './ip.ts'

describe('normalizeIp — IPv4', () => {
  it('passes a plain dotted-quad through unchanged', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7')
  })

  it('trims whitespace', () => {
    expect(normalizeIp('  203.0.113.7  ')).toBe('203.0.113.7')
  })
})

describe('normalizeIp — IPv6, ADR-0020 §4 examples', () => {
  it('compresses the longest run of zero groups: 2001:db8:0:0:0:0:0:1 -> 2001:db8::1', () => {
    expect(normalizeIp('2001:db8:0:0:0:0:0:1')).toBe('2001:db8::1')
  })

  it('is idempotent on an already-compressed address', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1')
  })

  it('lowercases hex digits', () => {
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1')
  })

  it('rejects the unspecified address (normalises to "::", too short for audit_log_ip_bounded)', () => {
    expect(() => normalizeIp('0:0:0:0:0:0:0:0')).toThrow(AuditCanonicalizationError)
    expect(() => normalizeIp('::')).toThrow(AuditCanonicalizationError)
  })

  it('renders loopback as ::1, not compressing a run of length 1', () => {
    expect(normalizeIp('0:0:0:0:0:0:0:1')).toBe('::1')
  })

  it('does not compress a single zero group (RFC 5952: run must be >= 2)', () => {
    expect(normalizeIp('2001:db8:0:1:2:3:4:5')).toBe('2001:db8:0:1:2:3:4:5')
  })

  it('picks the leftmost run when two runs tie in length', () => {
    // Two runs of length 2: groups[1..2] and groups[5..6].
    expect(normalizeIp('1:0:0:2:3:0:0:4')).toBe('1::2:3:0:0:4')
  })

  it('picks the longer run over an earlier shorter one', () => {
    expect(normalizeIp('1:0:2:0:0:0:3:4')).toBe('1:0:2::3:4')
  })

  it('renders an IPv4-mapped address in dotted-quad form (RFC 5952 §5)', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
    expect(normalizeIp('0:0:0:0:0:ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
  })

  it('expands and recompresses a fully-written address with a leading zero group', () => {
    expect(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
  })

  it('handles "::" at the start and end', () => {
    expect(normalizeIp('::1:2:3')).toBe('::1:2:3')
    expect(normalizeIp('1:2:3::')).toBe('1:2:3::')
  })
})

describe('normalizeIp — rejects garbage rather than silently accepting it', () => {
  it.each(['not-an-ip', '<script>x</script>', '%s%s%s%n', '999.999.999.999', '1:2:3'])(
    'rejects %s',
    (value) => {
      expect(() => normalizeIp(value)).toThrow(AuditCanonicalizationError)
    },
  )
})

describe('normalizeIp — findings from Database Guardian review', () => {
  it('rejects a zone ID rather than silently dropping it', () => {
    // node:net's isIPv6 accepts "fe80::1%eth0"; the naive expander used to
    // call parseInt("1%eth0", 16), which stops at the first invalid
    // character and returns 1 — silently normalising to "fe80::1" with the
    // scope information gone. Now rejected outright.
    expect(() => normalizeIp('fe80::1%eth0')).toThrow(/zone ID/)
  })

  it('rejects the unspecified address "::" — shorter than audit_log_ip_bounded allows', () => {
    // "::" is 2 characters; audit_log_ip_bounded requires 3-45. There is no
    // meaningful audience for the unspecified address as a client identifier.
    expect(() => normalizeIp('::')).toThrow(AuditCanonicalizationError)
  })
})
