import { describe, expect, it } from 'vitest'
import { hashRefreshToken, mintRefreshToken } from './refresh-token.ts'

/*
 * ADR-0021 condition 5: "the rt_token_hash_key allowlist entry is invalid
 * until [a test over the production minter] exists" — full-length, from a
 * CSPRNG, no truncation, no derivation from caller-influenced input, and no
 * fixture standing in for the production code path. This IS that test: it
 * calls `mintRefreshToken` itself, the exact function `packages/auth`'s
 * login and refresh flows call, not a stand-in.
 */
describe('mintRefreshToken (the production minter ADR-0021 condition 5 requires)', () => {
  it('produces a full-length 256-bit value with no truncation', () => {
    const { raw } = mintRefreshToken()
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes to a full-length SHA-256 digest matching rt_hash_shape (^[0-9a-f]{64}$)', () => {
    const { raw, hash } = mintRefreshToken()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashRefreshToken(raw))
  })

  it('never repeats across many calls — no derivation from a shared or caller-influenced seed', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const { raw } = mintRefreshToken()
      expect(seen.has(raw), `duplicate raw token at call ${i}`).toBe(false)
      seen.add(raw)
    }
  })

  it('takes no arguments a caller could use to influence the value', () => {
    // mintRefreshToken() is nullary. A caller-supplied seed, timestamp or id
    // would be exactly the "derivation from caller-influenced input"
    // ADR-0021 condition 5 forbids; the type signature makes it impossible.
    expect(mintRefreshToken.length).toBe(0)
  })

  it('is not merely random-looking: every byte position varies across samples', () => {
    // A weak PRNG or a truncated/padded value can still look random at a
    // glance while having a fixed prefix or suffix. Sample a modest number
    // of tokens and assert every hex character POSITION takes more than one
    // distinct value somewhere in the sample.
    const samples = Array.from({ length: 200 }, () => mintRefreshToken().raw)
    for (let position = 0; position < 64; position++) {
      const valuesAtPosition = new Set(samples.map((s) => s[position]))
      expect(
        valuesAtPosition.size,
        `hex position ${position} never varied across ${samples.length} samples`,
      ).toBeGreaterThan(1)
    }
  })
})
