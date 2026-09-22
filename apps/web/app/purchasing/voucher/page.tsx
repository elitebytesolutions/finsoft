'use client'
/* Route /purchasing/voucher — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PurchaseVoucher } from '@/screens/purchase-voucher'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Purchasing"><PurchaseVoucher data={f.data} onAdd={f.addPurchase}/></Guard>
}
