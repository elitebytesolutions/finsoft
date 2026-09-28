import { describe, expect, it } from 'vitest'
import { PERMISSION_CODES, isPermissionCode } from './catalog.ts'
import { SYSTEM_ROLE_SEEDS } from './system-roles.ts'

describe('system role templates', () => {
  it('defines exactly Owner, Accountant and Viewer, all is_system', () => {
    expect(SYSTEM_ROLE_SEEDS.map((s) => s.code).sort()).toEqual(['accountant', 'owner', 'viewer'])
    expect(SYSTEM_ROLE_SEEDS.every((s) => s.isSystem)).toBe(true)
  })

  const seed = (code: string) => SYSTEM_ROLE_SEEDS.find((s) => s.code === code)

  it('gives Owner every permission in the catalogue', () => {
    expect([...seed('owner')!.permissions].sort()).toEqual([...PERMISSION_CODES].sort())
  })

  it('gives Accountant every permission except admin.user_manage', () => {
    const accountant = seed('accountant')!.permissions
    expect(accountant).not.toContain('admin.user_manage')
    expect([...accountant].sort()).toEqual(
      PERMISSION_CODES.filter((c) => c !== 'admin.user_manage').sort(),
    )
  })

  it('gives Viewer exactly customer.view, voucher.view and report.financial', () => {
    expect([...seed('viewer')!.permissions].sort()).toEqual(
      ['customer.view', 'report.financial', 'voucher.view'].sort(),
    )
  })

  it('never grants a code outside the catalogue', () => {
    for (const role of SYSTEM_ROLE_SEEDS) {
      for (const code of role.permissions) {
        expect(isPermissionCode(code), `${role.code} grants unknown code ${code}`).toBe(true)
      }
    }
  })

  it('names no permission twice within one role', () => {
    for (const role of SYSTEM_ROLE_SEEDS) {
      expect(new Set(role.permissions).size, role.code).toBe(role.permissions.length)
    }
  })
})
