'use client'
/*
 * /ledgers — docs/design-system/pages/account-ledger/README.md.
 * Real API: GET /api/accounts (postable accounts for the picker) + GET /api/ledgers/:accountId
 * (the statement). Accepts `?account=<code>` for a deep link (Chart of Accounts' "View ledger").
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Landmark, RotateCw, ShieldAlert } from 'lucide-react'
import { Button, moneyFromString } from '@finsoft/ui'
import { useNavigate, useSearchParams } from '@/lib/router'
import { listAccounts, getLedger } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { postableAccounts, accountByCode } from '@/lib/accounting/account-tree'
import { formatRunningBalance } from '@/lib/money/running-balance'
import type { AccountDto, LedgerResponse } from '@/lib/api/accounting-types'

function startOfMonthIso(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function AccountLedger() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { state: accountsState, reload: reloadAccounts } = useApiQuery(
    () => listAccounts().then((r) => postableAccounts(r.accounts)),
    [],
  )
  const [code, setCode] = useState<string | null>(params.get('account'))
  const [from, setFrom] = useState(startOfMonthIso)
  const [to, setTo] = useState(todayIso)

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
          <p>Every posting in date order with a running balance, read from the server.</p>
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

      {accountsState.status === 'ready' && (
        <LedgerBody
          accounts={accountsState.data}
          code={code ?? accountsState.data[0]?.code ?? null}
          onCodeChange={setCode}
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
        />
      )}
    </div>
  )
}

function LedgerBody({
  accounts,
  code,
  onCodeChange,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  accounts: AccountDto[]
  code: string | null
  onCodeChange: (code: string) => void
  from: string
  to: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
}) {
  const account = code ? accountByCode(accounts, code) : undefined
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

  if (accounts.length === 0) {
    return <div className="empty-state">No postable accounts exist yet.</div>
  }

  const allLines = pages.flatMap((p) => p.lines)
  const lastPage = pages[pages.length - 1]

  return (
    <>
      <section className="al-card al-account">
        <span className="al-account-icon">
          <Landmark />
        </span>
        <div className="al-account-text">
          <div>
            <h2>{account?.name ?? 'Select an account'}</h2>
          </div>
          {account && (
            <p>
              {account.code} · {account.type} ·{' '}
              {account.normalBalance === 'DEBIT' ? 'Debit' : 'Credit'}
            </p>
          )}
        </div>
        <label className="al-select">
          <select
            aria-label="Switch account"
            value={code ?? ''}
            onChange={(e) => onCodeChange(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.code}>
                {a.name}
              </option>
            ))}
          </select>
          <span>Switch account</span>
          <ChevronDown />
        </label>
      </section>

      <div className="al-filter" style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
        <label>
          From{' '}
          <input
            aria-label="From date"
            type="date"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            max={to}
          />
        </label>
        <label>
          To{' '}
          <input
            aria-label="To date"
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
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

      {state.status === 'ready' && lastPage && (
        <>
          <div className="al-stats">
            <Kpi label="Opening balance" value={formatRunningBalance(pages[0].openingBalance)} />
            <Kpi label="Closing balance" value={formatRunningBalance(lastPage.closingBalance)} />
          </div>

          {allLines.length === 0 ? (
            <div className="empty-state">
              No postings on {account?.code} between {from} and {to}.
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
                      {formatRunningBalance(pages[0].openingBalance).side}
                    </td>
                  </tr>
                  {allLines.map((line) => {
                    const running = formatRunningBalance(line.runningBalance)
                    return (
                      <tr key={line.lineId}>
                        <td className="date">{line.occurredAt}</td>
                        <td>
                          <span className="al-ref">{line.entryNumber}</span>
                        </td>
                        <td className="part">
                          <b>{line.narration}</b>
                          {line.entryStatus === 'REVERSED' && <small> · reversed</small>}
                          {line.reversalOf && <small> · reverses an earlier entry</small>}
                        </td>
                        <td className="num dr">
                          {moneyFromString(line.debit, { zeroAsDash: true })}
                        </td>
                        <td className="num cr">
                          {moneyFromString(line.credit, { zeroAsDash: true })}
                        </td>
                        <td className="num bal">
                          {running.amount} <small>{running.side}</small>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {lastPage.nextCursor && (
            <div style={{ textAlign: 'center', margin: '12px 0' }}>
              <Button kind="secondary" onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

function Kpi({ label, value }: { label: string; value: { amount: string; side: 'Dr' | 'Cr' } }) {
  return (
    <article>
      <div>
        <small>{label}</small>
        <b>
          {value.amount} {value.side}
        </b>
      </div>
    </article>
  )
}
