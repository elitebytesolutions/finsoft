'use client'
/* Route /admin-audit — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged.
 *
 * No <Guard> — Security seat condition 2: the Audit log tab is API-backed
 * (AuditLogPanel, app-screens.tsx). Its own `can('audit.view')` check, run before the
 * request even fires, plus the server's 403, are the access control — not the mock
 * module gate. The other tabs of Admin (Users, Roles & permissions, Fiscal periods,
 * Security, Active sessions) are still mock and unaffected by this. */
import { Admin } from '@/screens/app-screens'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Admin key="audit" role={f.role} setRole={f.setRole} initialTab="Audit log" />
}
