'use client'
/* Route /finance — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Navigate } from '@/lib/router'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><Navigate to="/accounts" replace/></Guard>
}
