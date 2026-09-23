'use client'
/* Route /cash-book — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { CashBook } from '@/screens/cashbook'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <CashBook data={f.data} />
    </Guard>
  )
}
