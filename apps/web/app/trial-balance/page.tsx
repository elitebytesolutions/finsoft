'use client'
/* Route /trial-balance — new for M2-S (docs/design-system/pages/trial-balance/README.md).
 * No prototype ancestor; wired to the real API from the start.
 *
 * No <Guard> — Security seat condition 2: API-backed, the server's own permission checks
 * and 403 are the access control, not the mock module gate. */
import { TrialBalance } from '@/screens/trial-balance'

export default function Page() {
  return <TrialBalance />
}
