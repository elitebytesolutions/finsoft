'use client'
/* Route /hr/attendance — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { SalesmanAttendance } from '@/screens/attendance'
import { Guard } from '@/components/guard'

export default function Page() {
  return <Guard module="HR & Payroll"><SalesmanAttendance/></Guard>
}
