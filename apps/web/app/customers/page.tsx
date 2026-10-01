'use client'
/* Route /customers — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen's markup is unchanged; M4-W wired its data source
 * to the real customers API (see PartyList's own comments) and its create permission to
 * `GET /api/me/permissions` (`customer.create`) instead of the mock role switch.
 *
 * No <Guard> — Security seat condition 2: this route is API-backed, so the mock module
 * gate (a stale, never-cleared-on-sign-out localStorage role) is not the access control.
 * `can('customer.create')` below plus the server's own 403 on every call are. */
import { PartyList } from '@/screens/parties'
import { useFinsoft } from '@/app-context'
import { useAuth } from '@/lib/api/auth-context'

export default function Page() {
  const f = useFinsoft()
  const { can } = useAuth()
  return (
    <PartyList
      data={f.data}
      kind="Customer"
      onAdd={f.addMaster}
      canCreate={can('customer.create')}
    />
  )
}
