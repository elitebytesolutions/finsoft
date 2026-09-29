'use client'
/* Route /cash-book — M2-S: the real ledger of Cash in Hand.
 * docs/design-system/pages/cash-book/README.md. */
import { CashBook } from '@/screens/cashbook'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <CashBook />
    </Guard>
  )
}
