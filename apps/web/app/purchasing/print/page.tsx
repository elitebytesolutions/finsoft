'use client'
/* Route /purchasing/print — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PrintDocuments } from '@/screens/print-documents'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Purchasing"><PrintDocuments data={f.data}/></Guard>
}
