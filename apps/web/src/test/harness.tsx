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
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { matchRoute } from './route-table'
import { createRouterStore, RouterStoreContext, useRouterState } from './router-store'

/*
 * A fake, already-authenticated session — not the real `<AuthProvider>`, which calls
 * `GET /api/auth/me` on mount. jsdom has no API to answer that, and every ported screen
 * test below expects its route to render immediately, the way it did before a session
 * existed at all. `AuthContext` is exported by auth-context.tsx for exactly this: a test
 * seam that supplies `useAuth()` a value with no network call behind it, so `<Shell>`
 * (which reads the real user/tenant for its header) and the session-required guard logic
 * (which lives on <AuthProvider> itself, not on this fake value, and so never runs here)
 * both stay out of every ported test's way. */
const fakeAuth: AuthContextValue = {
  status: 'authenticated',
  user: { id: 'test-user', fullName: 'Test User', email: 'test.user@example.com' },
  tenant: { id: 'test-tenant', code: 'TEST', name: 'Test Tenant' },
  sessionId: 'test-session',
  permissionVersion: 1,
  errorMessage: null,
  retry: () => {},
  syncAfterLogin: async () => {},
  signOut: async () => {},
}

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
    <AuthContext.Provider value={fakeAuth}>
      <FinsoftProvider>
        <AppFrame>
          <CurrentRoute />
        </AppFrame>
      </FinsoftProvider>
    </AuthContext.Provider>
  )
}
