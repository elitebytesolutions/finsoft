'use client'
/* Route /bank-accounts — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { BankAccounts } from '@/screens/bank-accounts'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <BankAccounts data={f.data} />
    </Guard>
  )
}
