'use client'
/* Route /product-classes — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ProductClasses } from '@/screens/product-classes'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Products"><ProductClasses/></Guard>
}
