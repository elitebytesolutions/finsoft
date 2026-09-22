import '@testing-library/jest-dom/vitest'
import React from 'react'
import { vi } from 'vitest'
import { useRouterNavigate, useRouterState } from './router-store'

/* Global test-environment mocks for the two Next.js modules the production
 * router shim (apps/web/src/lib/router.tsx — out of bounds for this task)
 * imports directly: next/navigation and next/link. Both read the per-mount
 * router store from React context (./router-store.ts, provided by the
 * MemoryRouter test harness in ./harness.tsx), so a click that calls
 * useNavigate() and a click on a NavLink end up changing the same store —
 * and two concurrently-mounted <MemoryRouter> trees (a test that renders
 * twice without cleanup() in between) never see each other's navigation.
 *
 * DECISION: mock next/navigation + next/link rather than render inside a real
 * Next.js App Router context. There is no supported way to mount Next's real
 * RouterContext in jsdom outside of `next dev`/`next start`, and the router
 * shim only touches six hooks/components from these two modules — small
 * enough to reimplement faithfully and reactively, which keeps every ported
 * assertion byte-for-byte unchanged. */
vi.mock('next/navigation', () => ({
  usePathname: () => useRouterState().pathname,
  useSearchParams: () => new URLSearchParams(useRouterState().search),
  useParams: () => useRouterState().params,
  useRouter: () => {
    const navigate = useRouterNavigate()
    return {
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => navigate(-1),
      forward: () => navigate(1),
      prefetch: () => {},
      refresh: () => {},
    }
  },
}))

type NextHref = string | { pathname?: string; search?: string }

type LinkMockProps = Omit<React.ComponentPropsWithoutRef<'a'>, 'href'> & { href: NextHref }

function resolveHref(href: NextHref): string {
  if (typeof href === 'string') return href
  return `${href.pathname ?? '/'}${href.search ?? ''}`
}

vi.mock('next/link', () => ({
  default: React.forwardRef<HTMLAnchorElement, LinkMockProps>(function Link(
    { href, onClick, children, ...rest },
    ref,
  ) {
    const navigate = useRouterNavigate()
    const resolved = resolveHref(href)
    return (
      <a
        {...rest}
        ref={ref}
        href={resolved}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          navigate(resolved)
        }}
      >
        {children}
      </a>
    )
  }),
}))
