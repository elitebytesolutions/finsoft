'use client'
/* Route /field-sales — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { FieldSales } from '@/screens/trade-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Sales & POS"><FieldSales/></Guard>
}
