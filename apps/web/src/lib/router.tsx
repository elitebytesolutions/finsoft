'use client'
/* react-router-dom compatibility shim over the Next.js App Router.
 *
 * The screens in src/screens/ are ported verbatim from ui-prototype/. Pixel and
 * behaviour parity depends on not touching their JSX, so instead of rewriting
 * ~30 navigation call sites we re-implement the six react-router APIs the
 * prototype actually uses. Delete this file only when the screens are rewritten
 * against next/navigation directly. */
import Link from 'next/link'
import { usePathname, useRouter, useParams as useNextParams, useSearchParams as useNextSearchParams } from 'next/navigation'
import { useEffect, useMemo, type ComponentProps, type ReactNode } from 'react'

/** react-router's navigate(to) / navigate(to, {replace}) / navigate(-1). */
export function useNavigate() {
  const router = useRouter()
  return useMemo(
    () => (to: string | number, opts?: { replace?: boolean }) => {
      if (typeof to === 'number') { if (to < 0) router.back(); else router.forward(); return }
      if (opts?.replace) router.replace(to); else router.push(to)
    },
    [router],
  )
}

/** react-router returns string params; Next can return string[] for catch-alls. */
export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  const params = useNextParams()
  return useMemo(() => {
    const flat: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(params ?? {})) {
      flat[key] = Array.isArray(value) ? value[0] : value
      if (typeof flat[key] === 'string') flat[key] = decodeURIComponent(flat[key] as string)
    }
    return flat as T
  }, [params])
}

export function useLocation() {
  const pathname = usePathname()
  const search = useNextSearchParams()
  const query = search?.toString() ?? ''
  return useMemo(
    () => ({ pathname: pathname ?? '/', search: query ? `?${query}` : '', hash: '', state: null, key: 'default' }),
    [pathname, query],
  )
}

/** react-router's tuple shape, backed by Next's read-only params. */
export function useSearchParams(): [URLSearchParams, (next: URLSearchParams | Record<string, string>) => void] {
  const search = useNextSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const params = useMemo(() => new URLSearchParams(search?.toString() ?? ''), [search])
  const setParams = (next: URLSearchParams | Record<string, string>) => {
    const qs = next instanceof URLSearchParams ? next : new URLSearchParams(next)
    const query = qs.toString()
    router.push(query ? `${pathname}?${query}` : (pathname ?? '/'))
  }
  return [params, setParams]
}

type NavLinkClass = string | ((state: { isActive: boolean; isPending: boolean }) => string)

/* react-router v6 NavLink matching, reproduced exactly.
 *
 * `end` defaults to FALSE, which means a link stays active for its DESCENDANT
 * paths: `/inventory` is active on `/inventory/stock-in`, and `/customers` is
 * active on `/customers/CUS-2201`. An exact-equality check here silently
 * un-highlights the parent nav item on every child route — which is what the
 * sidebar shows on 15 of the 77 routes. Matching is case-insensitive unless
 * `caseSensitive` is set, also per react-router. */
function matchPath(locationPathname: string, toPathname: string, end: boolean, caseSensitive: boolean) {
  let loc = locationPathname
  let to = toPathname
  if (!caseSensitive) { loc = loc.toLowerCase(); to = to.toLowerCase() }
  return loc === to || (!end && loc.startsWith(to) && loc.charAt(to.length) === '/')
}

/** NavLink with react-router's `to` prop and isActive render-prop className. */
export function NavLink({ to, className, children, end = false, caseSensitive = false, ...rest }: { to: string; className?: NavLinkClass; children?: ReactNode; end?: boolean; caseSensitive?: boolean } & Omit<ComponentProps<typeof Link>, 'href' | 'className'>) {
  const pathname = usePathname() ?? '/'
  const target = to.split('?')[0]
  const isActive = matchPath(pathname, target, end, caseSensitive)
  const resolved = typeof className === 'function' ? className({ isActive, isPending: false }) : className
  return <Link href={to} className={resolved} aria-current={isActive ? 'page' : undefined} {...rest}>{children}</Link>
}

export { Link }

/** Declarative redirect. Renders nothing and replaces the entry in history. */
export function Navigate({ to, replace = true }: { to: string; replace?: boolean }) {
  const router = useRouter()
  useEffect(() => { if (replace) router.replace(to); else router.push(to) }, [router, to, replace])
  return null
}
