'use client'
/* Route /companies — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ProductCompanies } from '@/screens/companies'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Products"><ProductCompanies/></Guard>
}
