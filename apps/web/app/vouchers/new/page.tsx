'use client'
/* Route /vouchers/new — M2-S: wired to the real API (POST /api/journals). JV only —
 * journal-voucher.md §1 (single-step post, no draft, no approval). */
import { VoucherForm } from '@/screens/vouchers'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherForm />
    </Guard>
  )
}
