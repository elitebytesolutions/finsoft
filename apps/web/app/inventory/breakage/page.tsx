'use client'
/* Route /inventory/breakage — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { StockVouchers } from '@/screens/stock-vouchers'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Inventory">
      <StockVouchers data={f.data} onPost={f.postStockMovement} />
    </Guard>
  )
}
