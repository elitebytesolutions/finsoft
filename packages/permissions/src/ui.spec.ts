import { describe, expect, it } from 'vitest'
import { PERMISSION_CODES, isPrivileged } from './catalog.ts'
import { permissionsForUi } from './ui.ts'

describe('permissionsForUi', () => {
  it('has exactly one entry per catalogued permission', () => {
    expect(permissionsForUi.map((e) => e.code).sort()).toEqual([...PERMISSION_CODES].sort())
  })

  it('agrees with isPrivileged for every entry', () => {
    for (const entry of permissionsForUi) {
      expect(entry.privileged, entry.code).toBe(isPrivileged(entry.code))
    }
  })
})
