'use client'
/*
 * /accounts — the PO's original design (8c5c283), restored. See the M2-UI report's DECISIONS
 * for the full account of what changed and why; the short version:
 *
 *   - Data: GET /api/accounts (the tree) + GET /api/reports/trial-balance (balances) — same
 *     two calls M2-S's read-only rewrite used — reshaped by
 *     `@/lib/adapters/chart-of-accounts` into the `Master`-like shape this screen's own
 *     tree-walking code expects, so that code did not need to change.
 *   - No browser-side accounting: every balance on screen is `adaptChartOfAccounts`'s
 *     `rollup()`, which only sums already-server-computed trial-balance totals with `Money`
 *     — never journals, never a locally invented "opening + this period's movement".
 *   - Fields the mock invented that the real API does not carry — per-row "Last Modified",
 *     "Change vs last period", city, contact — render as "—", never a fabricated value
 *     (CLAUDE.md, "Every screen handles every state" / "never fake data").
 *   - Add/Edit/Move/Activate/Deactivate/Delete/Import: kept, per the PO's brief ("Keep the
 *     original UI for these... wire behind ACCOUNT_CREATE_ENABLED"). The chart is read-only
 *     server-side in M2 (coa-standard.md §5) — every one of these is `disabled` while the flag
 *     is off, with a tooltip, not deleted.
 */
import { useState } from 'react'
import type React from 'react'
import { useNavigate } from '@/lib/router'
import {
  Activity,
  BarChart3,
  BookOpen,
  Boxes,
  Briefcase,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Coins,
  Database,
  EllipsisVertical,
  FileText,
  Filter,
  FolderOpen,
  FolderTree,
  Landmark,
  LayoutGrid,
  List,
  ListTree,
  Network,
  Pencil,
  PieChart,
  Plus,
  RotateCw,
  Search,
  Settings,
  ShieldAlert,
  ShoppingBag,
  Table2,
  Tag,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  WalletCards,
  X,
  Download,
} from 'lucide-react'
import { Banner, Button, Modal, moneyFromString } from '@finsoft/ui'
import type { Master } from '@/mocks/api'
import { MasterModal } from './master-form'
import { listAccounts, getTrialBalance } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { todayIso } from '@/lib/date/local-date'
import { ACCOUNT_CREATE_ENABLED } from '@/lib/feature-flags'
import {
  adaptChartOfAccounts,
  formatBalance,
  type AdaptedAccount,
} from '@/lib/adapters/chart-of-accounts'

const descriptions: Record<string, string> = {
  Assets: 'Resources controlled by the company',
  'Current Assets': 'Assets expected to be converted to cash within a year',
  'Cash Accounts': 'Cash and cash equivalents',
  'Bank Accounts': 'Bank balances and deposits',
  Receivables: 'Amounts due from customers',
  Inventory: 'Goods available for sale',
  'Non-current Assets': 'Long-term assets and investments',
  Liabilities: 'Obligations to external parties',
  Equity: "Owner's residual interest",
  Income: 'Revenue from operations',
  Expenses: 'Costs of running the business',
  'Trade Payables': 'Amounts owed to suppliers',
  'Trade Receivables': 'Receivables from trade customers',
  'Stock in Trade': 'Inventory held for resale',
}
const iconOf = (m: AdaptedAccount) => {
  const n = m.name
  if (m.level === 1)
    return n === 'Assets'
      ? Database
      : n === 'Liabilities'
        ? Landmark
        : n === 'Equity'
          ? PieChart
          : n === 'Income'
            ? BarChart3
            : Briefcase
  if (n.includes('Bank')) return Landmark
  if (n.includes('Cash')) return WalletCards
  if (n.includes('Receivable')) return Users
  if (n.includes('Inventory') || n.includes('Stock')) return Boxes
  if (n.includes('Payable')) return ShoppingBag
  if (m.kind === 'Group') return FolderOpen
  return FileText
}
const toneOf = (m: AdaptedAccount) => {
  const n = m.name
  if (n.includes('Inventory') || n.includes('Stock') || n === 'Expenses') return 'orange'
  if (n.includes('Bank') || n.includes('Receivable') || n === 'Equity' || n === 'Income')
    return 'blue'
  if (n === 'Liabilities') return 'red'
  return 'green'
}

