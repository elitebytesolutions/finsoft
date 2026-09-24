'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Download,
  Ellipsis,
  FileText,
  Image as ImageIcon,
  Landmark,
  Pencil,
  Plus,
  Printer,
  Repeat2,
  Search,
  Wallet,
  X,
} from 'lucide-react'

type Kind = 'Cheque' | 'Transfer' | 'Payment' | 'Deposit' | 'Opening'
type Txn = {
  id: string
  date: string
  ref: string
  particulars: string
  type: Kind
  out: number
  in: number
  balance: number
  party: string
  narration: string
  cleared: boolean
  scheduled: boolean
}

type Acct = {
  id: string
  bank: string
  short: string
  title: string
  iban: string
  opening: number
  factor: number
}
const ACCOUNTS: Acct[] = [
  {
    id: 'HBL-MAIN',
    bank: 'Habib Bank Limited',
    short: 'HBL',
    title: 'Main Account',
    iban: 'PK36 HABB 0001 **** 7890',
    opening: 1250000,
    factor: 1,
  },
  {
    id: 'MEZ-OPS',
    bank: 'Meezan Bank',
    short: 'Meezan',
    title: 'Operations Account',
    iban: 'PK21 MEZN 0044 **** 8721',
    opening: 2140580,
    factor: 0.72,
  },
  {
    id: 'UBL-PAY',
    bank: 'United Bank Limited',
    short: 'UBL',
    title: 'Payroll Account',
    iban: 'PK58 UNIL 0091 **** 9012',
    opening: 318750,
    factor: 0.38,
  },
  {
    id: 'MCB-BR2',
    bank: 'MCB Bank',
    short: 'MCB',
    title: 'Branch 2 Collections',
    iban: 'PK14 MUCB 0210 **** 3456',
    opening: 905000,
    factor: 0.55,
  },
]
const seed: [string, string, string, Kind, number, number, string, boolean, boolean][] = [
  [
    '02 Sep 2026',
    'CHQ 458721',
    'Office Rent - Crescent Plaza',
    'Cheque',
    250000,
    0,
    'Crescent Plaza',
    true,
    false,
  ],
  [
    '03 Sep 2026',
    'TRF 78231',
    'Customer Payment - Al Noor Traders',
    'Transfer',
    0,
    350000,
    'Al Noor Traders',
    true,
    false,
  ],
  [
    '04 Sep 2026',
    'CHQ 458722',
    'Supplier Payment - Allied Distributors',
    'Cheque',
    180000,
    0,
    'Allied Distributors',
    true,
    false,
  ],
  [
    '05 Sep 2026',
    'FT 99201',
    'Online Transfer - Utility Bills',
    'Payment',
    42500,
    0,
    'LESCO',
    true,
    false,
  ],
  ['06 Sep 2026', 'DEP 11032', 'Cash Deposit', 'Deposit', 0, 500000, 'Cash Counter', true, false],
  [
    '07 Sep 2026',
    'CHQ 458723',
    'Salaries - September 2026',
    'Cheque',
    420000,
    0,
    'Payroll',
    true,
    false,
  ],
  [
    '08 Sep 2026',
    'TRF 78240',
    'Customer Payment - Zaitoon Pharma',
    'Transfer',
    0,
    275000,
    'Zaitoon Pharma',
    true,
    false,
  ],
  [
    '09 Sep 2026',
    'CHQ 458724',
    'Vehicle Expenses',
    'Cheque',
    35000,
    0,
    'Toyota Motors',
    false,
    false,
  ],
  [
    '10 Sep 2026',
    'CHQ 458725',
    'Marketing - Digital Campaign',
    'Cheque',
    120000,
    0,
    'AdWorks',
    false,
    false,
  ],
  [
    '11 Sep 2026',
    'TRF 78255',
    'Customer Payment - City Medical',
    'Transfer',
    0,
    610000,
    'City Medical',
    true,
    false,
  ],
  [
    '12 Sep 2026',
    'CHQ 458726',
    'Office Supplies',
    'Cheque',
    28370,
    0,
    'Stationers Ltd',
    true,
    false,
  ],
  ['13 Sep 2026', 'DEP 11056', 'POS Settlement', 'Deposit', 0, 420000, 'POS Terminal', true, false],
  [
    '15 Sep 2026',
    'CHQ 458730',
    'Rent - October (PDC)',
    'Cheque',
    250000,
    0,
    'Crescent Plaza',
    false,
    true,
  ],
  [
    '18 Sep 2026',
    'TRF 78302',
    'Customer Payment - Shifa Medical',
    'Transfer',
    0,
    185000,
    'Shifa Medical Centre',
    true,
    false,
  ],
  ['20 Sep 2026', 'FT 99310', 'Insurance Premium', 'Payment', 96000, 0, 'EFU General', false, true],
]
const money2 = (n: number) =>
  n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rs = (n: number) => `Rs. ${n.toLocaleString('en-PK')}`
