import { isIPv4, isIPv6 } from 'node:net'
import { AuditCanonicalizationError } from './canonical.ts'

/*
 * IP address normalisation for the audit chain. ADR-0020 §4:
 *
 *   "ip is text rather than inet ... the application must therefore render
 *    addresses normatively before hashing: lowercase, RFC 5952 IPv6
 *    compression, and IPv4-mapped addresses written in dotted-quad form."
 *
 * This is the database-side backstop `inet` would have given for free,
 * rebuilt here because `inet`'s own normalisation was rejected for silently
 * collapsing distinguishable addresses (203.0.113.7 and ::ffff:203.0.113.7)
 * to one stored form. The rule this file enforces is narrower and stated:
 * ONE textual input shape maps to ONE canonical string, so a writer and a
 * verifier reading the same stored value never disagree about its bytes.
 *
 * Deliberately no third-party dependency: ADR-0013's module-graph rules
 * confine `pg`/network libraries to this package already, and RFC 5952's
 * compression rule is small enough to state exactly rather than pull in a
 * library whose own canonicalisation choices would need auditing.
 */

/**
 * `audit_log_ip_bounded`'s own floor: `length(ip) BETWEEN 3 AND 45`. Rejected
 * here too, with a clear message, rather than left to surface as an opaque
 * CHECK violation mid-transaction.
 */
const MIN_LENGTH = 3
const MAX_LENGTH = 45

/**
 * Reject anything that is not a syntactically valid, unscoped IPv4 or IPv6
 * address — EXCEPT a zone ID, which returns `null` rather than throwing.
 *
 * Zone IDs (RFC 4007), e.g. "fe80::1%eth0": `node:net`'s isIPv6 accepts them,
 * and the naive expansion this file used to do would silently DROP the
 * suffix rather than reject it — measured: `parseInt("1%eth0", 16)` stops at
 * the first invalid character and returns 1, so "fe80::1%eth0" normalised to
 * "fe80::1" with no error. A zone ID names a LOCAL interface and has no
 * meaning once written into a record read back on a different host, so it
 * cannot be represented — but `recordAudit` runs inside the caller's
 * business transaction (a sale, a login), and a real, legitimately-scoped
 * link-local address arriving from a proxy is far more likely in production
 * than the deliberately-malformed inputs the other branches below reject.
 * THROWING HERE WOULD ABORT THE BUSINESS OPERATION over an IP address
 * formatting detail nobody who approved the sale can see or fix. `null`
 * — "no meaningful client address for this event", the same outcome as an
 * omitted `ip` — is the caller-safe answer; the other rejections below stay
 * hard failures because they indicate a genuinely malformed value, not a
 * legitimate address this format cannot carry.
 */
export function normalizeIp(raw: string): string | null {
  const trimmed = raw.trim()

  // Only a genuine zone ID short-circuits to null: the part BEFORE the "%"
  // must itself be a syntactically valid IPv6 address. `'%s%s%s%n'` and
  // similar garbage also contain "%" and must still fall through to the
  // ordinary rejection below, not be waved through as "maybe scoped".
  const zoneIdSplit = trimmed.indexOf('%')
  if (zoneIdSplit !== -1 && isIPv6(trimmed.slice(0, zoneIdSplit))) {
    return null
  }

  const normalized = isIPv4(trimmed)
    ? normalizeIPv4(trimmed)
    : isIPv6(trimmed)
      ? normalizeIPv6(trimmed)
      : null

  if (normalized === null) {
    throw new AuditCanonicalizationError(
      `"${raw}" is not a syntactically valid IPv4 or IPv6 address and cannot be hashed into the audit chain.`,
    )
  }

  if (normalized.length < MIN_LENGTH || normalized.length > MAX_LENGTH) {
    // Reachable today only by the IPv6 unspecified address ("::", 2
    // characters) — shorter than audit_log_ip_bounded's floor of 3. There is
    // no meaningful "audience" for the unspecified address as a client
    // identifier; pass null instead.
    throw new AuditCanonicalizationError(
      `"${raw}" normalises to "${normalized}" (${normalized.length} characters), outside ` +
        `audit_log_ip_bounded's ${MIN_LENGTH}-${MAX_LENGTH} character bound. Pass null if there is no ` +
        'meaningful client address for this event.',
    )
  }

  return normalized
}

