'use client'
/*
 * /ledgers — the PO's original design (8c5c283), restored. Real data: GET /api/accounts
 * (postable accounts for the picker) + GET /api/ledgers/:accountId (the statement, with cursor
 * pagination — `from`/`to` both required by the contract, there is no "whole history" call).
 * Accepts `?account=<code>` for a deep link (Chart of Accounts' "View ledger").
 *
 * The mock's `buildLedger` (ledger-data.ts) summed raw journal amounts in the browser to derive
 * a running balance. That is gone: every row's running balance is
 * `@/lib/adapters/account-ledger`'s reshaping of the line's own server-computed
 * `runningBalance` (ledger-and-trial-balance.md §2) via `formatRunningBalance` — never
 * re-derived. "Related Accounts" balances are the same rule: each is that account's OWN
 * `closingBalance` from its own ledger call, not a locally summed figure.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from '@/lib/router'
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Calculator,
  Ellipsis,
  FileText,
  Filter,
  Landmark,
  RotateCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react'
import { Button } from '@finsoft/ui'
import { listAccounts, getLedger } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { postableAccounts, accountByCode } from '@/lib/accounting/account-tree'
import { adaptLedgerPages, type LedgerRow } from '@/lib/adapters/account-ledger'
import { formatRunningBalance } from '@/lib/money/running-balance'
import { startOfMonthIso, todayIso } from '@/lib/date/local-date'
import type { AccountDto, LedgerResponse } from '@/lib/api/accounting-types'

const typeOf = (row: LedgerRow) =>
  row.reversed ? 'Reversed' : /sale/i.test(row.desc) ? 'Sales' : 'Journal'

export function AccountLedger() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { state: accountsState, reload: reloadAccounts } = useApiQuery(
    () => listAccounts().then((r) => postableAccounts(r.accounts)),
    [],
  )
  const [code, setCode] = useState<string | null>(params.get('account'))

  return (
    <div className="al">
      <div className="al-head">
        <div>
          <div className="al-crumbs">
            <button onClick={() => navigate('/accounts')}>Accounting</button>
            <ChevronRight />
            <span>Ledgers</span>
          </div>
          <h1>Account Ledger</h1>
          <p>Detailed transactions and running balance, read from the server.</p>
        </div>
      </div>

      {accountsState.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading accounts…</h1>
        </div>
      )}

      {accountsState.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view account ledgers.</p>
        </div>
      )}

      {accountsState.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the account list</h1>
          <p>{accountsState.message}</p>
          <Button onClick={reloadAccounts}>Try again</Button>
        </div>
      )}

      {accountsState.status === 'ready' &&
        (accountsState.data.length === 0 ? (
          <div className="empty-state">No postable accounts exist yet.</div>
        ) : (
          <LedgerBody
            accounts={accountsState.data}
            code={code ?? accountsState.data[0]?.code ?? null}
            onCodeChange={setCode}
          />
        ))}
    </div>
  )
}

function LedgerBody({
  accounts,
  code,
  onCodeChange,
}: {
  accounts: AccountDto[]
  code: string | null
  onCodeChange: (code: string) => void
}) {
  const navigate = useNavigate()
  const account = code ? accountByCode(accounts, code) : undefined
  const [from, setFrom] = useState(startOfMonthIso)
  const [to, setTo] = useState(todayIso)
  const [query, setQuery] = useState(''),
    [sideQuery, setSideQuery] = useState('')
  const [rowsPer, setRowsPer] = useState(25),
    [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [pages, setPages] = useState<LedgerResponse[]>([])

  const { state, reload } = useApiQuery(
    () => (account ? getLedger(account.id, { from, to }) : Promise.reject(new Error('no account'))),
    [account?.id, from, to],
  )

  useEffect(() => {
    if (state.status === 'ready') setPages([state.data])
  }, [state])

  const loadMore = () => {
    if (!account || pages.length === 0) return
    const next = pages[pages.length - 1].nextCursor
    if (!next) return
    getLedger(account.id, { from, to, cursor: next }).then((page) => {
      setPages((prev) => [...prev, page])
    })
  }

  const adapted = useMemo(() => (pages.length ? adaptLedgerPages(pages) : null), [pages])
  const related = accounts
    .filter((m) => `${m.code} ${m.name}`.toLowerCase().includes(sideQuery.toLowerCase()))
    .slice(0, 9)

  const filtered = (adapted?.rows ?? []).filter((r) =>
    `${r.ref} ${r.desc} ${r.toBy}`.toLowerCase().includes(query.toLowerCase()),
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPer)),
    cur = Math.min(page, pageCount),
    pageRows = filtered.slice((cur - 1) * rowsPer, cur * rowsPer)

  if (!account) return <div className="empty-state">Select an account.</div>

  return (
    <>
      <section className="al-card al-account">
        <span className="al-account-icon">
          <Landmark />
        </span>
        <div className="al-account-text">
          <div>
            <h2>{account.name}</h2>
            <span className="al-status">{account.isActive ? 'Active' : 'Inactive'}</span>
          </div>
          <p>
            {account.code} <i /> {account.type} <i />{' '}
            {account.normalBalance === 'DEBIT' ? 'Debit' : 'Credit'}
          </p>
        </div>
        <div className="al-office">
          <span className="al-office-icon">
            <Landmark />
          </span>
          <div>
            <b>Main Book</b>
          </div>
          <label className="al-select">
            <select
              aria-label="Switch account"
              value={account.code}
              onChange={(e) => {
                onCodeChange(e.target.value)
                setPage(1)
              }}
            >
              {accounts.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))}
            </select>
            <span>Switch account</span>
            <ChevronDown />
          </label>
        </div>
      </section>

      <div className="al-filter" style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
        <label>
          From{' '}
          <input
            aria-label="From date"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            max={to}
          />
        </label>
        <label>
          To{' '}
          <input
            aria-label="To date"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            max={todayIso()}
          />
        </label>
      </div>

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading the ledger…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view this ledger.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the ledger</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && adapted && (
        <>
          <div className="al-stats">
            <article>
              <span className="al-stat-icon">
                <Coins />
              </span>
              <div>
                <small>Opening Balance</small>
                <b>
                  {adapted.opening.amount} {adapted.opening.side}
                </b>
              </div>
            </article>
            <article>
              <span className="al-stat-icon">
                <Calculator />
              </span>
              <div>
                <small>Closing Balance</small>
                <b>
                  {adapted.closing.amount} {adapted.closing.side}
                </b>
              </div>
            </article>
            <article>
              <span className="al-stat-icon purple">
                <FileText />
              </span>
              <div>
                <small>Total Transactions</small>
                <b>{adapted.count}</b>
                <em>In this period</em>
              </div>
            </article>
          </div>

          <div className="al-body">
            <aside className="al-card al-side">
              <h3>Related Accounts</h3>
              <label className="al-search">
                <Search />
                <input
                  aria-label="Search accounts"
                  value={sideQuery}
                  onChange={(e) => setSideQuery(e.target.value)}
                  placeholder="Search accounts..."
                />
              </label>
              <ul>
                {related.map((m) => (
                  <li key={m.code}>
                    <button
                      className={m.code === account.code ? 'active' : ''}
                      onClick={() => {
                        onCodeChange(m.code)
                        setPage(1)
                      }}
                    >
                      <span className="al-side-icon">
                        <Landmark />
                      </span>
                      <div>
                        <b>{m.name}</b>
                        <small>
                          {m.code} <i /> {m.type}
                        </small>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <button className="al-btn wide" onClick={() => navigate('/accounts')}>
                View All Accounts <ArrowRight />
              </button>
            </aside>

            <section className="al-card al-main">
              <div className="al-main-head">
                <div>
                  <h3>Ledger Transactions ({adapted.count})</h3>
                  <p>Every posting in date order with running balance after each transaction.</p>
                </div>
                <div className="al-main-tools">
                  <label className="al-search wide">
                    <Search />
                    <input
                      aria-label="Search transactions"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value)
                        setPage(1)
                      }}
                      placeholder="Search by voucher, particulars or reference..."
                    />
                  </label>
                  <button
                    className={`al-btn ${filtersOpen ? 'primary' : ''}`}
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen(!filtersOpen)}
                  >
                    <Filter /> Filters
                  </button>
                </div>
              </div>
              {filtersOpen && (
                <div className="al-filters">
                  <div className="al-filter">
                    <CalendarDays />
                    <div>
                      <small>Date</small>
                      <b>
                        {from} – {to}
                      </b>
                    </div>
                  </div>
                  <button className="al-link right" onClick={() => setFiltersOpen(false)}>
                    <X /> Close
                  </button>
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="empty-state">
                  No postings on {account.code} between {from} and {to}.
                </div>
              ) : (
                <div className="table-wrap al-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Voucher</th>
                        <th>Particulars</th>
                        <th className="num">Debit</th>
                        <th className="num">Credit</th>
                        <th className="num">Balance</th>
                        <th className="ctr" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="bf">
                        <td className="date">{from}</td>
                        <td>—</td>
                        <td className="part">
                          <b>Balance brought forward</b>
                        </td>
                        <td className="num">—</td>
                        <td className="num">—</td>
                        <td className="num bal">
                          {formatRunningBalance(pages[0].openingBalance).amount}{' '}
                          <small>{formatRunningBalance(pages[0].openingBalance).side}</small>
                        </td>
                        <td className="ctr" />
                      </tr>
                      {pageRows.map((r, i) => (
                        <tr key={`${r.ref}-${i}`}>
                          <td className="date">{r.date}</td>
                          <td>
                            <span className="al-ref">{r.ref}</span>
                            <span className={`al-type ${typeOf(r).toLowerCase()}`}>
                              {typeOf(r)}
                            </span>
                          </td>
                          <td className="part">
                            <b>{r.desc}</b>
                            <small>{r.toBy}</small>
                          </td>
                          <td className="num dr">{r.dr}</td>
                          <td className="num cr">{r.cr}</td>
                          <td className="num bal">
                            {r.runningAmount} <small>{r.runningSide}</small>
                          </td>
                          <td className="ctr">
                            <button
                              className="al-dots"
                              aria-label={`Actions for ${r.ref}`}
                              onClick={() => navigate(`/vouchers`)}
                            >
                              <Ellipsis />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="al-foot">
                <span>
                  Showing {filtered.length ? (cur - 1) * rowsPer + 1 : 0}–
                  {Math.min(cur * rowsPer, filtered.length)} of {adapted.count} transactions
                </span>
                <span className="al-foot-rows">
                  Rows:{' '}
                  <label className="al-select sm">
                    <select
                      aria-label="Rows per page"
                      value={rowsPer}
                      onChange={(e) => {
                        setRowsPer(+e.target.value)
                        setPage(1)
                      }}
                    >
                      {[10, 25, 50].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                    <ChevronDown />
                  </label>
                </span>
                <div className="al-pager">
                  <button
                    aria-label="Previous page"
                    disabled={cur === 1}
                    onClick={() => setPage(cur - 1)}
                  >
                    <ChevronLeft />
                  </button>
                  {Array.from({ length: pageCount }, (_, i) => i + 1)
                    .slice(0, 5)
                    .map((n) => (
                      <button
                        key={n}
                        className={n === cur ? 'active' : ''}
                        onClick={() => setPage(n)}
                      >
                        {n}
                      </button>
                    ))}
                  <button
                    aria-label="Next page"
                    disabled={cur === pageCount}
                    onClick={() => setPage(cur + 1)}
                  >
                    <ChevronRight />
                  </button>
                </div>
              </div>
              {pages[pages.length - 1]?.nextCursor && (
                <div style={{ textAlign: 'center', margin: '12px 0' }}>
                  <Button kind="secondary" onClick={loadMore}>
                    Load more
                  </Button>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </>
  )
}
