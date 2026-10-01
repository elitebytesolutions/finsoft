'use client'
/* Route /vouchers/:id — M2-S: wired to the real API (GET /api/journals/:id,
 * POST /api/journals/:id/reverse).
 *
 * No <Guard> — Security seat condition 2: API-backed, `voucher.reverse` (gated
 * client-side inside VoucherDetail) plus the server's own 403 are the access control,
 * not the mock module gate. */
import { VoucherDetail } from '@/screens/vouchers'

export default function Page() {
  return <VoucherDetail />
}
