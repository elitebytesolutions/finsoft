'use client'
/* Route /delivery-challans — Delivery Challan listing and print.
 * Owned by Sales & POS; separate from /sales so both surfaces evolve independently.
 * Challans are seed-only until the NestJS API lands; screen reads seedChallans directly. */
import { Guard } from '@/components/guard'
import { DeliveryChallans } from '@/screens/delivery-challans'
import { seedChallans } from '@/mocks/api'

export default function Page() {
  return (
    <Guard module="Sales & POS">
      <DeliveryChallans challans={seedChallans} />
    </Guard>
  )
}
