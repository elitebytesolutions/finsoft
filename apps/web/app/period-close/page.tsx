'use client'
/* Route /period-close — M2-S: wired to the real API (GET /api/periods,
 * POST /api/periods/:id/{close,reopen}). No lock route in M2 (Council ruling).
 *
 * No <Guard> — Security seat condition 2: API-backed, `period.close`/`period.reopen`
 * (gated client-side inside PeriodClose) plus the server's own 403 are the access
 * control, not the mock module gate. */
import { PeriodClose } from '@/screens/trade-pages'

export default function Page() {
  return <PeriodClose />
}
