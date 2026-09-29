'use client'
/* Route /vouchers/:id — M2-S: wired to the real API (GET /api/journals/:id,
 * POST /api/journals/:id/reverse). */
import { VoucherDetail } from '@/screens/vouchers'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherDetail />
    </Guard>
  )
}
