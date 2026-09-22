'use client'
/* Route /cheque-voucher — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ChequeVoucher } from '@/screens/cheque-voucher'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><ChequeVoucher data={f.data}/></Guard>
}
