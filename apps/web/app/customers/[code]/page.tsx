'use client'
/* Route /customers/:code — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { CustomerDetail } from '@/screens/parties'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Masters">
      <CustomerDetail data={f.data} onPatch={f.patchMaster} />
    </Guard>
  )
}
