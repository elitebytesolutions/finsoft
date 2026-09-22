/// <reference types="vite/client" />
/* Rebuilds, for the test environment, the route table that Next's App Router
 * derives from the filesystem at build time.
 *
 * The ported tests render one path at a time via a MemoryRouter-shaped harness
 * (see ./harness.tsx) exactly like the prototype did with react-router-dom's
 * <Routes>. The App Router has no such single component to mount in jsdom, so
 * this module rebuilds an equivalent table straight from apps/web/app/**\/page.tsx
 * using Vite's import.meta.glob — every route the app actually has, with zero
 * duplication of the path list, so it cannot drift from the real app.
 *
 * Segment convention matches Next.js: `[id]` is a dynamic param. The app has no
 * catch-all ([...slug]) or route-group segments today; this file does not need
 * to support them. */
import type { ComponentType } from 'react'

type PageModule = { default: ComponentType }

type Segment = { type: 'static'; value: string } | { type: 'param'; name: string }

type Route = { segments: Segment[]; Component: ComponentType }

const pageModules = import.meta.glob<PageModule>('../../app/**/page.tsx', { eager: true })
const notFoundModules = import.meta.glob<PageModule>('../../app/not-found.tsx', { eager: true })

function toSegments(key: string): Segment[] {
  const rel = key.replace(/^.*\/app\//, '').replace(/\/page\.tsx$/, '')
  if (rel === '') return []
  return rel.split('/').map((part) => {
    const dynamic = /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(part)
    return dynamic ? { type: 'param' as const, name: dynamic[1] } : { type: 'static' as const, value: part }
  })
}

// Ranked so a route with more static (literal) segments is always tried
// before one with fewer, at every shared length — e.g. /vouchers/new before
// /vouchers/[id]. Without this, glob's alphabetical key order tries `[id]`
// first purely because `[` sorts before `n`, and a dynamic segment matches
// *anything* in that position, so it silently swallows every static sibling
// route (/vouchers/new, /reports/studio, /sales/voucher, ...). Next's real
// router always prefers the static segment; this mirrors that rule.
//
// Routes are grouped by segment count and sorted *within* each group only.
// A single Array.sort() across the full ~75-route table doesn't work: a
// comparator that calls unrelated-length pairs "equal" (0) is not
// transitive over the whole array (X of length 3 reads as "equal" to both
// /reports/studio and /reports/[id], which are themselves not equal to each
// other), and Array.sort's output is undefined once transitivity breaks —
// in practice it silently corrupted the ordering of unrelated same-length
// pairs elsewhere in the array. Sorting each length group in isolation keeps
// every comparison the algorithm makes valid.
const parsedRoutes = Object.entries(pageModules).map(([key, mod]) => ({ segments: toSegments(key), Component: mod.default }))
const byLength = new Map<number, Route[]>()
for (const route of parsedRoutes) {
  const group = byLength.get(route.segments.length)
  if (group) group.push(route)
  else byLength.set(route.segments.length, [route])
}
export const routes: Route[] = [...byLength.values()].flatMap((group) =>
  [...group].sort((a, b) => {
    for (let i = 0; i < a.segments.length; i++) {
      const aStatic = a.segments[i].type === 'static'
      const bStatic = b.segments[i].type === 'static'
      if (aStatic !== bStatic) return aStatic ? -1 : 1
    }
    return 0
  }),
)

if (routes.length === 0) {
  throw new Error('route-table: no page.tsx files matched — the glob pattern no longer lines up with apps/web/app')
}

const NotFound = Object.values(notFoundModules)[0]?.default

export type RouteMatch = { Component: ComponentType; params: Record<string, string> }

/** Mirrors Next's own matching: literal segments must match exactly; `[x]`
 * segments capture whatever is in that position. `routes` is pre-sorted so
 * static segments always outrank dynamic ones at the same position — see
 * above — so first match here is genuinely the most specific one. */
export function matchRoute(pathname: string): RouteMatch {
  const parts = pathname.split('/').filter(Boolean)
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < parts.length; i++) {
      const segment = route.segments[i]
      if (segment.type === 'static') {
        if (segment.value !== parts[i]) { matched = false; break }
      } else {
        params[segment.name] = decodeURIComponent(parts[i])
      }
    }
    if (matched) return { Component: route.Component, params }
  }
  if (!NotFound) throw new Error('route-table: no not-found.tsx matched and no route matched ' + pathname)
  return { Component: NotFound, params: {} }
}
