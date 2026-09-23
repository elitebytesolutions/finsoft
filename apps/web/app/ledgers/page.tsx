'use client'
/* Route /ledgers — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { AccountLedger } from '@/screens/account-ledger'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <AccountLedger data={f.data} />
    </Guard>
  )
}
