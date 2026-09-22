'use client'
/* Route /procurement — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Procurement } from '@/screens/app-screens'
import { Guard } from '@/components/guard'

export default function Page() {
  return <Guard module="Demand & PO"><Procurement/></Guard>
}
