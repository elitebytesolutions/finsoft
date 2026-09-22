'use client'
/* Route /bank-transactions — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { BankTransactions } from '@/screens/bank-transactions'
import { Guard } from '@/components/guard'

export default function Page() {
  return <Guard module="Cash, Bank & GL"><BankTransactions/></Guard>
}
