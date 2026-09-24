'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowDownUp,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Ellipsis,
  FileText,
  Filter,
  Hash,
  Paperclip,
  Plus,
  ReceiptText,
  Scale,
  Search,
  User,
  WalletCards,
  X,
  CircleCheck,
  Send,
} from 'lucide-react'
import { voucherCode, type Voucher } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { money } from '@finsoft/ui'
import { allVouchers } from './voucher-data'

const typeMap: Record<string, { code: string; label: string; tone: string }> = {
  JV: { code: 'JV', label: 'Journal Voucher', tone: 'jv' },
  CRV: { code: 'RV', label: 'Receipt Voucher', tone: 'rv' },
  BRV: { code: 'RV', label: 'Receipt Voucher', tone: 'rv' },
  CPV: { code: 'PV', label: 'Payment Voucher', tone: 'pv' },
  BPV: { code: 'PV', label: 'Payment Voucher', tone: 'pv' },
  CV: { code: 'CV', label: 'Contra Voucher', tone: 'cv' },
  SINV: { code: 'SI', label: 'Sales Invoice', tone: 'rv' },
  PINV: { code: 'PI', label: 'Purchase Invoice', tone: 'pv' },
}
const initials = (n: string) =>
  n
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const longDate = (d: string) => {
  const [day, m, y] = d.split(' ')
  return `${String(Number(day)).padStart(2, '0')} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][MONTHS.indexOf(m)] ?? m} ${y}`
}
const sortKey = (d: string) => {
  const [day, m, y] = d.split(' ')
  return Number(y) * 10000 + MONTHS.indexOf(m) * 100 + Number(day)
}
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
const timeOf = (id: string) => {
  const h = hash(id)
  const hr = 8 + (h % 10),
    mn = h % 60
  return `${String(hr > 12 ? hr - 12 : hr).padStart(2, '0')}:${String(mn).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`
}
const total = (v: Voucher) => v.lines.reduce((a, l) => a + l.amount, 0)
const noteOf = (v: Voucher) =>
  v.type === 'JV' && /COGS/.test(v.narration)
    ? 'Pharmacy stock issue'
    : /rent/i.test(v.narration)
      ? 'August 2026 rent'
      : /salar/i.test(v.narration)
        ? 'August 2026 salaries'
        : /electric/i.test(v.narration)
          ? 'Monthly office electricity bill'
          : v.reference || '—'

