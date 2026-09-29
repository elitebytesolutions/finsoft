import { describe, expect, it } from 'vitest'
import {
  PERMISSION_CODES,
  PRIVILEGED_PERMISSIONS,
  isPermissionCode,
  isPrivileged,
} from './catalog.ts'

describe('the permission catalogue', () => {
  it('is exactly the MVP subset the brief names, no more and no less', () => {
    expect([...PERMISSION_CODES].sort()).toEqual(
      [
        'admin.user_manage',
        'audit.view',
        'customer.create',
        'customer.view',
        'invoice.create',
        'invoice.post',
        'payment.receive',
        'report.financial',
        'voucher.post',
        'voucher.reverse',
        'voucher.view',
      ].sort(),
    )
  })

  it('has no duplicate code', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length)
  })

  it('every code matches the namespace.action shape the database enforces', () => {
    for (const code of PERMISSION_CODES) {
      expect(code, code).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('isPermissionCode recognises a catalogued code and rejects everything else', () => {
    expect(isPermissionCode('voucher.view')).toBe(true)
    expect(isPermissionCode('voucher.approve')).toBe(false)
    expect(isPermissionCode('not a code')).toBe(false)
    expect(isPermissionCode('')).toBe(false)
  })

  it('marks exactly voucher.reverse, audit.view and admin.user_manage as privileged (ADR-0009)', () => {
    expect([...PRIVILEGED_PERMISSIONS].sort()).toEqual(
      ['admin.user_manage', 'audit.view', 'voucher.reverse'].sort(),
    )
  })

  it('every privileged code is itself a real permission code', () => {
    for (const code of PRIVILEGED_PERMISSIONS) {
      expect(isPermissionCode(code)).toBe(true)
    }
  })

  it('isPrivileged agrees with the set', () => {
    expect(isPrivileged('voucher.reverse')).toBe(true)
    expect(isPrivileged('audit.view')).toBe(true)
    expect(isPrivileged('admin.user_manage')).toBe(true)
    expect(isPrivileged('voucher.view')).toBe(false)
    expect(isPrivileged('customer.view')).toBe(false)
  })
})
