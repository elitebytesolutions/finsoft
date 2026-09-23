'use client'
/* Route /vouchers/:id — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { VoucherDetail } from '@/screens/vouchers'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherDetail
        data={f.data}
        onPost={(id) =>
          f.patchVoucher(id, { status: 'Posted' as const, posting: 'Posted' as const }, true)
        }
        onCancel={(id) =>
          f.patchVoucher(id, { status: 'Cancelled' as const, posting: 'Unposted' as const })
        }
      />
    </Guard>
  )
}
