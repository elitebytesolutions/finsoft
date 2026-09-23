'use client'
/* Route /cheque-actions — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ChequeActions } from '@/screens/cheque-actions'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Cash, Bank & GL">
      <ChequeActions data={f.data} />
    </Guard>
  )
}
