'use client'
/* Holds the state that App.tsx held in the prototype — the persistent mock
 * store and the active role — and hands it to every route segment.
 *
 * The prototype passed `data` and its mutators down as props from a single
 * <Routes> table. The App Router has no such parent render, so the same values
 * travel through context and each page re-assembles the exact props the screen
 * component already expects. Screen signatures are unchanged on purpose. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { actionPermissions, roles, useFinsoftData } from '@/mocks/api'

type FinsoftStore = ReturnType<typeof useFinsoftData>
type FinsoftContext = FinsoftStore & {
  role: string
  setRole: (role: string) => void
  /** Module-level permission — the `can()` of the prototype's route table. */
  can: (module: string) => boolean
  /** Action-level permission — the prototype's `act()`. */
  act: (action: string) => boolean
}

const Ctx = createContext<FinsoftContext | null>(null)

export function FinsoftProvider({ children }: { children: ReactNode }) {
  const store = useFinsoftData()
  // Same SSR reasoning as mocks/store.ts: default on the server, restore on mount.
  const [role, setRoleState] = useState('Owner')
  useEffect(() => {
    const stored = localStorage.getItem('finsoft-role')
    if (stored && roles[stored]) setRoleState(stored)
  }, [])
  const setRole = (next: string) => {
    setRoleState(next)
    try {
      localStorage.setItem('finsoft-role', next)
    } catch {
      /* storage can be unavailable */
    }
  }

  const allowed = useMemo(() => roles[role] || [], [role])
  const can = (module: string) => allowed.includes('all') || allowed.includes(module)
  const act = (action: string) =>
    Boolean(actionPermissions[role]?.includes('all') || actionPermissions[role]?.includes(action))

  const value = useMemo(
    () => ({ ...store, role, setRole, can, act }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, role, allowed],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useFinsoft(): FinsoftContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFinsoft must be used inside <FinsoftProvider>')
  return ctx
}
