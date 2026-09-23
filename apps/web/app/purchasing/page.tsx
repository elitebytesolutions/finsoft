'use client'
/* Route /purchasing — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Purchasing } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Purchasing">
      <Purchasing
        products={f.data.products}
        purchases={f.data.purchases}
        onAdd={f.addPurchase}
        canCreate={f.act('purchase:create')}
      />
    </Guard>
  )
}
