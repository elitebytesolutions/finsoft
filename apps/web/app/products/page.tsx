'use client'
/* Route /products — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ProductCatalogue } from '@/screens/product-catalogue'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Products"><ProductCatalogue canCreate={f.act('master:create')}/></Guard>
}
