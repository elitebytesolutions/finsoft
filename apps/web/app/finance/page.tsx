'use client'
/* Route /finance — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Navigate } from '@/lib/router'
import { Guard } from '@/components/guard'

export default function Page() {
  return <Guard module="Cash, Bank & GL"><Navigate to="/accounts" replace/></Guard>
}
