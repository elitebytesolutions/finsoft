'use client'
/*
 * Feeds `apps/web/src/screens/parties.tsx`'s existing PartyList/CustomerTable — that
 * screen filters, sorts and paginates an already-in-memory `Master[]` (`data.masters`),
 * exactly as it did against the mock store. C1 (`GET /api/customers`) is cursor-paginated
 * with no total count (docs/design/M3/api-contract.md §1), which is fundamentally
 * incompatible with "load the whole list into memory" for an unbounded tenant — but
 * rewriting PartyList's filter/sort/pager into a server-driven one is the screen rewrite
 * the M4-W course correction forbids. This hook is the compromise: it follows C1's cursor
 * automatically, up to a bounded number of pages, and hands PartyList a real (never
 * fabricated), capped array to keep operating on exactly as it always has. `hasMore`
 * reports whether the cap was hit, so the screen can say so rather than imply completeness
 * it cannot promise — see the "capped, not silently truncated" state PartyList renders.
 */
import { useEffect, useState } from 'react'
import { listCustomers } from '../api/customers-client'
import { ApiError } from '../api/types'
import { customerToMaster } from './customers'
import type { Master } from '@/mocks/api'

const PAGE_LIMIT = 200
/** 5 * 200 = 1,000 customers loaded before this hook stops following cursors and reports
 * `hasMore` instead. Comfortably past any real Bhatti-Traders-scale tenant today; a tenant
 * that outgrows it needs PartyList's own pagination rebuilt server-side, not a bigger cap. */
const MAX_PAGES = 5

export type CustomersListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }
  | { status: 'ready'; items: Master[]; hasMore: boolean }

export function useCustomersList(enabled: boolean): {
  state: CustomersListState
  reload: () => void
} {
  const [state, setState] = useState<CustomersListState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: 'loading' })

    async function run() {
      const acc: Parameters<typeof customerToMaster>[0][] = []
      let cursor: string | undefined
      let hasMore = false
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await listCustomers({ limit: PAGE_LIMIT, cursor })
        acc.push(...result.items)
        if (!result.nextCursor) break
        cursor = result.nextCursor
        if (page === MAX_PAGES - 1) hasMore = true
      }
      return { items: acc.map(customerToMaster), hasMore }
    }

    run().then(
      ({ items, hasMore }) => {
        if (!cancelled) setState({ status: 'ready', items, hasMore })
      },
      (err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.code === 'forbidden') {
          setState({ status: 'forbidden' })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Something went wrong.',
        })
      },
    )

    return () => {
      cancelled = true
    }
  }, [enabled, reloadKey])

  return { state, reload: () => setReloadKey((k) => k + 1) }
}
