'use client'
/* Module permission guard — the `can('X') ? <Page/> : <Navigate to="/unauthorized"/>`
 * ternary that wrapped every row of the prototype's route table.
 *
 * This is a UI affordance only. It hides what a role may not open; it does not
 * authorise anything. Real authorisation is server-side (docs/ARCHITECTURE.md). */
import { Navigate } from '@/lib/router'
import { useFinsoft } from '@/app-context'
import type { ReactNode } from 'react'

export function Guard({ module, children }: { module: string; children: ReactNode }) {
  const { can } = useFinsoft()
  if (!can(module)) return <Navigate to="/unauthorized" />
  return <>{children}</>
}
