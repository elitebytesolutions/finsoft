'use client'
/* Route /reports — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ReportsCentre } from '@/screens/reports-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Reports"><ReportsCentre data={f.data} onAddTemplate={f.addTemplate} onDelete={f.deleteTemplate}/></Guard>
}
