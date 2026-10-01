'use client'
/*
 * /vouchers — the PO's original design (8c5c283), restored. Real data: GET /api/journals (the
 * list — entry-level fields only, no lines) + GET /api/journals/:id (fetched on selection, for
 * the inspector's real lines) + GET /api/accounts (to resolve account names on those lines).
 *
 * What changed from the mock and why (full account in the M2-UI report's DECISIONS):
 *   - every real entry is a generic Journal Voucher (JOURNAL_VOUCHER_POSTED) — there is no
 *     server-side CRV/CPV/BRV/BPV/CV/SINV/PINV type to sort by, so the type filter and
 *     per-type tag colours the mock had are gone; every card reads "JV".
 *   - status is POSTED or REVERSED only — the mock's Draft/Pending tabs and "Approve & Post"
 *     action assumed a draft workflow the real posting model does not have (journal-voucher.md
 *     §1: single-step post, no draft, no approval). Tabs are All / Posted / Reversed, and the
 *     status filter is sent to the server (`listJournals({status})`), not applied in the
 *     browser over a fully-loaded list.
 *   - Total Debit/Total Credit KPIs are gone: `GET /api/journals` does not carry line amounts
 *     (fetching every entry's lines just to sum a KPI would be its own performance bug — "Do
 *     not fetch a whole ledger to show a total"). The KPI row shows real counts instead.
 *   - free-text search, the voucher-type filter and the newest/oldest sort are visually kept
 *     (never deleted) but disabled — there is no server search param and no browser-side
 *     re-sort of server-paginated data (CLAUDE.md, Performance).
 */
import { useEffect, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowDownUp,
  CalendarDays,
  ChevronRight,
  Clock3,
  FileText,
  Filter,
  Hash,
  ReceiptText,
  RotateCw,
  Scale,
  Search,
  ShieldAlert,
  User,
  WalletCards,
  X,
  CircleCheck,
} from 'lucide-react'
import { Button } from '@finsoft/ui'
import { listJournals, listAccounts, getJournal } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import {
  adaptVoucherLines,
  adaptVoucherSummary,
  type AdaptedVoucherSummary,
} from '@/lib/adapters/vouchers'
import { startOfMonthIso, todayIso } from '@/lib/date/local-date'
import type { AccountDto, JournalEntryDetail, JournalEntryStatus } from '@/lib/api/accounting-types'

const initials = (n: string) =>
  n
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

interface RegisterData {
  items: AdaptedVoucherSummary[]
  accounts: AccountDto[]
}

export function VoucherRegister() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'All' | 'Posted' | 'Reversed'>('All')
  const [from, setFrom] = useState(startOfMonthIso)
  const [to, setTo] = useState(todayIso)
  const [showSearch, setShowSearch] = useState(false),
    [showFilter, setShowFilter] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [panelTab, setPanelTab] = useState('Overview')

  const status: JournalEntryStatus | undefined =
    tab === 'All' ? undefined : (tab.toUpperCase() as JournalEntryStatus)

  const { state, reload } = useApiQuery(async (): Promise<RegisterData> => {
    const [list, accountsRes] = await Promise.all([
      listJournals({ status, from, to }),
      listAccounts(),
    ])
    return {
      items: list.items.map(adaptVoucherSummary),
      accounts: [...accountsRes.accounts],
    }
  }, [status, from, to])

  return (
    <div className="vg">
      <div className="vg-head">
        <div>
          <div className="vg-crumbs">
            <button onClick={() => navigate('/accounts')}>Accounting</button>
            <ChevronRight />
            <span>Voucher Register</span>
          </div>
          <h1>Voucher Register</h1>
          <p>
            Track, review and manage every voucher. Click any voucher to view its full details and
            posted lines.
          </p>
        </div>
        <div className="vg-head-actions">
          <label
            className="vg-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <CalendarDays size={14} />
            <input
              aria-label="From date"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              max={to}
              style={{ border: 0, font: 'inherit' }}
            />
            <span>–</span>
            <input
              aria-label="To date"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              max={todayIso()}
              style={{ border: 0, font: 'inherit' }}
            />
          </label>
          <button className="vg-btn primary" onClick={() => navigate('/vouchers/new')}>
            <ReceiptText /> New Voucher
          </button>
        </div>
      </div>

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading vouchers…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view the voucher register.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the voucher register</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && (
        <RegisterReady
          data={state.data}
          tab={tab}
          onTabChange={setTab}
          sel={sel}
          onSelect={setSel}
          panelTab={panelTab}
          onPanelTab={setPanelTab}
          showSearch={showSearch}
          onShowSearch={setShowSearch}
          showFilter={showFilter}
          onShowFilter={setShowFilter}
        />
      )}
    </div>
  )
}

