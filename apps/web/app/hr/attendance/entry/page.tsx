'use client'
/* Route /hr/attendance/entry — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { AttendanceEntry } from '@/screens/attendance-entry'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="HR & Payroll"><AttendanceEntry/></Guard>
}
