import { createHash, randomBytes } from 'node:crypto'

/*
 * Refresh token minting. ADR-0009:24 (~14 days), ADR-0021 condition 5.
 *
 * ADR-0021's `rt_token_hash_key` exemption is "invalid until" a test exists
 * "over the PRODUCTION MINTER... full-length, from a CSPRNG, no truncation,
 * no derivation from caller-influenced input, and no fixture standing in
 * for the production code path" — this function IS that minter, and
 * packages/auth/src/refresh-token.spec.ts is the test that covers it.
 *
 * `node:crypto.randomBytes` is the platform CSPRNG. 32 bytes = 256 bits,
 * hex-encoded for the raw value (64 hex characters, matching the cookie and
 * the shape the throttle key logs), SHA-256 hex for storage — never the raw
 * value, per ADR-0009:85 and migration 005's own `rt_hash_shape` CHECK
 * (`^[0-9a-f]{64}$`).
 */

const REFRESH_TOKEN_BYTES = 32
export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface MintedRefreshToken {
  /** The bearer value. Goes in the cookie and nowhere else — never logged, never stored. */
  readonly raw: string
  /** SHA-256 hex digest of `raw`. What actually reaches the database. */
  readonly hash: string
  readonly expiresAt: Date
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function mintRefreshToken(now: Date = new Date()): MintedRefreshToken {
  const raw = randomBytes(REFRESH_TOKEN_BYTES).toString('hex')
  return {
    raw,
    hash: hashRefreshToken(raw),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
  }
}
