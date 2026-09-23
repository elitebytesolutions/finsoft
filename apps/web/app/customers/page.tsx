'use client'
/* Route /customers — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { PartyList } from '@/screens/parties'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return (
    <Guard module="Masters">
      <PartyList
        data={f.data}
        kind="Customer"
        onAdd={f.addMaster}
        canCreate={f.act('master:create')}
      />
    </Guard>
  )
}
