'use client'
/* Route /vouchers — M2-S: wired to the real API (GET /api/journals).
 *
 * No <Guard> — Security seat condition 2: API-backed, the server's own permission checks
 * and 403 are the access control, not the mock module gate. */
import { VoucherRegister } from '@/screens/voucher-register'

export default function Page() {
  return <VoucherRegister />
}
