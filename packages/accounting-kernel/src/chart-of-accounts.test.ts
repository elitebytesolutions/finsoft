import { describe, expect, it } from 'vitest'
import { PostingError } from './errors.ts'
import {
  assertCodeInBlock,
  assertNameValid,
  deriveNormalBalance,
  validateCreatePayload,
  validateUpdatePayload,
} from './chart-of-accounts.ts'

/*
 * Pure unit tests — no database, matching kernel.test.ts's own precedent.
 * DB-touching behaviour (create/update against real accounts, protected-row
 * refusal, ACCOUNT_HAS_POSTINGS under lock, version conflicts, audit rows,
 * tenant isolation, RBAC) is proven in tests/integration/accounts.spec.ts.
 */

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof PostingError) return error.code
    throw error
  }
  return 'NO ERROR'
}

describe('deriveNormalBalance (coa-standard.md §8.1)', () => {
  it.each([
    ['ASSET', 'DEBIT'],
    ['EXPENSE', 'DEBIT'],
    ['LIABILITY', 'CREDIT'],
    ['EQUITY', 'CREDIT'],
    ['INCOME', 'CREDIT'],
  ])('%s -> %s', (type, expected) => {
    expect(deriveNormalBalance(type)).toBe(expected)
  })
})

describe('assertCodeInBlock (coa-standard.md §8.1)', () => {
  it('accepts a code in the parent header block', () => {
    expect(() => assertCodeInBlock('6600', '6000')).not.toThrow()
    expect(() => assertCodeInBlock('1400', '1000')).not.toThrow()
  })

  it.each(['66A0', '660', '66000', '0600', 'abcd', ''])(
    'rejects malformed code %j: ACCOUNT_CODE_FORMAT',
    (code) => {
      expect(codeOf(() => assertCodeInBlock(code, '6000'))).toBe('ACCOUNT_CODE_FORMAT')
    },
  )

  it('rejects a code outside the parent block: ACCOUNT_CODE_OUT_OF_RANGE', () => {
    expect(codeOf(() => assertCodeInBlock('1400', '6000'))).toBe('ACCOUNT_CODE_OUT_OF_RANGE')
  })

  it('rejects the header code itself: ACCOUNT_CODE_OUT_OF_RANGE', () => {
    expect(codeOf(() => assertCodeInBlock('6000', '6000'))).toBe('ACCOUNT_CODE_OUT_OF_RANGE')
  })
})

describe('assertNameValid (coa-standard.md §8.1)', () => {
  it('trims and accepts a valid name', () => {
    expect(assertNameValid('  Security Services  ')).toBe('Security Services')
  })

  it('rejects empty after trimming: ACCOUNT_NAME_INVALID', () => {
    expect(codeOf(() => assertNameValid('   '))).toBe('ACCOUNT_NAME_INVALID')
  })

  it('rejects a name over 200 characters: ACCOUNT_NAME_INVALID', () => {
    expect(codeOf(() => assertNameValid('x'.repeat(201)))).toBe('ACCOUNT_NAME_INVALID')
  })

  it('accepts exactly 200 characters', () => {
    expect(() => assertNameValid('x'.repeat(200))).not.toThrow()
  })
})

describe('validateCreatePayload shape (coa-standard.md §8.9)', () => {
  it('accepts the three known keys', () => {
    const result = validateCreatePayload({ parentId: 'p', name: 'n', code: 'c' })
    expect(result).toEqual({ parentId: 'p', name: 'n', code: 'c' })
  })

  it('rejects a non-object payload: PAYLOAD_INVALID', () => {
    expect(codeOf(() => validateCreatePayload('not an object'))).toBe('PAYLOAD_INVALID')
    expect(codeOf(() => validateCreatePayload(null))).toBe('PAYLOAD_INVALID')
    expect(codeOf(() => validateCreatePayload(['array']))).toBe('PAYLOAD_INVALID')
  })

  it('rejects an unknown key: PAYLOAD_INVALID (never silently ignored)', () => {
    expect(
      codeOf(() =>
        validateCreatePayload({ parentId: 'p', name: 'n', code: 'c', controlKind: 'AR' }),
      ),
    ).toBe('PAYLOAD_INVALID')
  })

  it('rejects an opening balance field: PAYLOAD_INVALID (§8.1: never collected by create)', () => {
    expect(
      codeOf(() =>
        validateCreatePayload({ parentId: 'p', name: 'n', code: 'c', openingBalance: '100.00' }),
      ),
    ).toBe('PAYLOAD_INVALID')
  })
})

describe('validateUpdatePayload shape (coa-standard.md §8.2/§8.9)', () => {
  it('accepts the editable keys with a valid expectedVersion', () => {
    const result = validateUpdatePayload({ name: 'n', expectedVersion: 0 })
    expect(result.name).toBe('n')
    expect(result.expectedVersion).toBe(0)
  })

  it('requires expectedVersion: PAYLOAD_INVALID when missing', () => {
    expect(codeOf(() => validateUpdatePayload({ name: 'n' }))).toBe('PAYLOAD_INVALID')
  })

  it('rejects a negative or non-integer expectedVersion: PAYLOAD_INVALID', () => {
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: -1 }))).toBe('PAYLOAD_INVALID')
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: 1.5 }))).toBe('PAYLOAD_INVALID')
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: '0' }))).toBe('PAYLOAD_INVALID')
  })

  it('rejects a non-editable field (type, controlKind, isActive): PAYLOAD_INVALID', () => {
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: 0, type: 'ASSET' }))).toBe(
      'PAYLOAD_INVALID',
    )
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: 0, controlKind: 'AR' }))).toBe(
      'PAYLOAD_INVALID',
    )
    expect(codeOf(() => validateUpdatePayload({ expectedVersion: 0, isActive: false }))).toBe(
      'PAYLOAD_INVALID',
    )
  })
})
