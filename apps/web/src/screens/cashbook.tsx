'use client'
/*
 * /cash-book — docs/design-system/pages/cash-book/README.md.
 * The read-only ledger of the Cash in Hand account (role CASH_DEFAULT, code 1110 interim —
 * GET /api/accounts carries `role` precisely so this can move off the hardcoded code once a
 * chart ever diverges from standard-v1). Cash entries are recorded via a Journal Voucher
 * (/vouchers/new); the separate /cash-transactions entry screen stays a prototype.
 */
import { useEffect, useState } from 'react'
import { RotateCw, ShieldAlert, Wallet } from 'lucide-react'
import { Banner, Button, PageHead, moneyFromString } from '@finsoft/ui'
import { useNavigate } from '@/lib/router'
import { listAccounts, getLedger } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { accountByRole, accountByCode } from '@/lib/accounting/account-tree'
import { formatRunningBalance } from '@/lib/money/running-balance'
import type { AccountDto, LedgerResponse } from '@/lib/api/accounting-types'

const CASH_ROLE = 'CASH_DEFAULT'
const CASH_CODE_INTERIM = '1110'

function startOfMonthIso(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function CashBook() {
  const navigate = useNavigate()
  const { state, reload } = useApiQuery(() => listAccounts().then((r) => [...r.accounts]), [])

  return (
    <div>
      <PageHead
        eyebrow="Accounting"
        title="Cash Book"
        description="Cash in Hand (1110) — read-only. Record a cash movement with a journal voucher."
        actions={
          <Button onClick={() => navigate('/vouchers/new')}>
            <Wallet size={14} /> Post a voucher
          </Button>
        }
      />

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view the cash book.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the cash book</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && <CashBookReady accounts={state.data} />}
    </div>
  )
}

function CashBookReady({ accounts }: { accounts: AccountDto[] }) {
  const byRole = accountByRole(accounts, CASH_ROLE)
  const byCode = accountByCode(accounts, CASH_CODE_INTERIM)
  const cash = byRole ?? byCode

  if (!cash) {
    return (
      <div className="empty-state">
        No account holds the Cash in Hand role ({CASH_ROLE}) in this tenant's chart. This should not
        happen on the standard chart — contact support.
      </div>
    )
  }

  return <CashLedger account={cash} usedInterimLookup={!byRole} />
}

function CashLedger({ account, usedInterimLookup }: { account: AccountDto; usedInterimLookup: boolean }) {
  const [from] = useState(startOfMonthIso)
  const [to] = useState(todayIso)
  const [pages, setPages] = useState<LedgerResponse[]>([])
  const { state, reload } = useApiQuery(() => getLedger(account.id, { from, to }), [account.id, from, to])

  useEffect(() => {
    if (state.status === 'ready') setPages([state.data])
  }, [state])

  const loadMore = () => {
    const last = pages[pages.length - 1]
    if (!last?.nextCursor) return
    getLedger(account.id, { from, to, cursor: last.nextCursor }).then((page) =>
      setPages((prev) => [...prev, page]),
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <span>
          <RotateCw />
        </span>
        <h1>Loading the cash book…</h1>
      </div>
    )
  }
  if (state.status === 'forbidden') {
    return (
      <div className="state-page" role="alert">
        <span>
          <ShieldAlert />
        </span>
        <h1>Access restricted</h1>
        <p>Your role does not have permission to view the cash book.</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="state-page" role="alert">
        <span>
          <ShieldAlert />
        </span>
        <h1>We could not load the cash book</h1>
        <p>{state.message}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    )
  }

  const lastPage = pages[pages.length - 1]
  if (!lastPage) return null
  const allLines = pages.flatMap((p) => p.lines)
  const opening = formatRunningBalance(pages[0].openingBalance)
  const closing = formatRunningBalance(lastPage.closingBalance)

  return (
    <>
      {usedInterimLookup && (
        <Banner tone="warn">
          Resolved by code {CASH_CODE_INTERIM}, not by role — no account in this tenant's chart holds
          the {CASH_ROLE} role. If this tenant's chart ever diverges from the standard template, this
          page may be looking at the wrong account.
        </Banner>
      )}
      <div className="al-stats">
        <article>
          <div>
            <small>Opening balance</small>
            <b>
              {opening.amount} {opening.side}
            </b>
          </div>
        </article>
        <article>
          <div>
            <small>Closing balance</small>
            <b>
              {closing.amount} {closing.side}
            </b>
          </div>
        </article>
      </div>

      {allLines.length === 0 ? (
        <div className="empty-state">No cash movements between {from} and {to}.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Voucher No.</th>
                <th>Particulars</th>
                <th className="num">Receipt (Rs)</th>
                <th className="num">Payment (Rs)</th>
                <th className="num">Balance (Rs)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {allLines.map((line) => {
                const running = formatRunningBalance(line.runningBalance)
                return (
                  <tr key={line.lineId}>
                    <td>{line.occurredAt}</td>
                    <td>{line.entryNumber}</td>
                    <td>{line.narration}</td>
                    <td className="num">{moneyFromString(line.debit, { zeroAsDash: true })}</td>
                    <td className="num">{moneyFromString(line.credit, { zeroAsDash: true })}</td>
                    <td className="num">
                      {running.amount} <small>{running.side}</small>
                    </td>
                    <td>{line.entryStatus === 'REVERSED' ? 'Reversed' : 'Posted'}</td>
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
  )
}
