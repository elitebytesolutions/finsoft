'use client'
/* Binds the ported Shell to the app context. The prototype rendered
 * <Shell role setRole>{routes}</Shell> from App(); here the App Router supplies
 * the children and the provider supplies the role. */
import type { ReactNode } from 'react'
import { Shell } from './shell'
import { useFinsoft } from '@/app-context'

export function AppFrame({ children }: { children: ReactNode }) {
  const { role, setRole } = useFinsoft()
  return <Shell role={role} setRole={setRole}>{children}</Shell>
}
