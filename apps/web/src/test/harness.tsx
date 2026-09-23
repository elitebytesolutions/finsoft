'use client'
/* Test-only stand-ins for react-router-dom's <MemoryRouter> and the
 * prototype's default-exported <App/>.
 *
 * Built so every ported test file only has to change its react-router-dom and
 * './App' import lines to point here — `<MemoryRouter initialEntries={[path]}>
 * <App/></MemoryRouter>` and every render()/fireEvent/expect below it stays
 * byte-for-byte identical to ui-prototype/src/*.test.tsx. See the DECISIONS
 * section of the port report for why this shape was chosen over mounting a
 * real Next.js router.
 *
 *   MemoryRouter  creates one router store per mount (./router-store.ts) and
 *                 provides it over context — the same per-instance isolation
 *                 react-router-dom's real MemoryRouter gives two concurrently
 *                 mounted trees (see router-store.ts's own comment for why
 *                 that isolation matters here).
 *   App           reproduces apps/web/app/layout.tsx: <FinsoftProvider> wraps
 *                 the real <AppFrame> (the ported Shell/sidebar/topbar), which
 *                 wraps whichever apps/web/app/**\/page.tsx matches the current
 *                 path (./route-table.ts) — the App Router's job, done by hand
 *                 because nothing in this test runs `next dev`/`next start`. */
import { useState, type ReactNode } from 'react'
import { FinsoftProvider } from '@/app-context'
import { AppFrame } from '@/components/app-frame'
import { matchRoute } from './route-table'
import { createRouterStore, RouterStoreContext, useRouterState } from './router-store'

export function MemoryRouter({
  initialEntries,
  children,
}: {
  initialEntries: string[]
  children: ReactNode
}) {
  // Lazy initializer: the store (and its history stack) is built once, on
  // this MemoryRouter instance's mount, and never again on re-render —
  // matching react-router-dom's real MemoryRouter, which builds its history
  // once per mount too.
  const [store] = useState(() => createRouterStore(initialEntries))
  return <RouterStoreContext.Provider value={store}>{children}</RouterStoreContext.Provider>
}

function CurrentRoute() {
  const { pathname } = useRouterState()
  const { Component } = matchRoute(pathname)
  return <Component />
}

export default function App() {
  return (
    <FinsoftProvider>
      <AppFrame>
        <CurrentRoute />
      </AppFrame>
    </FinsoftProvider>
  )
}
