'use client'
/* Route /vouchers — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { VoucherRegister } from '@/screens/voucher-register'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherRegister
        data={f.data}
        onPost={(id) =>
          f.patchVoucher(id, { status: 'Posted' as const, posting: 'Posted' as const }, true)
        }
      />
    </Guard>
  )
}
