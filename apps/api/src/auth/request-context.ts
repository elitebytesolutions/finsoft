import type { Request } from 'express'
import { createHash } from 'node:crypto'

/*
 * Client IP and device-fingerprint extraction. ADR-0023 §5.
 *
 * "Take the Nth-from-the-right entry for a configured N. Never the
 * leftmost, never a framework's req.ip default. Leftmost parsing gives an
 * attacker an unbounded key space AND the ability to spend a victim's
 * budget by spoofing their address."
 */

function trustedProxyCount(): number {
  const raw = process.env['AUTH_TRUSTED_PROXY_COUNT']
  const n = raw ? Number(raw) : 1
  return Number.isInteger(n) && n >= 0 ? n : 1
}

/** The address the Nth trusted proxy actually appended — never attacker-chosen. */
export function clientIp(req: Request): string {
  const header = req.headers['x-forwarded-for']
  const chain = Array.isArray(header) ? header.join(',') : (header ?? '')
  const parts = chain
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const n = trustedProxyCount()
  if (parts.length > n) {
    // Nth-from-the-right: index (length - 1 - n).
    const candidate = parts[parts.length - 1 - n]
    if (candidate) return candidate
  }

  return req.socket.remoteAddress ?? '0.0.0.0'
}

/** /32 for v4 (the whole address — a v4 address has no prefix to drop), /64 for v6. */
export function ipPrefix(ip: string): string {
  if (ip.includes(':')) {
    const groups = ip.split(':')
    return groups.slice(0, 4).join(':')
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
