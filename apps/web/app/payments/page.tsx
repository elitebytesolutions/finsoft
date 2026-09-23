'use client'
/* Route /payments — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PaymentsCentre } from '@/screens/transactions-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <PaymentsCentre
        data={f.data}
        onAddPayment={f.addPayment}
        canCreate={f.act('payment:create')}
      />
    </Guard>
  )
}
