'use client'
/* Route /trial-balance — new for M2-S (docs/design-system/pages/trial-balance/README.md).
 * No prototype ancestor; wired to the real API from the start. */
import { TrialBalance } from '@/screens/trial-balance'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <TrialBalance />
    </Guard>
  )
}
