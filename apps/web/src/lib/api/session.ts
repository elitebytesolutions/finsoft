/* The access token lives here, and nowhere else — never localStorage, never
 * sessionStorage, never a cookie the client can read (ADR-0009: the client holds the
 * access token in memory; the refresh token is a cookie the client never touches).
 *
 * Module-level state rather than React state because non-component code (client.ts's
 * fetch wrapper, called from anywhere) needs to read the current token without being a
 * hook. React components that need to re-render when it changes use `useAccessToken`
 * below, which subscribes to the same store.
 *
 * A hard reload clears this by construction — that is the point, not a bug, and it is
 * why every page load runs a silent refresh (see auth-context.tsx) before deciding
 * whether a session exists. */
import { useSyncExternalStore } from 'react'

let accessToken: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  if (token === accessToken) return
  accessToken = token
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True inside React render/effects only — a live view of whether an access token is held. */
export function useHasAccessToken(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => accessToken !== null,
    () => false, // server snapshot: never authenticated during SSR/first paint
  )
}

type ForbiddenListener = () => void
const forbiddenListeners = new Set<ForbiddenListener>()

/**
 * Fires whenever `apiFetch` (client.ts) receives a 403 — from ANY caller,
 * present or future, not one specific screen. `auth-context.tsx` is the one
 * subscriber and turns it into a redirect to `/unauthorized` (the fixed
 * contract: "403 {error:'forbidden'} -> /unauthorized"). Kept here rather
 * than importing a router into client.ts, which stays router- and
 * React-free so it can be called from anywhere, not only components.
 */
export function onForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener)
  return () => {
    forbiddenListeners.delete(listener)
  }
}

export function notifyForbidden(): void {
  for (const listener of forbiddenListeners) listener()
}
