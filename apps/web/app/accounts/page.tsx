'use client'
/* Route /accounts — M2-S: wired to the real API (GET /api/accounts), read-only
 * (coa-standard.md §5). Screen no longer takes mock data/mutator props. */
import { ChartOfAccounts } from '@/screens/chart-of-accounts'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <ChartOfAccounts />
    </Guard>
  )
}
