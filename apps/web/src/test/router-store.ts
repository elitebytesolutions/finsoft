/* Per-instance reactive router store, one per <MemoryRouter> mount.
 *
 * First cut of this harness used a single module-level singleton store. That
 * broke the moment a test rendered twice without an intervening cleanup()
 * (ui-prototype/src/detail-pages.test.tsx's "renders field sales and period
 * close" does exactly this) — react-router-dom's real <MemoryRouter> gives
 * each mount its own independent history, so two concurrently-mounted trees
 * never see each other's navigation. A single shared store made the first
 * tree's <CurrentRoute/> react to the second tree's navigate() call, so both
 * ended up showing the same page and `getByText` found the heading twice.
 *
 * Scoping the store to a React context — provided once per <MemoryRouter> —
 * restores that isolation while keeping the mocked next/navigation hooks
 * (./setup.ts) reactive: they read whichever store is nearest in the tree,
 * exactly the way real next/navigation hooks read whichever router owns the
 * segment tree they're called from. */
import { createContext, useContext, useSyncExternalStore } from 'react'
import { matchRoute } from './route-table'

type RouterState = { pathname: string; search: string; params: Record<string, string> }

export type RouterStore = {
  getSnapshot: () => RouterState
  subscribe: (listener: () => void) => () => void
  navigate: (to: string | number, opts?: { replace?: boolean }) => void
}

function splitEntry(entry: string): { pathname: string; search: string } {
  const [pathname, search = ''] = entry.split('?')
  return { pathname: pathname || '/', search: search ? `?${search}` : '' }
}

function toEntry(pathname: string, search: string): string {
  return search ? `${pathname}${search.startsWith('?') ? search : `?${search}`}` : pathname
}

/** One router's worth of state: a small history stack plus the pub/sub that
 * makes it reactive. Mirrors what a real (react-router-dom) MemoryRouter
 * keeps internally, scoped the same way — per instance, not shared. */
export function createRouterStore(initialEntries: string[]): RouterStore {
  let history = initialEntries.length ? [...initialEntries] : ['/']
  let historyIndex = history.length - 1
  let state: RouterState = { pathname: '/', search: '', params: {} }
  const listeners = new Set<() => void>()

  function apply(pathname: string, search: string) {
    const { params } = matchRoute(pathname)
    state = { pathname, search, params }
    listeners.forEach((listener) => listener())
  }

  const initial = splitEntry(history[historyIndex])
  state = {
    pathname: initial.pathname,
    search: initial.search,
    params: matchRoute(initial.pathname).params,
  }

  function navigate(to: string | number, opts?: { replace?: boolean }) {
    if (typeof to === 'number') {
      historyIndex = Math.max(0, Math.min(history.length - 1, historyIndex + to))
      const { pathname, search } = splitEntry(history[historyIndex])
      apply(pathname, search)
      return
    }
    const { pathname, search } = splitEntry(to)
    const entry = toEntry(pathname, search)
    if (opts?.replace) {
      history[historyIndex] = entry
    } else {
      history = [...history.slice(0, historyIndex + 1), entry]
      historyIndex = history.length - 1
    }
    apply(pathname, search)
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    navigate,
  }
}

export const RouterStoreContext = createContext<RouterStore | null>(null)

/** Used by both the mocked next/navigation hooks and the harness's own
 * <CurrentRoute/> — the single reactive read side for "what's the current
 * router state", scoped to whichever <MemoryRouter> owns this part of the
 * tree. */
export function useRouterState(): RouterState {
  const store = useContext(RouterStoreContext)
  if (!store) {
    throw new Error(
      'next/navigation was used outside <MemoryRouter> (apps/web/src/test/harness.tsx) — ' +
        'every ported test renders through <MemoryRouter initialEntries={[...]}><App/></MemoryRouter>.',
    )
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useRouterNavigate(): RouterStore['navigate'] {
  const store = useContext(RouterStoreContext)
  if (!store) {
    throw new Error(
      'next/navigation was used outside <MemoryRouter> (apps/web/src/test/harness.tsx) — ' +
        'every ported test renders through <MemoryRouter initialEntries={[...]}><App/></MemoryRouter>.',
    )
  }
  return store.navigate
}
