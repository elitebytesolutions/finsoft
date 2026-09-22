'use client'
/* Route /masters — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Masters } from '@/screens/app-screens'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Masters"><Masters masters={f.data.masters} onAddMaster={f.addMaster} canCreate={f.act('master:create')}/></Guard>
}
