'use client'
/* Route /vouchers/new — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { VoucherForm } from '@/screens/vouchers'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherForm data={f.data} onSave={f.saveVoucher} />
    </Guard>
  )
}
