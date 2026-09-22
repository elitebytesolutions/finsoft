'use client'
/* Route /purchasing/returns — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PurchaseReturns } from '@/screens/purchase-returns'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Purchasing"><PurchaseReturns data={f.data} onAdd={f.addPurchaseReturn}/></Guard>
}
