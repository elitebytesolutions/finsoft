'use client'
/* Route /products/:id — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ProductDetail } from '@/screens/detail-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Products">
      <ProductDetail data={f.data} />
    </Guard>
  )
}
