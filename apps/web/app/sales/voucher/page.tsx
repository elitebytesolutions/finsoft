'use client'
/* Route /sales/voucher — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { SalesVoucher } from '@/screens/sales-voucher'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Sales & POS"><SalesVoucher data={f.data} onAdd={f.addSale}/></Guard>
}
