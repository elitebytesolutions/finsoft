import { describe, expect, it } from 'vitest'
import { buildTenantCode } from './harness.ts'

/*
 * QA-001. Pins the fix to `createTenantFixture`'s tenant-code construction
 * in harness.ts: codes must be unique by construction, even for a long
 * label under parallel/repeated runs, and the two allowlisted prefixes
 * `tests/accounting/ar-invariant-9.ts` depends on ('TKR', 'TM3RUNNER') must
 * keep being produced exactly as before.
 *
 * No database here — `buildTenantCode` is the pure half of
 * `createTenantFixture`, extracted specifically so this can run 10,000
 * iterations as a fast unit test instead of provisioning 10,000 real
 * tenants.
 */

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/

describe('buildTenantCode', () => {
  it('generates 10,000 codes for a long label with no duplicates', () => {
    // 'GOLDEN_A'/'GOLDEN_B' (golden-posting-runner.ts) and 'M3RUNNER'
    // (golden-posting-runner-m3.spec.ts) are the longest real labels in the
    // suite, each 8 characters — the exact length that used to collapse
    // `unique()`'s random suffix under the old `.slice(0, 16)` truncation.
    const label = 'GOLDEN_A'
    const codes = new Set<string>()

    for (let i = 0; i < 10_000; i++) {
      const code = buildTenantCode(label)
      expect(code).toMatch(CODE_PATTERN)
      codes.add(code)
    }

    expect(codes.size).toBe(10_000)
  })

  it('generates 10,000 codes across several long labels with no cross-label duplicates either', () => {
    const labels = ['GOLDEN_A', 'GOLDEN_B', 'M3RUNNER', 'MAPLAMBDA', 'LONGLABEL123456']
    const codes = new Set<string>()

    for (let i = 0; i < 10_000; i++) {
      const label = labels[i % labels.length] as string
      const code = buildTenantCode(label)
      expect(code).toMatch(CODE_PATTERN)
      codes.add(code)
    }

    expect(codes.size).toBe(10_000)
  })

  it('every generated code matches the tenants.code CHECK constraint', () => {
    // database/migrations/001_create_tenants.sql:
    //   CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$')
    for (const label of ['', 'A', 'KR', 'FIS5', 'GOLDEN_A', 'A_LABEL_LONGER_THAN_SIXTEEN_CHARS']) {
      const code = buildTenantCode(label)
      expect(code).toMatch(CODE_PATTERN)
      expect(code.length).toBeGreaterThanOrEqual(2)
      expect(code.length).toBeLessThanOrEqual(16)
    }
  })

  it("preserves the 'TKR' allowlist prefix for kernel-rules.spec.ts's labels ('KR', 'KR2')", () => {
    // tests/accounting/ar-invariant-9.ts's TEST_ONLY_TENANT_CODE_PREFIXES
    // matches by literal code prefix. These labels are short enough that no
    // truncation budget here could ever touch them, but this pins the
    // behaviour so a future change to the budget cannot silently break it.
    expect(buildTenantCode('KR').startsWith('TKR')).toBe(true)
    expect(buildTenantCode('KR2').startsWith('TKR')).toBe(true)
  })

  it("preserves the 'TM3RUNNER' allowlist prefix for golden-posting-runner-m3.spec.ts's 'M3RUNNER' label, in full", () => {
    // 'M3RUNNER' is 8 characters — exactly TENANT_CODE_LABEL_LIMIT. It must
    // survive WHOLE, unmodified, immediately after the 'T', so the code
    // starts with the full 9-character 'TM3RUNNER' prefix the allowlist
    // checks for. This is the case the old `.slice(0, 16)` truncation broke:
    // it cut into the label's own characters, not just the random suffix.
    const code = buildTenantCode('M3RUNNER')
    expect(code.startsWith('TM3RUNNER')).toBe(true)
    // And nothing of the label itself is lost: the 9th through 16th
    // characters are the uniqueness suffix, not a truncated remainder of
    // the label.
    expect(code.slice(0, 9)).toBe('TM3RUNNER')
  })

  it('truncates a label longer than the budget rather than the suffix, and still matches the CHECK', () => {
    // No real label in the suite is longer than 8 characters today, but the
    // function must still produce a valid, non-colliding code if one ever
    // is — by cutting the label, never the suffix.
    const longLabel = 'THISLABELISWAYTOOLONGFORSIXTEENCHARS'
    const first = buildTenantCode(longLabel)
    const second = buildTenantCode(longLabel)
    expect(first).toMatch(CODE_PATTERN)
    expect(second).toMatch(CODE_PATTERN)
    expect(first).not.toBe(second)
    expect(first.length).toBe(16)
  })
})
