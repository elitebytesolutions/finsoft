'use client'
/* Route /bank-book — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { BankBook } from '@/screens/bank-book'
import { Guard } from '@/components/guard'

export default function Page() {
  return <Guard module="Cash, Bank & GL"><BankBook/></Guard>
}
