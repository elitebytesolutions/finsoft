'use client'
/* Route /hr/attendance — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { SalesmanAttendance } from '@/screens/attendance'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="HR & Payroll"><SalesmanAttendance/></Guard>
}
