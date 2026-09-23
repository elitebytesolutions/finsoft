'use client'
/* Route /reports/templates — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ReportTemplates } from '@/screens/reports-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Reports">
      <ReportTemplates data={f.data} onDelete={f.deleteTemplate} />
    </Guard>
  )
}
