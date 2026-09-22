'use client'
/* Route /today — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { TodayWork } from '@/screens/today-work'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><TodayWork data={f.data} canPost={f.act('voucher:create')}/></Guard>
}
