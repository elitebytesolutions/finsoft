import { describe, expect, it } from 'vitest'
import { ControlAccountMisconfiguredError, ControlAccountUnmappedError } from './party-ledger.ts'

/*
 * K5's error shapes — pure, no database. The live behaviour of
 * controlAccountLedger (role resolution against a real chart of accounts,
 * delegating to accountLedger with the party filter) is exercised end to
 * end through GET /api/customers/:id/ledger,
 * tests/integration/customers/customers-api.spec.ts.
 */

describe('ControlAccountUnmappedError', () => {
  it('carries the role and the ACCOUNT_ROLE_UNMAPPED-shaped code', () => {
    const error = new ControlAccountUnmappedError('AR_CONTROL')
    expect(error.code).toBe('ACCOUNT_ROLE_UNMAPPED')
    expect(error.role).toBe('AR_CONTROL')
    expect(error.message).toContain('AR_CONTROL')
  })
})

describe('ControlAccountMisconfiguredError', () => {
  it('carries the role and names the misconfigured account', () => {
    const error = new ControlAccountMisconfiguredError('AR_CONTROL', {
      id: 'x',
      tenantId: 't',
      code: '6100',
      name: 'Rent Expense',
      type: 'EXPENSE',
      normalBalance: 'DEBIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: 'AR_CONTROL',
      restricted: false,
      isActive: true,
      parentId: null,
    })
    expect(error.code).toBe('ACCOUNT_ROLE_MISCONFIGURED')
    expect(error.role).toBe('AR_CONTROL')
    expect(error.message).toContain('6100')
    expect(error.message).toContain('NONE')
  })
})
