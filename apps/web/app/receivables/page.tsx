'use client'
/* Route /receivables — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { AccountsReceivable } from '@/screens/finance-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><AccountsReceivable data={f.data}/></Guard>
}
