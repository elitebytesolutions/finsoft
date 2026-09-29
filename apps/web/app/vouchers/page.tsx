'use client'
/* Route /vouchers — M2-S: wired to the real API (GET /api/journals). */
import { VoucherRegister } from '@/screens/voucher-register'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <VoucherRegister />
    </Guard>
  )
}
