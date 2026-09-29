/*
 * Adapts the real customers API (apps/web/src/lib/api/customers-client.ts) into the
 * `Master` shape `apps/web/src/screens/parties.tsx` (PartyList, CustomerTable,
 * CustomerDetail) already renders — so those screens' markup, columns and interactions
 * stay exactly as they are, per the M4-W course correction: only the DATA SOURCE changes.
 *
 * Money stays a string end to end (CLAUDE.md): `Master.balance: number` is a mock-era
 * field these screens' JSX never actually reads for a real customer (the profile/ledger
 * panels below are rewired to read `extra.balanceMoney`/`extra.balanceAsOf` directly, via
 * `moneyFromString`/`formatRunningBalance`), so it is always left `0` here rather than
 * parsed from the server's decimal string. `extra` values are all strings (Master's own
 * type), so the customer's `id` and raw balance ride along in it for the real screens that
 * now need them (a code-keyed route cannot look a customer up — apps/web/app/customers/[id]
 * reads `extra.customerId`, never `code`, once fetched).
 */
import type { Customer, CustomerListItem } from '../api/customers-client'
import type { Master } from '@/mocks/api'

export function customerToMaster(c: Customer | CustomerListItem): Master {
  return {
    code: c.code,
    name: c.name,
    type: 'Customer',
    balanceType: 'Debit',
    status: c.status === 'ACTIVE' ? 'Active' : 'Inactive',
    city: c.city ?? '—',
    contact: c.phone ?? '—',
    balance: 0,
    extra: {
      customerId: c.id,
      version: String('version' in c ? c.version : ''),
      ntn: 'ntn' in c ? (c.ntn ?? '') : '',
      balanceMoney: c.balance,
      balanceAsOf: c.balanceAsOf,
      email: 'email' in c && c.email ? c.email : '',
      address: 'address' in c && c.address ? c.address : '',
      creditDays: 'creditDays' in c ? String(c.creditDays) : '',
      createdAt: 'createdAt' in c ? c.createdAt : '',
    },
  }
}

/** The uuid a real customer's adapted `Master` carries — `undefined` for a mock/vendor row
 * that never went through `customerToMaster`. */
export function customerIdOf(m: Master): string | undefined {
  return m.extra?.customerId || undefined
}

export function customerVersionOf(m: Master): number | undefined {
  const raw = m.extra?.version
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