function Spark({ dir }: { dir: 'up' | 'down' }) {
  const pts =
    dir === 'up' ? '0,17 12,13 24,14 36,9 48,10 60,4 72,6' : '0,5 12,7 24,6 36,10 48,9 60,14 72,13'
  return (
    <svg className={`vg-spark ${dir}`} viewBox="0 0 72 22" preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function VoucherRegister({ data, onPost }: { data: AppData; onPost: (id: string) => void }) {
  const navigate = useNavigate()
  const all = useMemo(() => allVouchers(data), [data])
  const [tab, setTab] = useState('All'),
    [q, setQ] = useState(''),
    [vtype, setVtype] = useState('All Voucher Types'),
    [status, setStatus] = useState('All Status'),
    [newest, setNewest] = useState(true)
  const [showSearch, setShowSearch] = useState(false),
    [showFilter, setShowFilter] = useState(false)
  const [sel, setSel] = useState<string | null>(all[0]?.id ?? null)
  const [panelTab, setPanelTab] = useState('Overview')
  const posted = all.filter((v) => v.status === 'Posted').length,
    draft = all.filter((v) => v.status === 'Draft').length,
    pending = draft
  const totalDebit = all.reduce((a, v) => a + total(v), 0)
  const filtered = all
    .filter(
      (v) =>
        (tab === 'All' ||
          (tab === 'Posted' && v.status === 'Posted') ||
          (tab === 'Draft' && v.status === 'Draft') ||
          (tab === 'Pending' && v.status === 'Draft')) &&
        (vtype === 'All Voucher Types' || typeMap[v.type]?.label === vtype) &&
        (status === 'All Status' || v.status === status) &&
        `${v.id} ${v.narration} ${v.reference} ${v.lines.map((l) => l.debit + ' ' + l.credit).join(' ')}`
          .toLowerCase()
          .includes(q.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (newest ? sortKey(b.date) - sortKey(a.date) : sortKey(a.date) - sortKey(b.date)) ||
        b.id.localeCompare(a.id),
    )
  const groups = filtered.reduce<{ date: string; items: Voucher[] }[]>((acc, v) => {
    const g = acc.find((x) => x.date === v.date)
    if (g) g.items.push(v)
    else acc.push({ date: v.date, items: [v] })
    return acc
  }, [])
  const current = all.find((v) => v.id === sel) ?? null
  const typeLabels = [
    'Journal Voucher',
    'Receipt Voucher',
    'Payment Voucher',
    'Contra Voucher',
    'Sales Invoice',
    'Purchase Invoice',
  ]

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
            Track, review and manage all vouchers in one place. Click on any voucher to view full
            details, ledger entries and related activity.
          </p>
        </div>
        <div className="vg-head-actions">
          <button className="vg-btn">
            <CalendarDays /> 01 Aug 2026 – 31 Aug 2026 <ChevronDown />
          </button>
          <span className="vg-split">
            <button className="vg-btn primary" onClick={() => navigate('/vouchers/new')}>
              <Plus /> New Voucher
            </button>
            <button className="vg-btn primary caret" aria-label="New voucher options">
              <ChevronDown />
            </button>
          </span>
        </div>
      </div>

      <div className="vg-kpis">
        <article>
          <span className="vg-ic green">
            <ReceiptText />
          </span>
          <div>
            <b>{all.length}</b>
            <small>Total Vouchers</small>
          </div>
          <div className="vg-kpi-right">
            <em className="up">▲ 12%</em>
            <i className="vg-bars">
              {[8, 12, 10, 16, 12, 18, 14, 20].map((h, i) => (
                <u key={i} style={{ height: h }} />
              ))}
            </i>
          </div>
        </article>
        <article>
          <span className="vg-ic blue">
            <WalletCards />
          </span>
          <div>
            <b>{money(totalDebit)}</b>
            <small>Total Debit</small>
          </div>
          <Spark dir="up" />
        </article>
        <article>
          <span className="vg-ic red">
            <Scale />
          </span>
          <div>
            <b>{money(totalDebit)}</b>
            <small>Total Credit</small>
          </div>
          <Spark dir="down" />
        </article>
        <button type="button" className="vg-kpi-btn" onClick={() => setTab('Pending')}>
          <span className="vg-ic amber">
            <Clock3 />
          </span>
          <div>
            <b>{pending}</b>
            <small>Pending Approvals</small>
          </div>
          <ChevronRight />
        </button>
        <button type="button" className="vg-export">
          <Download /> Export <ChevronDown />
        </button>
      </div>

      <div className="vg-body">
        <section className="vg-list">
          <div className="vg-toolbar">
            <div className="vg-tabs">
              {[
                ['All', 'All Vouchers', all.length],
                ['Posted', 'Posted', posted],
                ['Draft', 'Draft', draft],
                ['Pending', 'Pending Approval', pending],
              ].map(([k, l, n]) => (
                <button
                  key={k as string}
                  className={tab === k ? 'active' : ''}
                  onClick={() => setTab(k as string)}
                >
                  {l as string} <i>{n as number}</i>
                </button>
              ))}
            </div>
            <div className="vg-tools">
              <button
                className={`vg-btn icon ${showSearch ? 'on' : ''}`}
                aria-label="Search vouchers"
                onClick={() => setShowSearch(!showSearch)}
              >
                <Search />
              </button>
              <button
                className={`vg-btn ${showFilter ? 'on' : ''}`}
                onClick={() => setShowFilter(!showFilter)}
              >
                <Filter /> Filter
              </button>
              <button className="vg-btn" onClick={() => setNewest(!newest)}>
                <ArrowDownUp /> {newest ? 'Newest First' : 'Oldest First'}
              </button>
            </div>
          </div>
          <div className={`vg-filters ${showSearch || showFilter ? '' : 'collapsed'}`}>
            <label className={`vg-search ${showSearch ? '' : 'collapsed'}`}>
              <Search />
              <input
                aria-label="Search vouchers"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search vouchers, accounts or narrations..."
              />
            </label>
            <div className={`vg-filter-set ${showFilter ? '' : 'collapsed'}`}>
              <label className="vg-select">
                <select
                  aria-label="Status filter"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option>All Status</option>
                  <option>Posted</option>
                  <option>Draft</option>
                  <option>Cancelled</option>
                </select>
                <ChevronDown />
              </label>
              <label className="vg-select">
                <select
                  aria-label="Voucher type filter"
                  value={vtype}
                  onChange={(e) => setVtype(e.target.value)}
                >
                  <option>All Voucher Types</option>
                  {typeLabels.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <ChevronDown />
              </label>
              <button
                className="vg-link"
                onClick={() => {
                  setQ('')
                  setStatus('All Status')
                  setVtype('All Voucher Types')
                }}
              >
                Clear all
              </button>
            </div>
          </div>
          <div className="vg-timeline">
            {groups.map((g) => (
              <div className="vg-day" key={g.date}>
                <div className="vg-day-head">
                  <i />
                  <b>{longDate(g.date)}</b>
                  <small>
                    {g.items.length} voucher{g.items.length === 1 ? '' : 's'}
                  </small>
                </div>
                {g.items.map((v) => {
                  const m = typeMap[v.type] ?? { code: v.type, label: v.type, tone: 'jv' }
                  return (
                    <button
                      type="button"
                      key={v.id}
                      className={`vg-card ${sel === v.id ? 'active' : ''}`}
                      aria-label={`${v.id} ${v.narration}`}
                      onClick={() => {
                        setSel(v.id)
                        setPanelTab('Overview')
                      }}
                    >
                      <i className="vg-dot" />
                      <span className={`vg-tag ${m.tone}`}>{m.code}</span>
                      <span className="vg-id">
                        <b>{v.id}</b>
                        <small>{timeOf(v.id)}</small>
                      </span>
                      <span className="vg-part">
                        <b>{v.lines[0]?.debit ?? '—'}</b>
                        <small>{v.narration}</small>
                        <em>
                          <FileText />
                          {noteOf(v)}
                        </em>
                      </span>
                      <span className={`vg-status ${v.status.toLowerCase()}`}>● {v.status}</span>
                      <span className="vg-amt">
                        <b>{money(total(v))}</b>
                        <small>Dr</small>
                      </span>
                      <span className="vg-meta">
                        <i className="vg-type">{m.label}</i>
                        <span className="vg-by">
                          <u>{initials(v.createdBy)}</u>
                          {v.createdBy}
                        </span>
                      </span>
                      <ChevronRight className="vg-chev" />
                    </button>
                  )
                })}
              </div>
            ))}
            {!filtered.length && (
              <div className="empty-state">No vouchers match these filters.</div>
            )}
          </div>
        </section>

        {current &&
          (() => {
            const m = typeMap[current.type] ?? {
              code: current.type,
              label: current.type,
              tone: 'jv',
            }
            const entries = current.lines.flatMap((l, i) => [
              {
                n: i * 2 + 1,
                acct: l.debit,
                code: voucherCode[l.debit] ?? '—',
                part: l.remark || current.narration,
                dr: l.amount,
                cr: 0,
              },
              {
                n: i * 2 + 2,
                acct: l.credit,
                code: voucherCode[l.credit] ?? '—',
                part: `Payment — ${l.debit}`,
                dr: 0,
                cr: l.amount,
              },
            ])
            return (
              <aside className="vg-panel">
                <div className="vg-panel-head">
                  <span className={`vg-tag lg ${m.tone}`}>{m.code}</span>
                  <div>
                    <h2>{current.id}</h2>
                    <p>
                      Created on {longDate(current.date)} at {timeOf(current.id)}{' '}
                      <span className={`vg-status ${current.status.toLowerCase()}`}>
                        ● {current.status}
                      </span>
                    </p>
                  </div>
                  <button className="vg-btn icon ghost" aria-label="More">
                    <Ellipsis />
                  </button>
                  <button
                    className="vg-btn icon ghost"
                    aria-label="Close panel"
                    onClick={() => setSel(null)}
                  >
                    <X />
                  </button>
                </div>
                <div className="vg-panel-tabs">
                  {[
                    ['Overview', null],
                    ['Ledger Entries', entries.length],
                    ['Activity', 3],
                    ['Approvals', current.status === 'Draft' ? 1 : 0],
                    ['Related', 1],
                  ].map(([t, n]) => (
                    <button
                      key={t as string}
                      className={panelTab === t ? 'active' : ''}
                      onClick={() => setPanelTab(t as string)}
                    >
                      {t as string}
                      {n !== null && <i>{n as number}</i>}
                    </button>
                  ))}
                </div>
                <div className="vg-hero">
                  <span className="vg-ic green sm">
                    <ReceiptText />
                  </span>
                  <div>
                    <b>{current.lines[0]?.debit}</b>
                    <small>{current.narration}</small>
                  </div>
                  <div className="vg-hero-amt">
                    <b>{money(total(current))}</b>
                    <small>Debit</small>
                  </div>
                </div>
                {panelTab === 'Overview' && (
                  <>
                    <dl className="vg-facts">
                      <div>
                        <FileText />
                        <dt>Voucher Type</dt>
                        <dd>{m.label}</dd>
                      </div>
                      <div>
                        <User />
                        <dt>Created By</dt>
                        <dd>
                          <u className="vg-avatar">{initials(current.createdBy)}</u>
                          {current.createdBy}
                        </dd>
                      </div>
                      <div>
                        <CalendarDays />
                        <dt>Voucher Date</dt>
                        <dd>{longDate(current.date)}</dd>
                      </div>
                      <div>
                        <Clock3 />
                        <dt>Status</dt>
                        <dd>
                          <span className={`vg-status ${current.status.toLowerCase()}`}>
                            ● {current.status}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <Hash />
                        <dt>Reference</dt>
                        <dd>{current.reference || '—'}</dd>
                      </div>
                      <div>
                        <CircleCheck />
                        <dt>Posted On</dt>
                        <dd>
                          {current.status === 'Posted'
                            ? `${longDate(current.date)}, ${timeOf(current.id + 'p')}`
                            : '—'}
                        </dd>
                      </div>
                      <div>
                        <FileText />
                        <dt>Narration</dt>
                        <dd>{noteOf(current)}</dd>
                      </div>
                      <div>
                        <Send />
                        <dt>Pending Approvals</dt>
                        <dd>{current.status === 'Draft' ? '1 · Finance Manager' : '—'}</dd>
                      </div>
                    </dl>
                    <div className="vg-section-head">
                      <h3>Ledger Entries ({entries.length})</h3>
                      <button
                        className="vg-link"
                        onClick={() => navigate(`/vouchers/${current.id}`)}
                      >
                        View in Journal
                      </button>
                    </div>
                    <table className="vg-entries">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Account</th>
                          <th>Particulars</th>
                          <th className="num">Debit (Rs)</th>
                          <th className="num">Credit (Rs)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((e) => (
                          <tr key={e.n}>
                            <td>{e.n}</td>
                            <td>
                              <b>{e.acct}</b>
                            </td>
                            <td>{e.part}</td>
                            <td className="num">{e.dr ? money(e.dr).replace('Rs ', '') : '—'}</td>
                            <td className="num">{e.cr ? money(e.cr).replace('Rs ', '') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="vg-section-head">
                      <h3>
                        <Paperclip /> Attachments (1)
                      </h3>
                    </div>
                    <div className="vg-attach">
                      <span>
                        <FileText />
                      </span>
                      <div>
                        <b>
                          {current.reference
                            ? current.reference.toLowerCase()
                            : current.id.toLowerCase()}
                          -aug-2026.pdf
                        </b>
                        <small>245 KB • Uploaded {longDate(current.date)}</small>
                      </div>
                      <button className="vg-btn icon ghost" aria-label="Download attachment">
                        <Download />
                      </button>
                    </div>
                    {current.status === 'Draft' && (
                      <div className="vg-panel-actions">
                        <button className="vg-btn primary" onClick={() => onPost(current.id)}>
                          <CircleCheck /> Approve &amp; Post
                        </button>
                        <button
                          className="vg-btn"
                          onClick={() => navigate(`/vouchers/${current.id}`)}
                        >
                          Open voucher
                        </button>
                      </div>
                    )}
                  </>
                )}
                {panelTab === 'Ledger Entries' && (
                  <table className="vg-entries">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Account</th>
                        <th>Code</th>
                        <th className="num">Debit (Rs)</th>
                        <th className="num">Credit (Rs)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.n}>
                          <td>{e.n}</td>
                          <td>
                            <b>{e.acct}</b>
                          </td>
                          <td>{e.code}</td>
                          <td className="num">{e.dr ? money(e.dr).replace('Rs ', '') : '—'}</td>
                          <td className="num">{e.cr ? money(e.cr).replace('Rs ', '') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {panelTab === 'Activity' && (
                  <ul className="vg-activity">
                    <li>
                      <i />
                      <div>
                        <b>Voucher created</b>
                        <small>
                          {current.createdBy} · {longDate(current.date)}, {timeOf(current.id)}
                        </small>
                      </div>
                    </li>
                    <li>
                      <i />
                      <div>
                        <b>{current.status === 'Posted' ? 'Posted to ledger' : 'Saved as draft'}</b>
                        <small>
                          {current.createdBy} · {longDate(current.date)}, {timeOf(current.id + 'p')}
                        </small>
                      </div>
                    </li>
                    <li>
                      <i />
                      <div>
                        <b>Attachment uploaded</b>
                        <small>
                          {current.createdBy} · {longDate(current.date)}
                        </small>
                      </div>
                    </li>
                  </ul>
                )}
                {panelTab === 'Approvals' && (
                  <div className="vg-empty">
                    {current.status === 'Draft' ? (
                      <>
                        Awaiting approval from <b>Finance Manager</b>.
                        <button className="vg-btn primary" onClick={() => onPost(current.id)}>
                          <CircleCheck /> Approve &amp; Post
                        </button>
                      </>
                    ) : (
                      'No approvals pending — this voucher is posted.'
                    )}
                  </div>
                )}
                {panelTab === 'Related' && (
                  <div className="vg-empty">
                    Related document:{' '}
                    <button className="vg-link" onClick={() => navigate(`/vouchers/${current.id}`)}>
                      {current.reference || current.id}
                    </button>
                  </div>
                )}
              </aside>
            )
          })()}
      </div>
    </div>
  )
}
