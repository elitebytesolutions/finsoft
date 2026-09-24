'use client'
/* Route /credit-limits — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { CreditLimitsTerms } from '@/screens/credit-limits'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Cash, Bank & GL">
      <CreditLimitsTerms />
    </Guard>
  )
}
