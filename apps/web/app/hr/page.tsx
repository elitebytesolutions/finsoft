'use client'
/* Route /hr — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { HR } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="HR & Payroll"><HR employees={f.data.employees} onAddEmployee={f.addEmployee} canCreate={f.act('master:create')}/></Guard>
}
