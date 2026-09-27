'use client'
/* The real session, replacing the role mock for identity purposes. `app-context.tsx`'s
 * mock `can()`/`act()` stays for prototype screens (PRD §6.1: no new mock-only business
 * screens, but existing ones are not this task's job to rebuild) — this provider only
 * answers "who is signed in, to which tenant" and "is a session required here at all".
 *
 * Wraps the whole app from the root layout, above <FinsoftProvider>, so every route –
 * including the ones still rendering mock data — has a real identity in its header. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { RotateCw, ShieldAlert } from 'lucide-react'
import { Button } from '@finsoft/ui'
import { usePathname, useNavigate } from '@/lib/router'
import { logout as apiLogout, me } from './client'
import { onForbidden } from './session'
import { ApiError, type SessionTenant, type SessionUser } from './types'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error'

interface AuthState {
  status: AuthStatus
  user: SessionUser | null
  tenant: SessionTenant | null
  sessionId: string | null
  permissionVersion: number | null
  /** Set only when `status === 'error'` — a transport failure, not "no session". */
  errorMessage: string | null
}

export interface AuthContextValue extends AuthState {
  /** Re-runs the session check (used by the error state's "Try again"). */
  retry: () => void
  /**
   * Re-runs the session check and resolves once it settles. The login screen calls
   * this — not `retry`, which only schedules the effect — after a successful
   * `POST /auth/login` and awaits it before navigating, so the destination route never
   * renders (or, worse, bounces back to /login) while this provider still believes
   * `status === 'unauthenticated'`.
   */
  syncAfterLogin: () => Promise<void>
  /** Calls `POST /auth/logout`, clears local state, and sends the user to /login. */
  signOut: () => Promise<void>
}

const initialState: AuthState = {
  status: 'loading',
  user: null,
  tenant: null,
  sessionId: null,
  permissionVersion: null,
  errorMessage: null,
}

/*
 * Exported (not just `useAuth`) so apps/web/src/test/harness.tsx can provide a fake,
 * network-free value directly — every ported screen test renders through the harness's
 * `App()`, which reproduces this app's provider tree without a running API, and this is
 * the seam that lets it do that without special-casing every consumer of `useAuth()`.
 */
export const AuthContext = createContext<AuthContextValue | null>(null)

/** Routes reachable with no session — the guard below never redirects away from these. */
const PUBLIC_ROUTES = new Set(['/login', '/unauthorized'])

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialState)
  const [attempt, setAttempt] = useState(0)
  const pathname = usePathname()
  const navigate = useNavigate()
  // Distinguishes "never signed in this tab" from "was signed in, then the session
  // ended" — only the second gets the login page's session-expired banner (§6 of its
  // page document). A ref, not state: it must not itself trigger a re-render.
  const wasAuthenticated = useRef(false)

  const retry = useCallback(() => {
    setState(initialState)
    setAttempt((n) => n + 1)
  }, [])

  // The one place `GET /auth/me` is called. Shared by the on-load effect below and by
  // `syncAfterLogin`, so "what does it mean to have a session" is decided once.
  const checkSession = useCallback(async () => {
    setState((prev) => ({ ...prev, status: 'loading', errorMessage: null }))
    try {
      const session = await me()
      setState({
        status: 'authenticated',
        user: session.user,
        tenant: session.tenant,
        sessionId: session.sessionId,
        permissionVersion: session.permissionVersion,
        errorMessage: null,
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'session_expired') {
        setState({ ...initialState, status: 'unauthenticated' })
        return
      }
      // A network failure is not "no session" — the page says so and offers a retry,
      // it does not silently drop the user onto the login form (04-states.md §4).
      const message =
        err instanceof ApiError
          ? err.message
          : 'Could not verify your session. Check your connection and try again.'
      setState({ ...initialState, status: 'error', errorMessage: message })
    }
  }, [])

  // The silent refresh on load (ADR-0009 / the M1-W brief): `me()` is called with no
  // access token in memory, 401s, `apiFetch` refreshes from the HttpOnly cookie, and
  // retries — restoring the session with no separate "silent refresh" code path.
  // `checkSession` never rejects (its own try/catch always resolves a state), so there
  // is nothing here for an unmount to cancel.
  useEffect(() => {
    void checkSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  useEffect(() => {
    if (state.status === 'authenticated') wasAuthenticated.current = true
  }, [state.status])

  // Session-required guard: any route other than /login and /unauthorized needs an
  // authenticated session client-side. This is a UX affordance only — the server
  // enforces the real authorization on every request regardless (CLAUDE.md).
  useEffect(() => {
    if (state.status !== 'unauthenticated') return
    if (PUBLIC_ROUTES.has(pathname)) return
    const params = new URLSearchParams({ next: pathname })
    if (wasAuthenticated.current) params.set('reason', 'expired')
    navigate(`/login?${params.toString()}`, { replace: true })
  }, [state.status, pathname, navigate])

  // Fixed contract: "403 {error:'forbidden'} -> /unauthorized" — for ANY
  // apiFetch call, not one screen (session.ts's notifyForbidden fires from
  // client.ts alone, with no router of its own). No business screen calls
  // apiFetch yet this increment, so this has no caller in production today;
  // it is exercised directly in apps/web/src/test/auth-context.test.tsx.
  useEffect(() => onForbidden(() => navigate('/unauthorized', { replace: true })), [navigate])

  // An already-authenticated session landing on /login (a valid refresh cookie, a
  // bookmarked /login, a back-button) goes straight to where it was headed instead of
  // re-showing a form there is no need to fill in.
  //
  // Reads `next` from `window.location` directly rather than the router shim's
  // `useSearchParams` — that hook opts its whole subtree out of static rendering unless
  // wrapped in a Suspense boundary (apps/web/src/lib/router.tsx), and AuthProvider sits
  // ABOVE app-frame.tsx's boundary, wrapping the entire application. This effect only
  // runs client-side already, so `window` is safe to read here.
  useEffect(() => {
    if (state.status !== 'authenticated' || pathname !== '/login') return
    const next =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null
    navigate(next || '/dashboard', { replace: true })
  }, [state.status, pathname, navigate])

  const signOut = useCallback(async () => {
    await apiLogout()
    setState({ ...initialState, status: 'unauthenticated' })
    navigate('/login', { replace: true })
  }, [navigate])

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, retry, syncAfterLogin: checkSession, signOut }),
    [state, retry, checkSession, signOut],
  )

  // /login and /unauthorized render immediately regardless of session status — the login
  // page must not wait on a /me round trip to show its form, and /unauthorized must stay
  // reachable however the session check comes out (that is the point of it existing).
  // Every other route renders only once a session is confirmed; otherwise it shows a
  // splash while loading, retries on a transport error, or a blank instant before the
  // redirect effect above sends it to /login.
  const isPublicRoute = PUBLIC_ROUTES.has(pathname)
  const showChildren = isPublicRoute || state.status === 'authenticated'

  return (
    <AuthContext.Provider value={value}>
      {showChildren ? (
        children
      ) : state.status === 'error' ? (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not verify your session</h1>
          <p>{state.errorMessage}</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      ) : (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading Finsoft</h1>
          <p>Restoring your session…</p>
        </div>
      )}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
