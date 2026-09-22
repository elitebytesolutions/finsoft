'use client'
/* Route /po — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PurchaseOrders } from '@/screens/purchase-orders'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Demand & PO"><PurchaseOrders data={f.data} onAddPO={f.addPO} onPatchPO={f.patchPO} onConvert={f.convertPO} canCreate={f.act('po:create')}/></Guard>
}
