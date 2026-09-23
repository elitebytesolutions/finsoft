'use client'
/* Route /cash-transactions — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { CashTransactions } from '@/screens/cash-transactions'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <CashTransactions data={f.data} />
    </Guard>
  )
}