function normalizeIPv4(ip: string): string {
  // Dotted-quad, decimal, no leading zeros (net.isIPv4 already rejects an
  // octet like "01" as invalid, so this is normalising case/whitespace only —
  // there is none left after Number(...).toString(), which is the point).
  return ip
    .split('.')
    .map((octet) => Number(octet).toString())
    .join('.')
}

/** Expand any legal textual IPv6 form (with or without `::`, with or without an embedded IPv4 tail) to 8 groups. */
function expandIPv6(ip: string): number[] {
  let head = ip
  let ipv4Tail: [number, number] | null = null

  const ipv4Match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip)
  if (ipv4Match) {
    const quad = ipv4Match[1] ?? ''
    const [a, b, c, d] = quad.split('.').map(Number)
    ipv4Tail = [((a ?? 0) << 8) | (b ?? 0), ((c ?? 0) << 8) | (d ?? 0)]
    head = ip.slice(0, ip.length - quad.length).replace(/:$/, '')
  }

  const knownGroupCount = ipv4Tail ? 2 : 0
  const doubleColon = head.split('::')

  if (doubleColon.length > 2) {
    throw new AuditCanonicalizationError(`"${ip}" contains more than one "::"`)
  }

  if (doubleColon.length === 2) {
    const left = doubleColon[0] === '' ? [] : doubleColon[0]!.split(':').map((h) => parseInt(h, 16))
    const right =
      doubleColon[1] === '' ? [] : doubleColon[1]!.split(':').map((h) => parseInt(h, 16))
    const fillCount = 8 - knownGroupCount - left.length - right.length
    if (fillCount < 0) {
      throw new AuditCanonicalizationError(`"${ip}" expands to more than 8 groups`)
    }
    const groups = [...left, ...new Array(fillCount).fill(0), ...right]
    return ipv4Tail ? [...groups.slice(0, 6), ipv4Tail[0], ipv4Tail[1]] : groups
  }

  // No "::" — every group must be present explicitly.
  const groups = head === '' ? [] : head.split(':').map((h) => parseInt(h, 16))
  const full = ipv4Tail ? [...groups, ipv4Tail[0], ipv4Tail[1]] : groups
  if (full.length !== 8) {
    throw new AuditCanonicalizationError(
      `"${ip}" does not expand to exactly 8 groups (got ${full.length})`,
    )
  }
  return full
}

/**
 * RFC 5952 canonical text form: lowercase hex, no leading zeros per group,
 * the single LONGEST run of two-or-more consecutive zero groups compressed
 * to "::" (leftmost run wins a tie — RFC 5952 §4.2.3), and no compression at
 * all if no run reaches length 2.
 */
function compressIPv6(groups: readonly number[]): string {
  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  let runLength = 0

  for (let i = 0; i <= groups.length; i += 1) {
    const isZero = i < groups.length && groups[i] === 0
    if (isZero) {
      if (runStart === -1) runStart = i
      runLength += 1
    } else {
      if (runLength > bestLength) {
        bestStart = runStart
        bestLength = runLength
      }
      runStart = -1
      runLength = 0
    }
  }

  if (bestLength < 2) {
    return groups.map((g) => g.toString(16)).join(':')
  }

  const before = groups.slice(0, bestStart).map((g) => g.toString(16))
  const after = groups.slice(bestStart + bestLength).map((g) => g.toString(16))
  return `${before.join(':')}::${after.join(':')}`
}

function normalizeIPv6(ip: string): string {
  const groups = expandIPv6(ip)

  // RFC 5952 §5: an IPv4-mapped address (the last 32 bits following
  // ::ffff:0:0) is written with the trailing two groups in dotted-quad form.
  const isIPv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff

  if (isIPv4Mapped) {
    const quad = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.')
    return `::ffff:${quad}`
  }

  return compressIPv6(groups)
}
