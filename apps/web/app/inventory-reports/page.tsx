'use client'
/* Route /inventory-reports — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { InventoryReports } from '@/screens/inventory-reports'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Reports">
      <InventoryReports />
    </Guard>
  )
}
