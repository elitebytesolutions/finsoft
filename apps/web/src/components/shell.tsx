'use client'
/* The application shell — sidebar, top bar, role switcher, footer.
 * Ported verbatim from ui-prototype/src/App.tsx (Shell, renderNodes, iconMap).
 * Route children arrive from the App Router instead of <Routes>; nothing else
 * changed, because the sidebar is the most reference-matched surface we have. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, usePathname, useNavigate } from '@/lib/router'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  BookOpen,
  BookUser,
  Boxes,
  CalendarCheck,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Mail,
  Settings,
  ChevronsLeft,
  ClipboardCheck,
  ClipboardList,
  ClipboardPlus,
  Clock3,
  ContactRound,
  Download,
  Eye,
  FileChartColumn,
  FilePlus2,
  FileText,
  HandCoins,
  History,
  Landmark,
  LayoutDashboard,
  Menu,
  PackageCheck,
  Pill,
  Plus,
  Printer,
  ReceiptText,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  TableProperties,
  Truck,
  TrendingUp,
  Users,
  WalletCards,
  Navigation,
  ArrowLeftRight,
  Banknote,
  Barcode,
  BellRing,
  Building2,
  ChartPie,
  Database,
  FolderTree,
  Grid2x2,
  Layers,
  ListChecks,
  LogOut,
  MapPin,
  PackageSearch,
  Percent,
  Scale,
  ShieldAlert,
  Store,
  Tag,
  Target,
  UserCog,
  UsersRound,
  Wallet,
  Warehouse,
  Coins,
  Ellipsis,
  type LucideIcon,
} from 'lucide-react'
import { nav, roles, type NavChild, type NavItem } from '@/mocks/api'
import { Badge, Banner } from '@finsoft/ui'
import { useAuth } from '@/lib/api/auth-context'
import { roleLabel } from '@/lib/adapters/role-label'

const iconMap: Record<string, LucideIcon> = {
  Printer,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  Barcode,
  Bell,
  BellRing,
  BookOpen,
  BookUser,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarDays,
  ChartNoAxesCombined,
  ChartPie,
  ClipboardCheck,
  ClipboardList,
  ClipboardPlus,
  Clock3,
  ContactRound,
  Database,
  Download,
  Eye,
  FileChartColumn,
  FilePlus2,
  FileText,
  FolderTree,
  Grid2x2,
  HandCoins,
  History,
  Landmark,
  Layers,
  LayoutDashboard,
  ListChecks,
  MapPin,
  PackageCheck,
  PackageSearch,
  Percent,
  Pill,
  ReceiptText,
  Navigation,
  Scale,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Store,
  Coins,
  TableProperties,
  Tag,
  Target,
  TrendingUp,
  Truck,
  UserCog,
  Users,
  UsersRound,
  Wallet,
  WalletCards,
  Warehouse,
}

/*
 * Routes that actually call the real API. Everything else still renders from
 * `@/mocks/*` (PRD §6.1: "existing mock screens are prototypes, not delivered
 * functionality") and gets the persistent prototype banner below. As real
 * screens land they are added here, one line each — nothing else about the
 * banner changes.
 *
 * An entry ending in `/*` matches that path AND any dynamic sub-path
 * (`/vouchers/*` covers `/vouchers/new` and `/vouchers/:id` alike) — added
 * for M2-S, since API_BACKED_ROUTES was exact-match-only while every route it
 * held was a leaf. Everything else is still an exact match.
 */
const API_BACKED_ROUTES: string[] = [
  '/accounts',
  '/ledgers',
  '/cash-book',
  '/trial-balance',
  '/vouchers',
  '/vouchers/*',
  '/period-close',
  // M4-W
  '/customers',
  '/customers/*',
  '/admin-audit',
]

function isApiBackedRoute(path: string): boolean {
  return API_BACKED_ROUTES.some((entry) =>
    entry.endsWith('/*') ? path.startsWith(entry.slice(0, -1)) : path === entry,
  )
}

