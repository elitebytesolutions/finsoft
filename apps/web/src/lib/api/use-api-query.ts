'use client'
/*
 * The one data-fetching shape every M2-S screen needs: loading, error (with
 * retry), forbidden (403 — distinct from error, no retry, matches
 * 04-states.md §5), and ready. Built once here rather than re-derived per
 * screen (chart-of-accounts, account-ledger, cash-book, voucher-register,
 * voucher-detail, period-close all follow this exact shape).
 *
 * Deliberately thin: no caching, no de-duplication across components, no
 * background refetch. Every M2 accounting screen fetches once per mount/key
 * change and re-fetches only on an explicit user action (retry, a filter
 * changing) — matching 04-states.md §9's "never silently re-render a table
 * the user is reading."
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './types'

export type ApiQueryState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }
  | { status: 'ready'; data: T }

export interface ApiQueryResult<T> {
  state: ApiQueryState<T>
  /** Re-runs the fetch with the same arguments — the loading dependencies changed. */
  reload: () => void
}

/**
 * `fetcher` is called on mount and whenever `deps` changes (same rules as
 * `useEffect`'s dependency array — pass the values the query depends on,
 * e.g. `[asOf]` or `[accountId, from, to]`). `reload()` re-runs it with the
 * CURRENT closure, for a "Try again" button after an error.
 */
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): ApiQueryResult<T> {
  const [state, setState] = useState<ApiQueryState<T>>({ status: 'loading' })
  // Guards against a stale response landing after a newer request started
  // (deps changed again, or reload() was clicked twice) — only the latest
  // in-flight call is allowed to set state.
  const requestId = useRef(0)

  const run = useCallback(() => {
    const id = ++requestId.current
    setState({ status: 'loading' })
    fetcher().then(
      (data) => {
        if (id === requestId.current) setState({ status: 'ready', data })
      },
      (err: unknown) => {
        if (id !== requestId.current) return
        if (err instanceof ApiError && err.code === 'forbidden') {
          setState({ status: 'forbidden' })
          return
        }
        const message = err instanceof ApiError ? err.message : 'Something went wrong.'
        setState({ status: 'error', message })
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { state, reload: run }
}
