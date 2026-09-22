'use client'
/* Route /procurement — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Procurement } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Demand & PO"><Procurement/></Guard>
}
