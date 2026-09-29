import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { getLogger } from '@finsoft/observability'

/*
 * Client IP and device-fingerprint extraction. ADR-0023 §5. Security
 * re-review findings B3, C7 (2026-09-27) folded in.
 *
 * DEPLOYMENT TOPOLOGY THIS ASSUMES: exactly one reverse proxy (Caddy),
 * configured with no `trusted_proxies` directive of its own — Caddy's
 * default behaviour in that configuration is to overwrite `X-Forwarded-For`
 * with the single address of whoever connected to it, discarding whatever a
 * client sent. So the header this process receives should always carry
 * EXACTLY ONE entry, and that entry IS the real client. `AUTH_TRUSTED_PROXY_
 * COUNT` (default 1) is Caddy's own hop count in this topology.
 *
 * "Take the Nth-from-the-right entry for a configured N. Never the
 * leftmost, never a framework's req.ip default." The trustworthy entry is
 * `parts[length - n]` — the one APPENDED (or, in this topology, written) by
 * the Nth trusted hop counting inward from the end of the chain. If a
 * client sends its OWN `X-Forwarded-For` with fabricated entries and Caddy
 * is ever reconfigured to append rather than overwrite, this formula still
 * ignores every attacker-supplied entry to its left and reads only the
 * value the trusted hop itself wrote.
 */

function trustedProxyCount(): number {
  const raw = process.env['AUTH_TRUSTED_PROXY_COUNT']
  const n = raw ? Number(raw) : 1
  return Number.isInteger(n) && n >= 0 ? n : 1
}

/**
 * The address the Nth trusted proxy actually appended — validated with
 * `net.isIP`, NEVER falling back to the raw socket address when the header
 * is present but its trusted position does not hold a valid IP (B3: "never
 * fall back to Caddy's socket address silently"). A genuinely absent header
 * — no reverse proxy at all, e.g. a direct connection in local dev — is a
 * different case and falls back to the socket address, logged at `warn`
 * rather than silently, so the fallback is visible in any environment where
 * it is unexpected.
 */
export function clientIp(req: Request): string {
  const header = req.headers['x-forwarded-for']

  if (header !== undefined) {
    const chain = Array.isArray(header) ? header.join(',') : header
    const parts = chain
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const n = trustedProxyCount()
    const index = parts.length - n
    const candidate = index >= 0 ? parts[index] : undefined

    if (candidate !== undefined && isIP(candidate) !== 0) {
      return candidate
    }

    // The header is present but does not hold a valid IP at the trusted
    // position — a misconfiguration (wrong AUTH_TRUSTED_PROXY_COUNT) or a
    // client attempting to shape the header. Either way this is NOT the
    // silent fallback B3 forbids: it is logged, and rate limiting /
    // sessions.ip fall back to the raw socket peer (Caddy's own address in
    // production, which at worst throttles/attributes traffic to the proxy
    // rather than trusting attacker-controlled input).
    getLogger().warn(
      { xForwardedFor: chain, trustedProxyCount: n },
      'X-Forwarded-For present but invalid at the trusted position; falling back to the socket peer',
    )
  }

  return req.socket.remoteAddress ?? '0.0.0.0'
}

/*
 * IPv4: the whole address (a v4 address has no meaningful prefix to drop —
 * ADR-0023 §5 calls this "/32 v4"). IPv6: the first 64 bits (4 of the 8
 * groups), computed from the FULLY EXPANDED address, not by truncating the
 * compressed text form. `2001:db8::1` truncated as TEXT at "the first four
 * groups" reads as `2001:db8::1` unchanged (there is no fourth group to cut
 * at); two addresses that share a /64 but compress differently would then
 * be treated as different prefixes, and a single address like `::1` would
 * truncate to nothing useful at all. Expanding first makes the prefix a
 * property of the ADDRESS, not of how it happened to be written (C7).
 */
function expandIPv6(address: string): readonly string[] {
  const withoutZone = address.split('%')[0] ?? address
  const [head, tail] = withoutZone.split('::')

  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []

  // An IPv4-mapped tail group (`::ffff:1.2.3.4`) counts as two 16-bit groups.
  const expand = (groups: readonly string[]): string[] =>
    groups.flatMap((g) => (g.includes('.') ? ipv4ToHextets(g) : [g]))

  const head16 = expand(headGroups)
  const tail16 = expand(tailGroups)

  if (!withoutZone.includes('::')) {
    return head16
  }

  const missing = 8 - head16.length - tail16.length
  return [...head16, ...Array(Math.max(missing, 0)).fill('0'), ...tail16]
}

function ipv4ToHextets(ipv4: string): string[] {
  const octets = ipv4.split('.').map(Number)
  const a = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0)
  const b = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
  return [a.toString(16), b.toString(16)]
}

export function ipPrefix(ip: string): string {
  if (isIP(ip) === 6) {
    const groups = expandIPv6(ip)
    // Zero-padded so the prefix is canonical regardless of how the source
    // address happened to be written (leading zeros dropped or not).
    return groups
      .slice(0, 4)
      .map((g) => g.padStart(4, '0'))
      .join(':')
  }
  return ip
}

/**
 * A device fingerprint, opaque to the database (`sessions.device_id`'s own
 * comment). This is NOT a security boundary — ADR-0022 explicitly rejects
 * trusting it to distinguish a legitimate device from an attacker's — it is
 * diagnostic metadata only, useful for an admin's "which of my devices is
 * this" list.
 */
export function deviceFingerprint(req: Request): string {
  const userAgent = req.headers['user-agent'] ?? ''
  return createHash('sha256').update(userAgent).digest('hex').slice(0, 32)
}
