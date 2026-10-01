'use client'
/* Route /ledgers — M2-S: wired to the real API (GET /api/accounts + GET /api/ledgers/:id).
 *
 * No <Guard> — Security seat condition 2: API-backed, the server's own permission checks
 * and 403 are the access control, not the mock module gate. */
import { AccountLedger } from '@/screens/account-ledger'

export default function Page() {
  return <AccountLedger />
}
