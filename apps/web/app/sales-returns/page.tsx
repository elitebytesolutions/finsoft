'use client'
/* Route /sales-returns — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { SalesReturn } from '@/screens/sales-return'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Sales & POS"><SalesReturn/></Guard>
}
