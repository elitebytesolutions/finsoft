'use client'
/* Route /cheque-clearing — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ChequeClearing } from '@/screens/control-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><ChequeClearing data={f.data} onStatus={f.setChequeStatus}/></Guard>
}
