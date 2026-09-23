'use client'
/* Route /reports/analytics — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ReportsAnalytics } from '@/screens/reports-analytics'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Reports">
      <ReportsAnalytics data={f.data} />
    </Guard>
  )
}
