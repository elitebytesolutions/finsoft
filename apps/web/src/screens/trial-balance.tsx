'use client'
/*
 * /trial-balance — docs/design-system/pages/trial-balance/README.md.
 * Genuinely new screen (M2-S): no prototype ancestor, real API from day one.
 * REPORT/trial-balance@1 (docs/posting-rules/ledger-and-trial-balance.md §3).
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, RotateCw, Scale, ShieldAlert } from 'lucide-react'
import { Banner, Button, PageHead, Kpi } from '@finsoft/ui'
import { moneyFromString } from '@finsoft/ui'
import { getTrialBalance } from '@/lib/api/accounting-client'
import type { TrialBalanceResponse } from '@/lib/api/accounting-types'
import { ApiError } from '@/lib/api/types'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }
  | { status: 'ready'; data: TrialBalanceResponse }

function todayIso(): string {
  // Display default only — the server is the actual authority on "today"
  // (docs/posting-rules/periods.md §5: "the client's clock is never used").
  return new Date().toISOString().slice(0, 10)
}

export function TrialBalance() {
  const [asOf, setAsOf] = useState(todayIso)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback((date: string) => {
    setState({ status: 'loading' })
    getTrialBalance(date).then(
      (data) => setState({ status: 'ready', data }),
      (err: unknown) => {
        if (err instanceof ApiError && err.code === 'forbidden') {
          setState({ status: 'forbidden' })
          return
        }
        const message =
          err instanceof ApiError ? err.message : 'Could not load the trial balance.'
        setState({ status: 'error', message })
      },
    )
  }, [])

  useEffect(() => {
    load(asOf)
  }, [asOf, load])

  return (
    <div>
      <PageHead
        eyebrow="Accounting / Trial balance"
        title="Trial Balance"
        description="Every account with activity, its net position, and the two totals — proven equal."
        actions={
          <label className="al-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <CalendarDays size={16} aria-hidden="true" />
            <span className="sr-only">As of date</span>
            <input
              aria-label="As of date"
              type="date"
              value={asOf}
              max={todayIso()}
              onChange={(e) => setAsOf(e.target.value || todayIso())}
              style={{ border: 0, font: 'inherit', color: 'inherit' }}
            />
          </label>
        }
      />

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading the trial balance…</h1>
          <p>As of {asOf}.</p>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view the trial balance.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the trial balance</h1>
          <p>{state.message}</p>
          <Button onClick={() => load(asOf)}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && <TrialBalanceReady data={state.data} />}
    </div>
  )
}

function TrialBalanceReady({ data }: { data: TrialBalanceResponse }) {
  // The server already asserts totalDebit === totalCredit before responding
  // (contract §4, Invariant 2) — this is a display check on what it sent
  // back, never a recomputation, and it never "corrects" a mismatch.
  const balanced = data.totalDebit === data.totalCredit

  if (data.lines.length === 0) {
    return (
      <div className="empty-state" role="status">
        No activity as of {data.asOf}. Post a voucher or choose a later date.
      </div>
    )
  }

  return (
    <>
      <div className="al-stats">
        <Kpi label="Total debit" value={moneyFromString(data.totalDebit)} change="" icon={Scale} />
        <Kpi label="Total credit" value={moneyFromString(data.totalCredit)} change="" icon={Scale} />
        <Kpi label="Accounts with activity" value={String(data.lines.length)} change="" icon={Scale} />
      </div>

      <Banner tone={balanced ? 'info' : 'danger'} icon={Scale}>
        {balanced
          ? 'Balanced — total debit equals total credit exactly.'
          : `Out of balance — debit ${moneyFromString(data.totalDebit)}, credit ${moneyFromString(data.totalCredit)}. This should not be possible; treat as a data-integrity incident, not a display bug to round away.`}
      </Banner>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th className="num">Debit (PKR)</th>
              <th className="num">Credit (PKR)</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.accountId}>
                <td>{line.code}</td>
                <td>{line.name}</td>
                <td className="num">{moneyFromString(line.debit, { zeroAsDash: true })}</td>
                <td className="num">{moneyFromString(line.credit, { zeroAsDash: true })}</td>
              </tr>
            ))}
            <tr className="vou-total">
              <td colSpan={2}>Total</td>
              <td className="num">
                <b>{moneyFromString(data.totalDebit)}</b>
              </td>
              <td className="num">
                <b>{moneyFromString(data.totalCredit)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