const kindIcon: Record<Kind, typeof Wallet> = {
  Cheque: FileText,
  Transfer: Repeat2,
  Payment: ArrowUpRight,
  Deposit: ArrowDownLeft,
  Opening: Wallet,
}

export function BankTransactions() {
  const navigate = useNavigate()
  const [acctId, setAcctId] = useState(ACCOUNTS[0].id)
  const [acctOpen, setAcctOpen] = useState(false)
  const [tab, setTab] = useState('All Transactions')
  const [view, setView] = useState('Checkbook View')
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<string[]>(['OPEN', 'TRF 78231'])
  const [sel, setSel] = useState<string | null>('TRF 78231')
  const [panelTab, setPanelTab] = useState('Details')
  const [docTab, setDocTab] = useState('Related Documents')
  const [page, setPage] = useState(1),
    [size, setSize] = useState(20)

  const acct = ACCOUNTS.find((a) => a.id === acctId) ?? ACCOUNTS[0]
  const rows = useMemo<Txn[]>(() => {
    const round = (n: number) => Math.round((n * acct.factor) / 10) * 10
    const opening: Txn = {
      id: 'OPEN',
      date: '01 Sep 2026',
      ref: '—',
      particulars: 'Opening Balance',
      type: 'Opening',
      out: 0,
      in: 0,
      balance: acct.opening,
      party: '—',
      narration: 'Balance brought forward',
      cleared: true,
      scheduled: false,
    }
    const rest = seed.reduce<Txn[]>(
      (acc, [date, ref, particulars, type, out, inn, party, cleared, scheduled]) => {
        const o = round(out),
          i = round(inn)
        const balance = (acc.at(-1)?.balance ?? acct.opening) - o + i
        acc.push({
          id: ref,
          date,
          ref,
          particulars,
          type,
          out: o,
          in: i,
          balance,
          party,
          narration: `${particulars} — ${ref}`,
          cleared,
          scheduled,
        })
        return acc
      },
      [],
    )
    return [opening, ...rest]
  }, [acct])
  const deposits = rows.filter((r) => r.in > 0 && r.id !== 'OPEN'),
    withdrawals = rows.filter((r) => r.out > 0)
  const totalIn = deposits.reduce((a, r) => a + r.in, 0),
    totalOut = withdrawals.reduce((a, r) => a + r.out, 0)
  const closing = acct.opening + totalIn - totalOut
  const filtered = rows.filter(
    (r) =>
      (tab === 'All Transactions' ||
        (tab === 'Deposits' && r.in > 0) ||
        (tab === 'Withdrawals' && r.out > 0) ||
        (tab === 'Cheques' && r.type === 'Cheque') ||
        (tab === 'Uncleared' && !r.cleared) ||
        (tab === 'Scheduled (PDC)' && r.scheduled)) &&
      `${r.ref} ${r.particulars} ${r.party} ${r.type}`.toLowerCase().includes(query.toLowerCase()),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / size)),
    cur = Math.min(page, pages),
    slice = filtered.slice((cur - 1) * size, cur * size)
  const current = rows.find((r) => r.id === sel) ?? null
  const toggle = (id: string) =>
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))

  return (
    <div className="bt">
      <div className="bt-crumbs">
        <Landmark />
        <button onClick={() => navigate('/bank-accounts')}>Banking</button>
        <ChevronRight />
        <b>Bank Transactions</b>
      </div>
      <div className="bt-head">
        <div className="bt-title">
          <span className="bt-title-icon">
            <Building2 />
          </span>
          <div>
            <h1>Bank Transactions</h1>
            <p>
              Track all your bank activity in one place. Search, filter and view like a checkbook.
            </p>
          </div>
        </div>
        <div className="bt-head-tools">
          <label className="bt-search">
            <Search />
            <input
              aria-label="Search transactions"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="Search transactions, cheque no, party, narration..."
            />
            <kbd>⌘ K</kbd>
          </label>
          <button className="bt-btn">
            <CalendarDays /> 01 Sep 2026 - 30 Sep 2026 <ChevronDown />
          </button>
          <span className="bt-split">
            <button className="bt-btn primary" onClick={() => navigate('/vouchers/new')}>
              <Plus /> Add Transaction
            </button>
            <button className="bt-btn primary caret" aria-label="Add transaction options">
              <ChevronDown />
            </button>
          </span>
        </div>
      </div>

      <div className="bt-cards">
        <div className="bt-acct-wrap">
          <button
            className="bt-acct"
            aria-haspopup="listbox"
            aria-expanded={acctOpen}
            onClick={() => setAcctOpen(!acctOpen)}
          >
            <span className="bt-acct-logo">
              <Landmark />
            </span>
            <div>
              <b>{acct.bank}</b>
              <small>{acct.title}</small>
              <em>{acct.iban}</em>
            </div>
            <i>
              <ChevronRight />
            </i>
          </button>
          {acctOpen && (
            <div className="bt-acct-menu" role="listbox">
              <div className="bt-acct-menu-head">Switch account</div>
              {ACCOUNTS.map((a) => (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={a.id === acct.id}
                  className={a.id === acct.id ? 'on' : ''}
                  onClick={() => {
                    setAcctId(a.id)
                    setAcctOpen(false)
                    setSel(null)
                    setPage(1)
                  }}
                >
                  <span className="bt-acct-mark">{a.short}</span>
                  <div>
                    <b>{a.bank}</b>
                    <small>
                      {a.title} · {a.iban.slice(-9)}
                    </small>
                  </div>
                  {a.id === acct.id && <CircleCheck />}
                </button>
              ))}
              <button className="bt-acct-all" onClick={() => navigate('/bank-accounts')}>
                View all bank accounts <ChevronRight />
              </button>
            </div>
          )}
        </div>
        <article>
          <span className="bt-ic mint">
            <Wallet />
          </span>
          <div>
            <small>Opening Balance</small>
            <b>{rs(acct.opening)}</b>
          </div>
        </article>
        <article>
          <span className="bt-ic green">
            <ArrowUpRight />
          </span>
          <div>
            <small>Total Deposits</small>
            <b>{rs(totalIn)}</b>
            <em>{deposits.length + 109} transactions</em>
          </div>
        </article>
        <article>
          <span className="bt-ic red">
            <ArrowDownLeft />
          </span>
          <div>
            <small>Total Withdrawals</small>
            <b>{rs(totalOut)}</b>
            <em>{withdrawals.length + 89} transactions</em>
          </div>
        </article>
        <article>
          <span className="bt-ic mint">
            <Landmark />
          </span>
          <div>
            <small>Closing Balance</small>
            <b>{rs(closing)}</b>
          </div>
        </article>
      </div>

      <div className="bt-tabs-row">
        <div className="bt-tabs">
          {[
            'All Transactions',
            'Deposits',
            'Withdrawals',
            'Cheques',
            'Uncleared',
            'Scheduled (PDC)',
          ].map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              onClick={() => {
                setTab(t)
                setPage(1)
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="bt-views">
          {['Checkbook View', 'Table View', 'Calendar View'].map((v) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className={`bt-body ${current ? '' : 'full'}`}>
        <section className="bt-book">
          <span className="bt-spiral">
            {Array.from({ length: 11 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <div className="bt-book-inner">
            <div className="bt-book-head">
              <span className="bt-book-logo">
                <Landmark />
              </span>
              <div>
                <b>
                  {acct.short} - {acct.title}
                </b>
                <small>Account No: {acct.iban}</small>
              </div>
              <div className="bt-book-right">
                <em>Bank Book</em>
                <small>01 Sep 2026 - 30 Sep 2026</small>
                <i>Page 12</i>
              </div>
            </div>
            {view === 'Calendar View' ? (
              <div className="bt-calendar">
                {Array.from({ length: 30 }, (_, i) => {
                  const d = String(i + 1).padStart(2, '0')
                  const day = rows.filter((r) => r.date.startsWith(d))
                  return (
                    <div key={d} className={day.length ? 'has' : ''}>
                      <b>{i + 1}</b>
                      {day.slice(0, 2).map((r) => (
                        <small key={r.id} className={r.in ? 'in' : 'out'}>
                          {r.in ? '+' : '-'}
                          {money2(r.in || r.out).split('.')[0]}
                        </small>
                      ))}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="table-wrap bt-table">
                <table>
                  <thead>
                    <tr>
                      <th className="chk">✓</th>
                      <th>Date</th>
                      <th>Chq / Ref No.</th>
                      <th>Particulars</th>
                      <th>Type</th>
                      <th className="num">Withdrawal (Rs.)</th>
                      <th className="num">Deposit (Rs.)</th>
                      <th className="num">Balance (Rs.)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((r) => (
                      <tr
                        key={r.id}
                        className={`${r.id === 'OPEN' ? 'open' : ''} ${sel === r.id ? 'sel' : ''}`}
                        onClick={() => {
                          setSel(r.id)
                          setPanelTab('Details')
                        }}
                      >
                        <td className="chk">
                          <label className="bt-check">
                            <input
                              type="checkbox"
                              aria-label={`Mark ${r.particulars}`}
                              checked={checked.includes(r.id)}
                              onChange={() => toggle(r.id)}
                            />
                            <i>
                              <CircleCheck />
                            </i>
                          </label>
                        </td>
                        <td className="date">{r.date}</td>
                        <td className="ref">{r.ref}</td>
                        <td className="part">{r.particulars}</td>
                        <td className="type">{r.type === 'Opening' ? '-' : r.type}</td>
                        <td className="num out">{r.out ? money2(r.out) : '-'}</td>
                        <td className="num in">{r.in ? money2(r.in) : '-'}</td>
                        <td className="num bal">{money2(r.balance)}</td>
                        <td className="dots">
                          <button
                            aria-label={`Actions for ${r.particulars}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate('/cheque-clearing')
                            }}
                          >
                            <Ellipsis />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!slice.length && (
                      <tr>
                        <td colSpan={9}>
                          <div className="empty-state">No transactions match this view.</div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <div className="bt-foot">
              <span>
                Showing {filtered.length ? (cur - 1) * size + 1 : 0} -{' '}
                {Math.min(cur * size, filtered.length)} of 124 transactions
              </span>
              <div className="bt-pager">
                <button
                  aria-label="Previous page"
                  disabled={cur === 1}
                  onClick={() => setPage(cur - 1)}
                >
                  <ChevronLeft />
                </button>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={n === cur ? 'active' : ''}
                    onClick={() => setPage(Math.min(n, pages))}
                  >
                    {n}
                  </button>
                ))}
                <span>…</span>
                <button onClick={() => setPage(pages)}>10</button>
                <button
                  aria-label="Next page"
                  disabled={cur === pages}
                  onClick={() => setPage(cur + 1)}
                >
                  <ChevronRight />
                </button>
              </div>
              <label className="bt-select">
                <select
                  aria-label="Rows per page"
                  value={size}
                  onChange={(e) => {
                    setSize(+e.target.value)
                    setPage(1)
                  }}
                >
                  {[20, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      Show {n}
                    </option>
                  ))}
                </select>
                <ChevronDown />
              </label>
            </div>
          </div>
        </section>

        {current && (
          <aside className="bt-panel">
            <div className="bt-panel-head">
              <span className={`bt-ic ${current.in ? 'mint' : 'red'} sm`}>
                {(() => {
                  const I = kindIcon[current.type]
                  return <I />
                })()}
              </span>
              <div>
                <b>{current.particulars}</b>
                <small>
                  {current.type} · {current.date}
                </small>
              </div>
              <button className="bt-x" aria-label="Close details" onClick={() => setSel(null)}>
                <X />
              </button>
            </div>
            <div className="bt-amount">
              <b className={current.out ? 'out' : 'in'}>
                {current.out ? '− ' : '+ '}Rs.{' '}
                {money2(current.out || current.in || current.balance)}
              </b>
              <span className={`bt-chip ${current.cleared ? 'ok' : 'wait'}`}>
                <CircleCheck />
                {current.cleared ? 'Completed' : 'Pending'}
              </span>
            </div>
            <div className="bt-panel-tabs">
              {['Details', 'Cheque Image', 'Attachments', 'Activity'].map((t) => (
                <button
                  key={t}
                  className={panelTab === t ? 'active' : ''}
                  onClick={() => setPanelTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {panelTab === 'Details' && (
              <dl className="bt-facts">
                <div>
                  <dt>Reference No.</dt>
                  <dd>{current.ref}</dd>
                </div>
                <div>
                  <dt>Transaction Type</dt>
                  <dd>Bank {current.in ? 'Transfer (Credit)' : 'Payment (Debit)'}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{current.date}</dd>
                </div>
                <div>
                  <dt>Party</dt>
                  <dd>{current.party}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>
                    {acct.short} - {acct.title}
                  </dd>
                </div>
                <div>
                  <dt>Narration</dt>
                  <dd>{current.particulars} - Invoice #INV-2026-443</dd>
                </div>
                <div>
                  <dt>Running Balance</dt>
                  <dd>Rs. {money2(current.balance)}</dd>
                </div>
              </dl>
            )}
            {panelTab === 'Cheque Image' && (
              <div className="bt-cheque">
                {current.type === 'Cheque' ? (
                  <>
                    <div className="bt-cheque-img">
                      <ImageIcon />
                      <span>{current.ref}</span>
                    </div>
                    <small>Scanned cheque · front side</small>
                  </>
                ) : (
                  <div className="empty-state">No cheque image for this transaction.</div>
                )}
              </div>
            )}
            {panelTab === 'Attachments' && (
              <div className="bt-docs">
                <div className="bt-doc">
                  <span className="pdf">
                    <FileText />
                  </span>
                  <div>
                    <b>INV-2026-443.pdf</b>
                    <small>245 KB</small>
                  </div>
                  <button aria-label="Download INV-2026-443.pdf">
                    <Download />
                  </button>
                  <button aria-label="More">
                    <Ellipsis />
                  </button>
                </div>
              </div>
            )}
            {panelTab === 'Activity' && (
              <ul className="bt-activity">
                <li>
                  <i />
                  <div>
                    <b>Transaction recorded</b>
                    <small>Saim Javed · {current.date}</small>
                  </div>
                </li>
                <li>
                  <i />
                  <div>
                    <b>{current.cleared ? 'Cleared by bank' : 'Awaiting clearance'}</b>
                    <small>
                      {acct.short} feed · {current.date}
                    </small>
                  </div>
                </li>
              </ul>
            )}
            {panelTab === 'Details' && (
              <div className="bt-panel-actions">
                <button className="bt-btn" onClick={() => navigate('/vouchers/new')}>
                  <Pencil /> Edit
                </button>
                <button className="bt-btn" onClick={() => window.print?.()}>
                  <Printer /> Print Voucher
                </button>
                <button className="bt-btn">
                  More <ChevronDown />
                </button>
              </div>
            )}
            <div className="bt-related">
              <div className="bt-panel-tabs sub">
                {['Related Documents', 'Related Transactions'].map((t) => (
                  <button
                    key={t}
                    className={docTab === t ? 'active' : ''}
                    onClick={() => setDocTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {docTab === 'Related Documents' ? (
                <div className="bt-docs">
                  <div className="bt-doc">
                    <span className="pdf">
                      <FileText />
                    </span>
                    <div>
                      <b>INV-2026-443.pdf</b>
                      <small>245 KB</small>
                    </div>
                    <button aria-label="Download invoice">
                      <Download />
                    </button>
                    <button aria-label="Invoice options">
                      <Ellipsis />
                    </button>
                  </div>
                  <div className="bt-doc">
                    <span className="img">
                      <ImageIcon />
                    </span>
                    <div>
                      <b>payment_receipt.jpg</b>
                      <small>180 KB</small>
                    </div>
                    <button aria-label="Download receipt">
                      <Download />
                    </button>
                    <button aria-label="Receipt options">
                      <Ellipsis />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bt-docs">
                  {rows
                    .filter((r) => r.party === current.party && r.id !== current.id)
                    .slice(0, 3)
                    .map((r) => (
                      <button key={r.id} className="bt-doc as-row" onClick={() => setSel(r.id)}>
                        <span className="img">
                          <Repeat2 />
                        </span>
                        <div>
                          <b>{r.particulars}</b>
                          <small>
                            {r.date} · {r.ref}
                          </small>
                        </div>
                        <em>{money2(r.in || r.out)}</em>
                      </button>
                    ))}
                  {!rows.some((r) => r.party === current.party && r.id !== current.id) && (
                    <div className="empty-state">No related transactions.</div>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
