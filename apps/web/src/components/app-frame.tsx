'use client'
/* Binds the ported Shell to the app context. The prototype rendered
 * <Shell role setRole>{routes}</Shell> from App(); here the App Router supplies
 * the children and the provider supplies the role. */
import { Suspense, type ReactNode } from 'react'
import { Shell } from './shell'
import { useFinsoft } from '@/app-context'
import { usePathname } from '@/lib/router'

/* /login is not "inside" the application — no sidebar, no top bar, no signed-in
 * identity to show, per docs/design-system/pages/login/README.md §2. Every other
 * route (including /unauthorized) keeps the Shell it always had. */
const NO_SHELL_ROUTES = new Set(['/login'])

export function AppFrame({ children }: { children: ReactNode }) {
  const { role, setRole } = useFinsoft()
  const pathname = usePathname()

  if (NO_SHELL_ROUTES.has(pathname)) {
    return <Suspense fallback={null}>{children}</Suspense>
  }

  return (
    <Shell role={role} setRole={setRole}>
      {/* One boundary, here, for every page.
       *
       * Several screens read query parameters for real — `?q=` on the master
       * lists, `?new=1` to open a create drawer, `?type=` on the voucher
       * screen — and Next requires the component calling useSearchParams to
       * sit inside a Suspense boundary or `next build` fails the page.
       *
       * It goes at the frame/page seam rather than in the root layout,
       * because the Shell itself now needs only the pathname: putting it
       * higher would suspend the navigation chrome too and make the whole
       * application client-rendered on first paint, to fix something the
       * chrome does not do.
       *
       * fallback={null} is deliberate. The Shell is already painted around
       * this, so the frame is on screen; a spinner here would flash inside an
       * otherwise complete layout. */}
      <Suspense fallback={null}>{children}</Suspense>
    </Shell>
  )
}
