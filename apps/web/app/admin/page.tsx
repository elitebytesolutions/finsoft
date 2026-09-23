'use client'
/* Route /admin — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Admin } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Admin & Control">
      <Admin key="users" role={f.role} setRole={f.setRole} initialTab="Users" />
    </Guard>
  )
}
