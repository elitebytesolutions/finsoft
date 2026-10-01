'use client'
/* Route /accounts — M2-S: wired to the real API (GET /api/accounts), read-only
 * (coa-standard.md §5). Screen no longer takes mock data/mutator props.
 *
 * No <Guard> — Security seat condition 2: API-backed, `account.view` + the server's 403
 * are the access control, not the mock module gate. */
import { ChartOfAccounts } from '@/screens/chart-of-accounts'

export default function Page() {
  return <ChartOfAccounts />
}