function RegisterReady({
  data,
  tab,
  onTabChange,
  sel,
  onSelect,
  panelTab,
  onPanelTab,
  showSearch,
  onShowSearch,
  showFilter,
  onShowFilter,
}: {
  data: RegisterData
  tab: 'All' | 'Posted' | 'Reversed'
  onTabChange: (t: 'All' | 'Posted' | 'Reversed') => void
  sel: string | null
  onSelect: (id: string | null) => void
  panelTab: string
  onPanelTab: (t: string) => void
  showSearch: boolean
  onShowSearch: (v: boolean) => void
  showFilter: boolean
  onShowFilter: (v: boolean) => void
}) {
  const navigate = useNavigate()
  const { items, accounts } = data
  const posted = items.filter((v) => v.status === 'Posted').length
  const reversed = items.filter((v) => v.status === 'Reversed').length
  const groups = items.reduce<{ date: string; items: AdaptedVoucherSummary[] }[]>((acc, v) => {
    const g = acc.find((x) => x.date === v.date)
    if (g) g.items.push(v)
    else acc.push({ date: v.date, items: [v] })
    return acc
  }, [])

  return (
    <>
      {items.length > 0 && (
        <div className="vg-kpis">
          <article>
            <span className="vg-ic green">
              <ReceiptText />
            </span>
            <div>
              <b>{items.length}</b>
              <small>Vouchers shown</small>
            </div>
          </article>
          <article>
            <span className="vg-ic blue">
              <WalletCards />
            </span>
            <div>
              <b>{posted}</b>
              <small>Posted</small>
            </div>
          </article>
          <article>
            <span className="vg-ic red">
              <Scale />
            </span>
            <div>
              <b>{reversed}</b>
              <small>Reversed</small>
            </div>
          </article>
        </div>
      )}

      <div className="vg-body">
        <section className="vg-list">
          <div className="vg-toolbar">
            <div className="vg-tabs">
              {(['All', 'Posted', 'Reversed'] as const).map((k) => (
                <button
                  key={k}
                  className={tab === k ? 'active' : ''}
                  onClick={() => onTabChange(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            <div className="vg-tools">
              <button
                className={`vg-btn icon ${showSearch ? 'on' : ''}`}
                aria-label="Search vouchers"
                onClick={() => onShowSearch(!showSearch)}
              >
                <Search />
              </button>
              <button
                className={`vg-btn ${showFilter ? 'on' : ''}`}
                onClick={() => onShowFilter(!showFilter)}
              >
                <Filter /> Filter
              </button>
              <button
                className="vg-btn"
                disabled
                title="Vouchers are shown newest-first, as the server returns them"
              >
                <ArrowDownUp /> Newest First
              </button>
            </div>
          </div>
          {(showSearch || showFilter) && (
            <div className="vg-filters">
              {showSearch && (
                <label className="vg-search">
                  <Search />
                  <input aria-label="Search vouchers" disabled placeholder="Search — coming soon" />
                </label>
              )}
              {showFilter && (
                <div className="vg-filter-set">
                  <span className="vg-note">
                    All vouchers are Journal Vouchers in this release.
                  </span>
                  <button className="vg-link" onClick={() => onShowFilter(false)}>
                    Close
                  </button>
                </div>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <div className="empty-state">No vouchers yet in this date range.</div>
          ) : (
            <div className="vg-timeline">
              {groups.map((g) => (
                <div className="vg-day" key={g.date}>
                  <div className="vg-day-head">
                    <i />
                    <b>{g.date}</b>
                    <small>
                      {g.items.length} voucher{g.items.length === 1 ? '' : 's'}
                    </small>
                  </div>
                  {g.items.map((v) => (
                    <button
                      type="button"
                      key={v.id}
                      className={`vg-card ${sel === v.id ? 'active' : ''}`}
                      aria-label={`${v.entryNumber} ${v.narration}`}
                      onClick={() => {
                        onSelect(v.id)
                        onPanelTab('Overview')
                      }}
                    >
                      <i className="vg-dot" />
                      <span className="vg-tag jv">JV</span>
                      <span className="vg-id">
                        <b>{v.entryNumber}</b>
                      </span>
                      <span className="vg-part">
                        <b>{v.narration}</b>
                        <em>
                          <FileText />
                          {v.reference || '—'}
                        </em>
                      </span>
                      <span className={`vg-status ${v.status.toLowerCase()}`}>● {v.status}</span>
                      <ChevronRight className="vg-chev" />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        {sel && (
          <VoucherInspector
            id={sel}
            accounts={accounts}
            panelTab={panelTab}
            onPanelTab={onPanelTab}
            onClose={() => onSelect(null)}
            onOpenFull={() => navigate(`/vouchers/${sel}`)}
          />
        )}
      </div>
    </>
  )
}

function VoucherInspector({
  id,
  accounts,
  panelTab,
  onPanelTab,
  onClose,
  onOpenFull,
}: {
  id: string
  accounts: AccountDto[]
  panelTab: string
  onPanelTab: (t: string) => void
  onClose: () => void
  onOpenFull: () => void
}) {
  const [entry, setEntry] = useState<JournalEntryDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEntry(null)
    setError(null)
    getJournal(id).then(setEntry, (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not load this voucher.'),
    )
  }, [id])

  if (error) {
    return (
      <aside className="vg-panel">
        <div className="vg-panel-head">
          <p>{error}</p>
          <button className="vg-btn icon ghost" aria-label="Close panel" onClick={onClose}>
            <X />
          </button>
        </div>
      </aside>
    )
  }
  if (!entry) {
    return (
      <aside className="vg-panel" role="status" aria-live="polite">
        <div className="vg-panel-head">
          <p>Loading voucher…</p>
        </div>
      </aside>
    )
  }

  const lines = adaptVoucherLines(entry.lines, accounts)

  return (
    <aside className="vg-panel">
      <div className="vg-panel-head">
        <span className="vg-tag lg jv">JV</span>
        <div>
          <h2>{entry.entryNumber}</h2>
          <p>
            {entry.occurredAt}{' '}
            <span className={`vg-status ${entry.status.toLowerCase()}`}>
              ● {entry.status === 'POSTED' ? 'Posted' : 'Reversed'}
            </span>
          </p>
        </div>
        <button className="vg-btn icon ghost" aria-label="Close panel" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="vg-panel-tabs">
        {(['Overview', 'Ledger Entries', 'Activity', 'Related'] as const).map((t) => (
          <button key={t} className={panelTab === t ? 'active' : ''} onClick={() => onPanelTab(t)}>
            {t}
            {t === 'Ledger Entries' && <i>{lines.length}</i>}
          </button>
        ))}
      </div>
      <div className="vg-hero">
        <span className="vg-ic green sm">
          <ReceiptText />
        </span>
        <div>
          <b>{entry.narration}</b>
          <small>
            {lines.length} line{lines.length === 1 ? '' : 's'}
          </small>
        </div>
      </div>
      {panelTab === 'Overview' && (
        <>
          <dl className="vg-facts">
            <div>
              <FileText />
              <dt>Voucher Type</dt>
              <dd>Journal Voucher</dd>
            </div>
            <div>
              <User />
              <dt>Created By</dt>
              <dd>
                <u className="vg-avatar">{initials('—')}</u>—
              </dd>
            </div>
            <div>
              <CalendarDays />
              <dt>Voucher Date</dt>
              <dd>{entry.occurredAt}</dd>
            </div>
            <div>
              <Clock3 />
              <dt>Status</dt>
              <dd>
                <span className={`vg-status ${entry.status.toLowerCase()}`}>
                  ● {entry.status === 'POSTED' ? 'Posted' : 'Reversed'}
                </span>
              </dd>
            </div>
            <div>
              <Hash />
              <dt>Reference</dt>
              <dd>{entry.reference || '—'}</dd>
            </div>
            <div>
              <CircleCheck />
              <dt>Reversal</dt>
              <dd>
                {entry.reversalOf
                  ? `Reverses ${entry.reversalOf}`
                  : entry.reversedBy
                    ? 'Reversed'
                    : '—'}
              </dd>
            </div>
          </dl>
          <div className="vg-section-head">
            <h3>Ledger Entries ({lines.length})</h3>
            <button className="vg-link" onClick={onOpenFull}>
              View in Journal
            </button>
          </div>
          <LinesTable lines={lines} />
          <div className="vg-panel-actions">
            <button className="vg-btn" onClick={onOpenFull}>
              Open voucher
            </button>
          </div>
        </>
      )}
      {panelTab === 'Ledger Entries' && <LinesTable lines={lines} />}
      {panelTab === 'Activity' && (
        <ul className="vg-activity">
          <li>
            <i />
            <div>
              <b>Posted</b>
              <small>{entry.occurredAt}</small>
            </div>
          </li>
          {entry.status === 'REVERSED' && (
            <li>
              <i />
              <div>
                <b>Reversed</b>
                <small>{entry.reversalReason || 'No reason recorded'}</small>
              </div>
            </li>
          )}
        </ul>
      )}
      {panelTab === 'Related' && (
        <div className="vg-empty">
          Related documents are not available for this source type yet.
        </div>
      )}
    </aside>
  )
}

function LinesTable({ lines }: { lines: ReturnType<typeof adaptVoucherLines> }) {
  return (
    <table className="vg-entries">
      <thead>
        <tr>
          <th>#</th>
          <th>Account</th>
          <th>Memo</th>
          <th className="num">Debit (Rs)</th>
          <th className="num">Credit (Rs)</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.lineNumber}>
            <td>{l.lineNumber}</td>
            <td>
              <b>{l.accountName}</b>
            </td>
            <td>{l.memo}</td>
            <td className="num money-debit">{l.debit}</td>
            <td className="num money-credit">{l.credit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
