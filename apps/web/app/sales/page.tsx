'use client'
/* Route /sales — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Sales } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Sales & POS"><Sales products={f.data.products} sales={f.data.sales} onAdd={f.addSale} canCreate={f.act('sale:create')}/></Guard>
}