async function loadChart() {
  const asOf = todayIso()
  const [accountsRes, trialBalance] = await Promise.all([listAccounts(), getTrialBalance(asOf)])
  const adapted = adaptChartOfAccounts(accountsRes.accounts, trialBalance.lines)
  return { accounts: adapted.accounts, rollup: adapted.rollup, asOf }
}

export function ChartOfAccounts() {
  const { state, reload } = useApiQuery(loadChart, [])

  return (
    <div className="coa2">
      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading the chart of accounts…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view the chart of accounts.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the chart of accounts</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' &&
        (state.data.accounts.length === 0 ? (
          <div className="empty-state">
            No accounts yet. Every tenant is seeded with the standard chart at provisioning — this
            is unexpected; contact support if it persists.
          </div>
        ) : (
          <ChartReady data={state.data} />
        ))}
    </div>
  )
}

function ChartReady({ data }: { data: Awaited<ReturnType<typeof loadChart>> }) {
  const navigate = useNavigate()
  const { accounts, rollup, asOf } = data
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState('all'),
    [type, setType] = useState('All Types'),
    [status, setStatus] = useState('All Statuses'),
    [level, setLevel] = useState('All Levels')
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(accounts.filter((a) => a.level <= 2).map((a) => a.code)),
  )
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<null | { level: number; parent?: string; type: string }>(null)
  const [del, setDel] = useState<AdaptedAccount | null>(null)
  const [view, setView] = useState<'table' | 'map'>('table')
  const [density, setDensity] = useState<'list' | 'comfy' | 'grid'>('comfy')
  const [nameWidth, setNameWidth] = useState(() => {
    try {
      return Number(localStorage.getItem('coa-name-width')) || 420
    } catch {
      return 420
    }
  })
  const startResize = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    const startX = e.clientX,
      start = nameWidth
    const move = (ev: PointerEvent) =>
      setNameWidth(Math.max(240, Math.min(900, start + ev.clientX - startX)))
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      setNameWidth((w) => {
        try {
          localStorage.setItem('coa-name-width', String(w))
        } catch {
          /* ignore */
        }
        return w
      })
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }
  const [rowsPer, setRowsPer] = useState(50),
    [page, setPage] = useState(1)
  const [notice, setNotice] = useState('')
  const comingSoon = () =>
    setNotice('Not available yet — account creation and editing await the Accounting spec and API.')
  const childrenOf = (p: string) => accounts.filter((m) => m.parent === p)
  const matches = (m: AdaptedAccount): boolean => {
    const q = query.toLowerCase()
    const self =
      (!q || `${m.code} ${m.name}`.toLowerCase().includes(q)) &&
      (type === 'All Types' || m.kind === type) &&
      (status === 'All Statuses' || m.status === status) &&
      (level === 'All Levels' || String(m.level) === level.slice(-1))
    return self || childrenOf(m.code).some(matches)
  }
  const toggle = (code: string) =>
    setOpen((v) => {
      const n = new Set(v)
      if (n.has(code)) n.delete(code)
      else n.add(code)
      return n
    })
  const flat: { m: AdaptedAccount; depth: number; last: boolean; trail: boolean[] }[] = []
  const walk = (parent: string | null, depth: number, trail: boolean[]) => {
    const kids = accounts
      .filter(
        (m) =>
          (m.parent ?? null) === parent && (depth > 1 || category === 'all' || m.code === category),
      )
      .filter(matches)
    kids.forEach((m, i) => {
      const last = i === kids.length - 1
      flat.push({ m, depth, last, trail })
      if (open.has(m.code) || query) walk(m.code, depth + 1, [...trail, !last])
    })
  }
  walk(null, 1, [])
  const pages = Math.max(1, Math.ceil(flat.length / rowsPer)),
    cur = Math.min(page, pages),
    rows = flat.slice((cur - 1) * rowsPer, cur * rowsPer)
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.m.code))
  const toggleSel = (code: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(code)) n.delete(code)
      else n.add(code)
      return n
    })
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s)
      if (allChecked) rows.forEach((r) => n.delete(r.m.code))
      else rows.forEach((r) => n.add(r.m.code))
      return n
    })
  const reset = () => {
    setQuery('')
    setCategory('all')
    setType('All Types')
    setStatus('All Statuses')
    setLevel('All Levels')
    setPage(1)
  }
  const roots = accounts.filter((m) => m.level === 1)
  const totals = roots.map((r) => [r.code, `Total ${r.name}`, toneOf(r), iconOf(r)] as const)

  return (
    <>
      <div className="coa2-head">
        <div className="coa2-title">
          <span className="coa2-title-icon">
            <BookOpen />
          </span>
          <div>
            <h1>Chart of Accounts</h1>
            <p>Organise accounts into a four-level chart. Balances as of {asOf}.</p>
          </div>
        </div>
        <div className="coa2-tools">
          <label className="coa2-search">
            <Search />
            <input
              aria-label="Search accounts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="Search accounts, codes, or keywords..."
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="coa2-seg">
            <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
              <Table2 /> Table View
            </button>
            <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
              <Network /> Hierarchy Map
            </button>
          </div>
          <label className="coa2-select">
            <Filter />
            <select
              aria-label="Account category"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value)
                setPage(1)
              }}
            >
              <option value="all">All Accounts</option>
              {roots.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <div className="coa2-io">
            <button
              className="coa2-btn"
              disabled={!ACCOUNT_CREATE_ENABLED}
              title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
              onClick={comingSoon}
            >
              <Upload /> Import
            </button>
            <button
              className="coa2-btn"
              onClick={() => setNotice(`Exported ${flat.length} accounts.`)}
            >
              <Download /> Export
            </button>
          </div>
        </div>
        <button
          className="coa2-btn primary coa2-add"
          disabled={!ACCOUNT_CREATE_ENABLED}
          title={
            !ACCOUNT_CREATE_ENABLED
              ? 'Coming soon — the Accounting spec and API are in progress'
              : undefined
          }
          onClick={() =>
            ACCOUNT_CREATE_ENABLED ? setModal({ level: 1, type: 'Asset' }) : comingSoon()
          }
        >
          <Plus /> Add Account
        </button>
      </div>

      {!ACCOUNT_CREATE_ENABLED && (
        <Banner tone="info">
          Adding, editing, moving and deactivating accounts is not available yet — the chart is
          read-only until the Accounting spec and API ship. See{' '}
          <a
            href="https://github.com/elitebytesolutions/finsoft/blob/develop/docs/posting-rules/coa-standard.md"
            target="_blank"
            rel="noreferrer"
          >
            coa-standard.md §5
          </a>
          .
        </Banner>
      )}

      <div className="coa2-stats">
        {totals.map(([code, label, tone, Icon]) => (
          <article key={code} className={tone}>
            <span className="coa2-stat-icon">
              <Icon />
            </span>
            <div>
              <small>{label}</small>
              <b>{formatBalance(rollup(code))}</b>
            </div>
          </article>
        ))}
        <article className="green">
          <span className="coa2-stat-icon">
            <BarChart3 />
          </span>
          <div>
            <small>Total Accounts</small>
            <b>{accounts.length}</b>
          </div>
        </article>
      </div>

      <div className="coa2-toolbar">
        <label className="coa2-check big">
          <input
            type="checkbox"
            aria-label="Select all visible"
            checked={allChecked}
            onChange={toggleAll}
          />
          <i>
            <Check />
          </i>
        </label>
        <b className="coa2-selcount">{selected.size} selected</b>
        <span className="coa2-vsep" />
        <button
          className="coa2-btn"
          disabled={!selected.size || !ACCOUNT_CREATE_ENABLED}
          title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
          onClick={comingSoon}
        >
          <Pencil /> Edit
        </button>
        <button
          className="coa2-btn"
          disabled={!selected.size || !ACCOUNT_CREATE_ENABLED}
          title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
          onClick={comingSoon}
        >
          <FolderTree /> Move
        </button>
        <button
          className="coa2-btn"
          disabled={!selected.size || !ACCOUNT_CREATE_ENABLED}
          title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
          onClick={comingSoon}
        >
          <Check /> Activate
        </button>
        <button
          className="coa2-btn"
          disabled={!selected.size || !ACCOUNT_CREATE_ENABLED}
          title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
          onClick={comingSoon}
        >
          <X /> Deactivate
        </button>
        <button
          className="coa2-btn danger"
          disabled={selected.size !== 1 || !ACCOUNT_CREATE_ENABLED}
          title={!ACCOUNT_CREATE_ENABLED ? 'Coming soon' : undefined}
          onClick={() => {
            if (!ACCOUNT_CREATE_ENABLED) return comingSoon()
            const m = accounts.find((a) => selected.has(a.code))
            if (m) setDel(m)
          }}
        >
          <Trash2 /> Delete
        </button>
        <div className="coa2-toolbar-right">
          <label className="coa2-select plain">
            <select aria-label="Type filter" value={type} onChange={(e) => setType(e.target.value)}>
              {['All Types', 'Header', 'Group', 'Postable'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="coa2-select plain">
            <select
              aria-label="Status filter"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {['All Statuses', 'Active', 'Inactive'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="coa2-select plain">
            <select
              aria-label="Level filter"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              {['All Levels', 'Level 1', 'Level 2', 'Level 3', 'Level 4'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <button className="coa2-btn" onClick={reset}>
            Reset
          </button>
          <div className="coa2-seg icons">
            <button
              aria-label="List view"
              className={density === 'list' ? 'active' : ''}
              onClick={() => setDensity('list')}
            >
              <List />
            </button>
            <button
              aria-label="Comfortable view"
              className={density === 'comfy' ? 'active' : ''}
              onClick={() => setDensity('comfy')}
            >
              <ListTree />
            </button>
            <button
              aria-label="Grid view"
              className={density === 'grid' ? 'active' : ''}
              onClick={() => setDensity('grid')}
            >
              <LayoutGrid />
            </button>
          </div>
          <button className="coa2-btn icon" aria-label="Table settings">
            <Settings />
          </button>
        </div>
      </div>
      {notice && (
        <p className="coa2-notice" role="status">
          {notice}
        </p>
      )}

      {view === 'map' ? (
        <section className="coa2-map">
          <div className="coa2-map-main">
            {roots
              .filter((m) => childrenOf(m.code).length > 0)
              .map((root) => {
                const RootIcon = iconOf(root),
                  tone = toneOf(root),
                  subs = childrenOf(root.code)
                return (
                  <div key={root.code} className="coa2-map-branch">
                    <div
                      className={`coa2-map-root-card tone-${tone}`}
                      role="region"
                      aria-label={root.name}
                    >
                      <span className={`coa2-map-root-icon tone-${tone}`} aria-hidden="true">
                        <RootIcon />
                      </span>
                      <div className="coa2-map-root-body">
                        <div className="coa2-map-root-top">
                          <div className="coa2-map-root-name">
                            <b>{root.name}</b>
                            <code>{root.code}</code>
                          </div>
                          <span className="coa2-kind header sm">Header</span>
                        </div>
                        <div className="coa2-map-root-foot">
                          <span className="coa2-map-subcount">
                            {subs.length} sub-type{subs.length !== 1 ? 's' : ''}
                          </span>
                          <span className="coa2-map-bal">{formatBalance(rollup(root.code))}</span>
                        </div>
                      </div>
                    </div>
                    {subs.length > 0 && (
                      <div className="coa2-map-l2-list" role="list">
                        {subs.map((sub, si, sarr) => {
                          const SubIcon = iconOf(sub),
                            grps = childrenOf(sub.code)
                          return (
                            <div
                              key={sub.code}
                              className={`coa2-map-l2-item${si === sarr.length - 1 ? ' last' : ''}`}
                              role="listitem"
                            >
                              <div className="coa2-map-l2-card">
                                <span
                                  className={`coa2-map-l2-icon tone-${tone}`}
                                  aria-hidden="true"
                                >
                                  <SubIcon />
                                </span>
                                <div className="coa2-map-l2-body">
                                  <b>{sub.name}</b>
                                  <div className="coa2-map-l2-foot">
                                    <code className="coa2-map-code">{sub.code}</code>
                                    <span className="coa2-kind group sm">{sub.kind}</span>
                                    <span className="coa2-map-bal">
                                      {formatBalance(rollup(sub.code))}
                                    </span>
                                  </div>
                                  {grps.length > 0 && (
                                    <div className="coa2-map-l3-list" role="list">
                                      {grps.map((grp, gi, garr) => {
                                        const GrpIcon = iconOf(grp),
                                          kids = childrenOf(grp.code).length
                                        return (
                                          <div
                                            key={grp.code}
                                            className={`coa2-map-l3-item${gi === garr.length - 1 ? ' last' : ''}`}
                                            role="listitem"
                                          >
                                            <div className="coa2-map-l3-card">
                                              <span className="coa2-map-l3-icon" aria-hidden="true">
                                                <GrpIcon />
                                              </span>
                                              <div className="coa2-map-l3-body">
                                                <span className="coa2-map-l3-name">{grp.name}</span>
                                                <div className="coa2-map-l3-foot">
                                                  <code className="coa2-map-code">{grp.code}</code>
                                                  <span
                                                    className={`coa2-kind ${grp.kind.toLowerCase()} sm`}
                                                  >
                                                    {grp.kind}
                                                  </span>
                                                  <span className="coa2-map-count">
                                                    {kids
                                                      ? `${kids} acct${kids !== 1 ? 's' : ''}`
                                                      : '—'}
                                                  </span>
                                                  <span className="coa2-map-bal">
                                                    {formatBalance(rollup(grp.code))}
                                                  </span>
                                                </div>
                                              </div>
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
          {(() => {
            const orphans = roots.filter((m) => childrenOf(m.code).length === 0)
            if (!orphans.length) return null
            return (
              <div className="coa2-map-ungrouped" role="region" aria-label="Ungrouped accounts">
                <span className="coa2-map-ungrouped-label">Ungrouped</span>
                <div className="coa2-map-ungrouped-cards">
                  {orphans.map((a) => {
                    const AIcon = iconOf(a)
                    return (
                      <div key={a.code} className="coa2-map-orphan-card">
                        <span className="coa2-map-orphan-icon" aria-hidden="true">
                          <AIcon />
                        </span>
                        <div className="coa2-map-orphan-body">
                          <b>{a.name}</b>
                          <div className="coa2-map-orphan-foot">
                            <code className="coa2-map-code">{a.code}</code>
                            <span className="coa2-kind header sm">Header</span>
                            <span className="coa2-map-bal">{formatBalance(rollup(a.code))}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </section>
      ) : (
        <section
          className={`coa2-table density-${density}`}
          style={{ '--name-w': `${nameWidth}px` } as React.CSSProperties}
        >
          <div className="coa2-tr head">
            <span className="c-check">
              <label className="coa2-check">
                <input
                  type="checkbox"
                  aria-label="Select page"
                  checked={allChecked}
                  onChange={toggleAll}
                />
                <i>
                  <Check />
                </i>
              </label>
            </span>
            <span className="c-name">
              Account Name <ChevronsUpDown />
              <span
                className="coa2-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize account name column"
                onPointerDown={startResize}
              />
            </span>
            <span>
              <Tag /> Code <ChevronsUpDown />
            </span>
            <span>
              <Filter /> Type <Filter className="f" />
            </span>
            <span>
              <FolderTree /> Parent Account <Filter className="f" />
            </span>
            <span>
              <Network /> Sub-accounts
            </span>
            <span className="num">
              <Coins /> Balance (PKR) <ChevronsUpDown />
            </span>
            <span>
              <TrendingUp /> Change
            </span>
            <span>
              <CalendarDays /> Last Modified
            </span>
            <span>
              <Activity /> Status
            </span>
            <span className="c-actions">Actions</span>
          </div>
          {rows.map(({ m, depth, last, trail }) => {
            const Icon = iconOf(m),
              kids = childrenOf(m.code).length,
              isOpen = open.has(m.code),
              parent = accounts.find((a) => a.code === m.parent)
            return (
              <div
                key={m.code}
                className={`coa2-tr depth-${depth} ${selected.has(m.code) ? 'sel' : ''} ${m.level === 1 ? 'root' : ''}`}
              >
                <span className="c-check">
                  <label className="coa2-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${m.name}`}
                      checked={selected.has(m.code)}
                      onChange={() => toggleSel(m.code)}
                    />
                    <i>
                      <Check />
                    </i>
                  </label>
                </span>
                <span className="c-name" style={{ paddingLeft: 10 + (depth - 1) * 30 }}>
                  {trail.map((cont, k) => {
                    const own = k === depth - 2
                    if (!own && !cont) return null
                    return (
                      <i
                        key={k}
                        className={`coa2-guide ${own ? (last ? 'end' : '') : ''} ${own && !kids ? 'elbow' : ''}`}
                        style={{ left: 10 + k * 30 + 12 }}
                      />
                    )
                  })}
                  {kids ? (
                    <button
                      type="button"
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${m.name}`}
                      onClick={() => toggle(m.code)}
                    >
                      {isOpen ? <ChevronDown /> : <ChevronRight />}
                    </button>
                  ) : (
                    <i className="coa2-nochev" />
                  )}
                  <span className={`coa2-icon ${toneOf(m)}`}>
                    <Icon />
                  </span>
                  <span className="coa2-name">
                    <b>{m.name}</b>
                    {descriptions[m.name] && <small>{descriptions[m.name]}</small>}
                  </span>
                </span>
                <span className="c-code">{m.code}</span>
                <span>
                  <span className={`coa2-kind ${m.kind.toLowerCase()}`}>{m.kind}</span>
                </span>
                <span className="c-parent">{parent ? `${parent.name} (${parent.code})` : '—'}</span>
                <span>
                  <span className={`coa2-count ${kids ? 'on' : ''}`}>{kids}</span>
                </span>
                {/* Two lines (amount, then Dr/Cr), not one long inline string — a fixed-width
                 * cell fitting "Rs 12,184,251" (the mock's undecimalled number) does not
                 * reliably fit "Rs 12,184,251.00 Dr" (a real, decimal-string amount plus its
                 * required side) on one line; wrapping an inline string here overflowed into
                 * the row below it. */}
                {(() => {
                  const net = rollup(m.code)
                  return (
                    <span className="num c-balance">
                      <b>{net ? moneyFromString(net.amount) : '—'}</b>
                      {net && <small>{net.side}</small>}
                    </span>
                  )
                })()}
                {/* Not fabricated — the mock's per-row "Change" was a hash-derived fake
                 * percentage with no period-comparison API behind it. An em dash, not
                 * invented data (CLAUDE.md, "never fake data"); the column stays so the
                 * table's fixed 11-column grid (.coa2-tr, kit.css) does not shift. */}
                <span className="c-change flat">
                  <em>● —</em>
                </span>
                <span className="c-mod">
                  <b>—</b>
                  <small>not tracked yet</small>
                </span>
                <span>
                  <span className={`coa2-status ${m.status === 'Active' ? 'on' : 'off'}`}>
                    ● {m.status}
                  </span>
                </span>
                <span className="c-actions">
                  <button
                    type="button"
                    aria-label={`Actions for ${m.name}`}
                    onClick={() =>
                      m.kind === 'Postable'
                        ? navigate(`/ledgers?account=${encodeURIComponent(m.code)}`)
                        : setDel(m)
                    }
                  >
                    <EllipsisVertical />
                  </button>
                </span>
              </div>
            )
          })}
          {!rows.length && <div className="empty-state">No accounts match your filters.</div>}
          <div className="coa2-foot">
            <span>
              Showing {flat.length ? (cur - 1) * rowsPer + 1 : 0}–
              {Math.min(cur * rowsPer, flat.length)} of {flat.length} accounts
            </span>
            <div className="coa2-foot-right">
              <span>Rows per page</span>
              <label className="coa2-select plain sm">
                <select
                  aria-label="Rows per page"
                  value={rowsPer}
                  onChange={(e) => {
                    setRowsPer(+e.target.value)
                    setPage(1)
                  }}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
                <ChevronDown />
              </label>
              <div className="coa2-pager">
                <button aria-label="First page" disabled={cur === 1} onClick={() => setPage(1)}>
                  <ChevronsLeft />
                </button>
                <button
                  aria-label="Previous page"
                  disabled={cur === 1}
                  onClick={() => setPage(cur - 1)}
                >
                  <ChevronLeft />
                </button>
                {Array.from({ length: Math.min(5, pages) }, (_, i) => i + 1).map((n) => (
                  <button key={n} className={n === cur ? 'active' : ''} onClick={() => setPage(n)}>
                    {n}
                  </button>
                ))}
                <button
                  aria-label="Next page"
                  disabled={cur === pages}
                  onClick={() => setPage(cur + 1)}
                >
                  <ChevronRight />
                </button>
                <button
                  aria-label="Last page"
                  disabled={cur === pages}
                  onClick={() => setPage(pages)}
                >
                  <ChevronsRight />
                </button>
              </div>
              <span>Go to page</span>
              <input
                className="coa2-goto"
                aria-label="Go to page"
                value={cur}
                onChange={(e) => setPage(Math.max(1, Math.min(pages, +e.target.value || 1)))}
              />
            </div>
          </div>
        </section>
      )}

      {ACCOUNT_CREATE_ENABLED && modal && (
        <MasterModal
          open={!!modal}
          list={[] as Master[]}
          presetType={modal.type === 'Asset' ? 'Asset' : 'Account'}
          presetLevel={modal.level}
          presetParent={modal.parent}
          onClose={() => setModal(null)}
          onSave={() => setNotice('Account creation is not wired to the API yet.')}
        />
      )}
      {del && (
        <Modal title={`Delete account — ${del.name}`} onClose={() => setDel(null)}>
          <p style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6 }}>
            You are about to delete <b>{del.name}</b> ({del.code}, level {del.level}).
          </p>
          <p
            style={{
              fontSize: 12.5,
              color: '#92400e',
              background: '#FFF7E6',
              borderRadius: 10,
              padding: 12,
              lineHeight: 1.5,
            }}
          >
            ⛔ Account deletion is not available yet — the chart is read-only until the Accounting
            spec and API ship.
          </p>
          <div className="modal-foot">
            <Button kind="secondary" onClick={() => setDel(null)}>
              Cancel
            </Button>
            <Button kind="danger" disabled>
              Delete account
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

function ChevronsUpDown() {
  return (
    <svg
      className="coa2-sort"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  )
}
