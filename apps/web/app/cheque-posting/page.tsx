'use client'
/* Route /cheque-posting — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ChequePosting } from '@/screens/cheque-posting'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><ChequePosting data={f.data}/></Guard>
}