const chevCls = (open: boolean) => 'chev ' + (open ? 'down' : '')
function renderNodes(
  nodes: NavChild[],
  prefix: string,
  depth: number,
  ctx: { closed: Set<string>; open: (k: string) => void; go: () => void },
): ReactNode {
  return (
    <>
      {nodes.map((n) => {
        const key = prefix + '|' + n.label
        const kids = n.children ?? []
        const I = n.icon ? iconMap[n.icon] : undefined
        if (kids.length) {
          const open = !ctx.closed.has(key)
          return (
            <div className={`sb-node ${open ? 'open' : ''}`} key={key}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  ctx.open(key)
                  ctx.go()
                }}
                className={`sb-leaf sb-leaf-btn ${open ? 'open' : ''}`}
              >
                <span className="sb-dot" />
                <span className="sb-leaf-icon">{I ? <I /> : null}</span>
                <span className="sb-leaf-label">{n.label}</span>
                <ChevronRight className={chevCls(open)} />
              </button>
              <div className="sb-subbox">
                <div className="sb-clip">
                  <div className={`sb-children d${Math.min(depth, 3)}`}>
                    {renderNodes(kids, key, depth + 1, ctx)}
                  </div>
                </div>
              </div>
            </div>
          )
        }
        return (
          <NavLink
            key={key}
            to={n.path ?? '/'}
            onClick={ctx.go}
            className={({ isActive }) => `sb-leaf ${isActive ? 'active' : ''}`}
          >
            <span className="sb-dot" />
            <span className="sb-leaf-icon">{I ? <I /> : null}</span>
            <span className="sb-leaf-label">{n.label}</span>
          </NavLink>
        )
      })}
    </>
  )
}
export function Shell({
  children,
  role,
  setRole,
}: {
  children: ReactNode
  role: string
  setRole: (v: string) => void
}) {
  const pathname = usePathname(),
    navigate = useNavigate()
  const path = pathname.split('?')[0]
  const { user, tenant, signOut, permissions } = useAuth()
  const isApiBacked = isApiBackedRoute(path)
  const [collapsed, setCollapsed] = useState(false),
    [mobileOpen, setMobileOpen] = useState(false),
    [global, setGlobal] = useState(''),
    [notifications, setNotifications] = useState(false),
    [modQuery, setModQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(() => {
    const s = new Set<string>()
    const here = pathname
    const holds = (n: NavChild): boolean => n.path === here || (n.children ?? []).some(holds)
    const seed = (nodes: NavChild[], prefix: string) => {
      for (const n of nodes) {
        if ((n.children ?? []).length) {
          const k = prefix + '|' + n.label
          if (!holds(n)) s.add(k)
          seed(n.children ?? [], k)
        }
      }
    }
    for (const grp of nav) seed(grp.items as unknown as NavChild[], grp.group)
    return s
  })
  const [createOpen, setCreateOpen] = useState(false)
  const createRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!createOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCreateOpen(false)
      }
    }
    const onOutside = (e: MouseEvent) => {
      if (createRef.current && !createRef.current.contains(e.target as Node)) setCreateOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onOutside)
    }
  }, [createOpen])
  const allowed = (perm?: string) =>
    !perm || roles[role]?.includes('all') || roles[role]?.includes(perm)
  useEffect(() => {
    const q = modQuery.trim().toLowerCase()
    if (!q) return
    const keys: string[] = []
    const walk = (nodes: NavChild[], prefix: string): boolean => {
      let hit = false
      for (const n of nodes) {
        const k = prefix + '|' + n.label
        const self = n.label.toLowerCase().includes(q)
        const kids = n.children ?? []
        const deep = walk(kids, k)
        if (kids.length && (self || deep)) keys.push(k)
        if (self || deep) hit = true
      }
      return hit
    }
    for (const grp of nav) walk(grp.items as unknown as NavChild[], grp.group)
    if (!keys.length) return
    const t = setTimeout(
      () =>
        setClosed((prev) => {
          const n = new Set(prev)
          for (const k of keys) n.delete(k)
          return n
        }),
      0,
    )
    return () => clearTimeout(t)
  }, [modQuery])
  const toggleOpen = (key: string) =>
    setClosed((prev) => {
      const n = new Set(prev)
      if (n.has(key)) {
        n.delete(key)
      } else {
        n.add(key)
      }
      return n
    })
  const nodeHit = (n: NavChild, q: string): boolean => {
    const hit = (t: string) => t.toLowerCase().includes(q)
    return hit(n.label) || (n.children ?? []).some((c) => nodeHit(c, q))
  }
  const searchHit = (it: NavItem) =>
    !modQuery ||
    it.label.toLowerCase().includes(modQuery.toLowerCase()) ||
    (it.children ?? []).some((c) => nodeHit(c, modQuery.toLowerCase()))
  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className="sidebar sb">
        <div className="sb-brand">
          <span className="sb-mark">
            <Activity />
          </span>
          <div className="sb-brand-text">
            <b>Finsoft</b>
            <small>Bhatti Traders</small>
          </div>
          <button
            type="button"
            aria-label="Collapse navigation"
            onClick={() => setCollapsed(!collapsed)}
            className="sb-collapse"
          >
            <ChevronsLeft />
          </button>
        </div>
        <label className="sb-search">
          <Search />
          <input
            aria-label="Search anything"
            value={modQuery}
            onChange={(e) => setModQuery(e.target.value)}
            placeholder="Search anything..."
          />
          <kbd>⌘ K</kbd>
        </label>
        <nav className="sb-nav">
          {nav.map((group) => {
            const prune = (n: NavChild): NavChild | null => {
              if ((n.children ?? []).length) {
                const kids = (n.children ?? []).map(prune).filter((x): x is NavChild => !!x)
                return kids.length ? { ...n, children: kids } : null
              }
              return allowed(n.perm) ? n : null
            }
            const items = group.items
              .map(prune)
              .filter((x): x is NavItem => !!x)
              .filter(searchHit)
            if (!items.length) return null
            const ctx = { closed, open: toggleOpen, go: () => setMobileOpen(false) }
            const holds = (n: NavChild): boolean =>
              (!!n.path && n.path.split('?')[0] === path) || (n.children ?? []).some(holds)
            if (!group.group) {
              return (
                <div className="sb-tiles" key="tiles">
                  {items.map((it) => {
                    const Icon = it.icon ? iconMap[it.icon] : undefined
                    const tileLabel = it.desc ? `${it.label} — ${it.desc}` : it.label
                    return it.path ? (
                      <NavLink
                        key={it.label}
                        to={it.path}
                        onClick={() => setMobileOpen(false)}
                        className={({ isActive }) => `sb-tile ${isActive ? 'active' : ''}`}
                        title={tileLabel}
                        aria-label={tileLabel}
                      >
                        <span className="sb-tile-icon" aria-hidden="true">
                          {Icon && <Icon />}
                        </span>
                        <span className="sb-tile-text" aria-hidden="true">
                          <b>{it.label}</b>
                          {it.desc && <small>{it.desc}</small>}
                        </span>
                      </NavLink>
                    ) : null
                  })}
                </div>
              )
            }
            const GIcon = group.icon ? iconMap[group.icon] : undefined
            return (
              <div className="sb-group" key={group.group}>
                <div className="sb-section">
                  <span className="sb-section-title">{group.group}</span>
                  <i className="sb-section-line" />
                  {group.tagline && (
                    <span className="sb-section-tag">
                      {GIcon && <GIcon />}
                      <span>{group.tagline}</span>
                    </span>
                  )}
                </div>
                <div className="sb-modules">
                  {items.map((it) => {
                    const Icon = it.icon ? iconMap[it.icon] : undefined
                    if ((it.children ?? []).length) {
                      const key = group.group + '|' + it.label
                      const isOpen = !closed.has(key)
                      const current = (it.children ?? []).some(holds)
                      return (
                        <div
                          className={`sb-module ${isOpen ? 'open' : ''} ${current ? 'current' : ''}`}
                          key={it.label}
                        >
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => {
                              toggleOpen(key)
                              setMobileOpen(false)
                            }}
                            className={`sb-head ${isOpen ? 'open' : ''}`}
                          >
                            <span className="sb-head-icon">{Icon && <Icon />}</span>
                            <span className="sb-head-text">
                              <b>{it.label}</b>
                              <small>{it.desc}</small>
                            </span>
                            <ChevronRight className={chevCls(isOpen)} />
                          </button>
                          <div className="sb-subbox">
                            <div className="sb-clip">
                              <div className="sb-children d1">
                                {renderNodes(it.children ?? [], key, 2, ctx)}
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    }
                    return it.path ? (
                      <NavLink
                        onClick={() => setMobileOpen(false)}
                        key={it.label}
                        to={it.path}
                        className={({ isActive }) =>
                          `sb-module sb-link ${isActive ? 'active' : ''}`
                        }
                      >
                        <span className="sb-head-icon plain">{Icon && <Icon />}</span>
                        <span className="sb-head-text">
                          <b>{it.label}</b>
                          <small>{it.desc}</small>
                        </span>
                        <ChevronRight className="chev" />
                      </NavLink>
                    ) : null
                  })}
                </div>
              </div>
            )
          })}
        </nav>
        <div className="sb-foot">
          <span className="sb-avatar">{(tenant?.name ?? 'Finsoft').slice(0, 2).toUpperCase()}</span>
          <div className="sb-foot-text">
            <b>{tenant?.name ?? 'Finsoft'}</b>
            <small>{user?.fullName ?? 'Signed in'}</small>
          </div>
          <button
            type="button"
            className="sb-more"
            aria-label="Account menu"
            onClick={() => navigate('/settings')}
          >
            <Ellipsis />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button aria-label="Open navigation" className="menu" onClick={() => setMobileOpen(true)}>
            <Menu />
          </button>
          <div className="top-brand">
            <span className="brandmark">
              <Activity />
            </span>
            <div>
              <b>
                Fin<span>soft</span>
              </b>
              <small>Smarter Accounting for a Brighter Tomorrow</small>
            </div>
          </div>
          <button type="button" className="company-pick">
            <Building2 />
            <span>{tenant?.name ?? 'Finsoft'}</span>
            <ChevronDown />
          </button>
          <label className="global-search">
            <Search />
            <input
              value={global}
              onChange={(e) => setGlobal(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && navigate(`/products?q=${encodeURIComponent(global)}`)
              }
              placeholder="Search anything... (Customers, Invoices, Payments, Products, Reports)"
            />
            <kbd>Ctrl + K</kbd>
          </label>
          <div className="top-actions">
            <div ref={createRef} className="create-new-wrap">
              <button
                type="button"
                className="create-new"
                aria-haspopup="true"
                aria-expanded={createOpen}
                onClick={() => setCreateOpen((o) => !o)}
              >
                <Plus />
                <span>Create New</span>
                <ChevronDown className={createOpen ? 'create-chev open' : 'create-chev'} />
              </button>
              {createOpen && (
                <div className="create-menu" role="menu" aria-label="Create new">
                  {allowed('Cash, Bank & GL') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/vouchers/new')
                      }}
                    >
                      <span className="create-item-icon">
                        <FilePlus2 />
                      </span>
                      <span className="create-item-body">
                        <b>Journal Voucher</b>
                        <small>New GL / cash / bank entry</small>
                      </span>
                    </button>
                  )}
                  {allowed('Sales & POS') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/sales/voucher')
                      }}
                    >
                      <span className="create-item-icon tone-sales">
                        <ShoppingCart />
                      </span>
                      <span className="create-item-body">
                        <b>Sales Voucher</b>
                        <small>Invoice a customer</small>
                      </span>
                    </button>
                  )}
                  {allowed('Purchasing') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/purchasing/voucher')
                      }}
                    >
                      <span className="create-item-icon tone-purchase">
                        <ShoppingBag />
                      </span>
                      <span className="create-item-body">
                        <b>Purchase Voucher</b>
                        <small>Record a supplier bill</small>
                      </span>
                    </button>
                  )}
                  {allowed('Cash, Bank & GL') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/payments')
                      }}
                    >
                      <span className="create-item-icon tone-payment">
                        <WalletCards />
                      </span>
                      <span className="create-item-body">
                        <b>Payment / Receipt</b>
                        <small>Record a payment or receipt</small>
                      </span>
                    </button>
                  )}
                  <div className="create-divider" role="separator" />
                  {allowed('Masters') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/customers')
                      }}
                    >
                      <span className="create-item-icon tone-party">
                        <Users />
                      </span>
                      <span className="create-item-body">
                        <b>Customer</b>
                        <small>Add a new customer account</small>
                      </span>
                    </button>
                  )}
                  {allowed('Masters') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/vendors')
                      }}
                    >
                      <span className="create-item-icon tone-party">
                        <ContactRound />
                      </span>
                      <span className="create-item-body">
                        <b>Vendor</b>
                        <small>Add a new supplier account</small>
                      </span>
                    </button>
                  )}
                  {allowed('Products') && (
                    <button
                      role="menuitem"
                      className="create-item"
                      onClick={() => {
                        setCreateOpen(false)
                        navigate('/products')
                      }}
                    >
                      <span className="create-item-icon tone-product">
                        <Pill />
                      </span>
                      <span className="create-item-body">
                        <b>Product</b>
                        <small>Add to the product catalogue</small>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              aria-label="Notifications"
              className="icon-btn"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell />
              <i>3</i>
            </button>
            <button aria-label="Messages" className="icon-btn">
              <Mail />
            </button>
            <button aria-label="Help" className="icon-btn">
              <CircleHelp />
            </button>
            <button
              aria-label="Settings"
              className="icon-btn"
              onClick={() => navigate('/settings')}
            >
              <Settings />
            </button>
            <label className="user-menu">
              <span className="avatar">
                {(user?.fullName ?? 'Signed in').slice(0, 2).toUpperCase()}
              </span>
              <div>
                <b>{user?.fullName ?? 'Signed in'}</b>
                {/* M4-W: the real role, derived from GET /api/me/permissions — never the
                    mock role switcher. A screen not yet wired to real permissions still
                    reads the mock `role`/`can(module)` below for its own gating; only the
                    header display and the switcher control itself changed. */}
                <small>{roleLabel(permissions)}</small>
              </div>
              <ChevronDown />
            </label>
            <button
              type="button"
              aria-label="Sign out"
              className="icon-btn"
              onClick={() => {
                void signOut()
              }}
            >
              <LogOut />
            </button>
          </div>
          {notifications && (
            <div className="notification-pop">
              <h3>
                Notifications <Badge tone="info">3 new</Badge>
              </h3>
              <p>
                <AlertTriangle />
                Augmentin is below reorder level.
              </p>
              <p>
                <Clock3 />2 cheques clear this week.
              </p>
              <p>
                <PackageCheck />
                PO-1048 was received.
              </p>
            </div>
          )}
        </header>
        {!isApiBacked && (
          // Non-dismissible by design (docs/briefs/M1-W-web-infra.md item 4) — this is a
          // fact about the screen, not a notice a user can dismiss and forget. Every
          // screen renders it except /login (outside <Shell> entirely, app-frame.tsx)
          // and any route added to API_BACKED_ROUTES above once it is real.
          <Banner tone="warn">Prototype — demo data, not connected to the ledger.</Banner>
        )}
        <div
          className={`content ${/^\/(vouchers|recurring)(\/|$)/.test(path) ? 'content-mint' : ''}`}
        >
          {children}
        </div>
        <footer className="app-footer">
          <span>Finsoft ERP v1.0.0</span>
          <b>Bhatti Traders — Pharmacy, Trading &amp; Financial Management</b>
          <span>Multi-Branch · Multi-Currency · Batch/Expiry Aware · Double-Entry GL</span>
        </footer>
      </main>
    </div>
  )
}
