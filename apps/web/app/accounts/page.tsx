'use client'
/* Route /accounts — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ChartOfAccounts } from '@/screens/chart-of-accounts'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><ChartOfAccounts data={f.data} onAdd={f.addMaster} onRemove={f.removeMaster} canCreate={f.act('master:create')}/></Guard>
}
