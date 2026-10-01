'use client'
/* Route /vouchers/new — M2-S: wired to the real API (POST /api/journals). JV only —
 * journal-voucher.md §1 (single-step post, no draft, no approval).
 *
 * No <Guard> — Security seat condition 2: API-backed, `voucher.post` (gated client-side
 * inside VoucherForm) plus the server's own 403 are the access control, not the mock
 * module gate. */
import { VoucherForm } from '@/screens/vouchers'

export default function Page() {
  return <VoucherForm />
}
