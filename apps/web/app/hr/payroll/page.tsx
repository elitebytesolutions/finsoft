'use client'
/* Route /hr/payroll — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PayrollPage } from '@/screens/payroll'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="HR & Payroll">
      <PayrollPage employees={f.data.employees} />
    </Guard>
  )
}
