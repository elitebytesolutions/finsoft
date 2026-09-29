'use client'
/*
 * Route /customers/:id — was /customers/:code in the prototype. M4-W renamed the segment:
 * there is no "look up a customer by code" endpoint (docs/design/M3/api-contract.md §4.1),
 * codes are otherwise immutable display text, and ids are what C3/C4/C5/C6/C7 all take.
 * CustomerDetail is self-contained now (fetches by this id itself, same pattern as
 * AccountLedger/PeriodClose in trade-pages.tsx) — see its own header comment.
 */
import { CustomerDetail } from '@/screens/parties'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Masters">
      <CustomerDetail />
    </Guard>
  )
}
