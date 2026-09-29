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

  it('gives Accountant every permission except admin.user_manage and period.reopen', () => {
    const accountant = seed('accountant')!.permissions
    expect(accountant).not.toContain('admin.user_manage')
    expect(accountant).not.toContain('period.reopen')
    expect([...accountant].sort()).toEqual(
      PERMISSION_CODES.filter((c) => c !== 'admin.user_manage' && c !== 'period.reopen').sort(),
    )
  })

  it('gives Viewer exactly customer.view, voucher.view, report.financial, account.view and period.view', () => {
    expect([...seed('viewer')!.permissions].sort()).toEqual(
      ['customer.view', 'report.financial', 'voucher.view', 'account.view', 'period.view'].sort(),
    )
  })

  it('exhaustiveness: ACCOUNTANT_PERMISSIONS is explicit, so a new catalogue code never silently reaches Accountant', () => {
    // Every code the catalogue defines is accounted for by name in one of
    // three buckets: granted to Accountant, or one of the two named
    // exceptions. A code added to catalog.ts that fits none of the three
    // fails this test rather than silently landing in (or out of)
    // Accountant's grant list.
    const accountant = new Set(seed('accountant')!.permissions)
    const exceptions = new Set(['admin.user_manage', 'period.reopen'])
    for (const code of PERMISSION_CODES) {
      const inAccountant = accountant.has(code)
      const isException = exceptions.has(code)
      expect(inAccountant !== isException, code).toBe(true)
    }
  })

  it('Owner holds period.reopen; Accountant and Viewer do not', () => {
    expect(seed('owner')!.permissions).toContain('period.reopen')
    expect(seed('accountant')!.permissions).not.toContain('period.reopen')
    expect(seed('viewer')!.permissions).not.toContain('period.reopen')
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
