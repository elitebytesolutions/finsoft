'use client'
/* Route /period-close — M2-S: wired to the real API (GET /api/periods,
 * POST /api/periods/:id/{close,reopen}). No lock route in M2 (Council ruling). */
import { PeriodClose } from '@/screens/trade-pages'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <PeriodClose />
    </Guard>
  )
}
