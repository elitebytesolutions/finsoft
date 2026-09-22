'use client'
/* Route /inventory — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { InventoryWorkspace } from '@/screens/inventory-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Inventory"><InventoryWorkspace data={f.data} view="overview" onPost={f.postStockMovement}/></Guard>
}
