'use client'
/* Route /vendors/:code — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { VendorDetail } from '@/screens/parties'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Masters">
      <VendorDetail data={f.data} onPatch={f.patchMaster} />
    </Guard>
  )
}
