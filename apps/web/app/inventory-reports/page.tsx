'use client'
/* Route /inventory-reports — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { InventoryReports } from '@/screens/inventory-reports'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Reports"><InventoryReports/></Guard>
}
