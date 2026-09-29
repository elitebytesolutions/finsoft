'use client'
/* Route /ledgers — M2-S: wired to the real API (GET /api/accounts + GET /api/ledgers/:id). */
import { AccountLedger } from '@/screens/account-ledger'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <AccountLedger />
    </Guard>
  )
}
