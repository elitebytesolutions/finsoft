'use client'
/* Route /inventory/as-of — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { InventoryWorkspace } from '@/screens/inventory-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Inventory">
      <InventoryWorkspace data={f.data} view="as-of" onPost={f.postStockMovement} />
    </Guard>
  )
}
