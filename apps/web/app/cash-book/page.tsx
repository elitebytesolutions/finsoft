'use client'
/* Route /cash-book — M2-S: the real ledger of Cash in Hand.
 * docs/design-system/pages/cash-book/README.md.
 *
 * No <Guard> — Security seat condition 2: API-backed, the server's own permission checks
 * and 403 are the access control, not the mock module gate. */
import { CashBook } from '@/screens/cashbook'

export default function Page() {
  return <CashBook />
}
