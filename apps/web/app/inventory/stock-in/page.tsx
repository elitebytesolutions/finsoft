'use client'
/* Route /inventory/stock-in — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ManualStockEntry } from '@/screens/manual-stock'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Inventory">
      <ManualStockEntry data={f.data} onPost={f.postStockMovement} />
    </Guard>
  )
}
