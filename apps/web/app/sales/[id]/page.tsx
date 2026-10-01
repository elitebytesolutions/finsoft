'use client'
/*
 * Route /sales/:id — M4-W2: SaleDetail now fetches the real invoice (I3) and does its own
 * permission check (can('customer.view') via its 403 handling). No <Guard> — same reasoning
 * as /customers/[id]/page.tsx: API-backed, so the mock module gate isn't the access control.
 * `data` is still passed because detail-pages.tsx's other (still-mock) detail screens share
 * this prop; SaleDetail itself ignores it.
 */
import { SaleDetail } from '@/screens/detail-pages'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <SaleDetail data={f.data} />
}
