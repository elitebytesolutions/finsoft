'use client'
/*
 * /vouchers — docs/design-system/pages/voucher-register/README.md.
 * Real API: GET /api/journals (list — entry headers only, contract §8 decision 2: lines live on
 * the detail route) + GET /api/journals/:id (inspector, on selection) + GET /api/accounts (to
 * name the inspector's line accounts — the ledger/journal responses carry only accountId).
 */
import { useState } from 'react'
import { ChevronRight, RotateCw, ShieldAlert } from 'lucide-react'
import { Badge, Banner, Button, moneyFromString } from '@finsoft/ui'
import { useNavigate } from '@/lib/router'
import { getJournal, listJournals, listAccounts } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import type {
  AccountDto,
  JournalEntryDetail,
  JournalEntrySummary,
} from '@/lib/api/accounting-types'

type StatusFilter = 'All' | 'POSTED' | 'REVERSED'

export function VoucherRegister() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<StatusFilter>('All')
  const [sel, setSel] = useState<string | null>(null)

  const { state, reload } = useApiQuery(
    () => listJournals(status === 'All' ? {} : { status }),
    [status],
  )
  const { state: accountsState } = useApiQuery(
    () => listAccounts().then((r) => [...r.accounts]),
    [],
  )

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
          <p>Every journal voucher, newest first. Select one to see its ledger entries.</p>
        </div>
        <div className="vg-head-actions">
          <Button onClick={() => navigate('/vouchers/new')}>New Journal Voucher</Button>
        </div>
      </div>

      <div className="vg-tabs">
        {(['All', 'POSTED', 'REVERSED'] as const).map((s) => (
          <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
            {s === 'All' ? 'All' : s === 'POSTED' ? 'Posted' : 'Reversed'}
          </button>
        ))}
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
        <div className="vg-body">
          <section className="vg-list">
            {state.data.items.length === 0 ? (
              <div className="empty-state">
                {status === 'All'
                  ? 'No vouchers yet. Vouchers you post will appear here.'
                  : 'No vouchers match this filter.'}
              </div>
            ) : (
              <div className="vg-timeline">
                {state.data.items.map((v) => (
                  <VoucherRow
                    key={v.id}
                    voucher={v}
                    active={sel === v.id}
                    onSelect={() => setSel(v.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {sel && (
            <Inspector
              id={sel}
              accounts={accountsState.status === 'ready' ? accountsState.data : []}
              onClose={() => setSel(null)}
              onOpen={() => navigate(`/vouchers/${sel}`)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function VoucherRow({
  voucher,
  active,
  onSelect,
}: {
  voucher: JournalEntrySummary
  active: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" className={`vg-card ${active ? 'active' : ''}`} onClick={onSelect}>
      <span className="vg-tag jv">JV</span>
      <span className="vg-id">
        <b>{voucher.entryNumber}</b>
        <small>{voucher.occurredAt}</small>
      </span>
      <span className="vg-part">
        <b>{voucher.narration}</b>
        {voucher.reference && <small>{voucher.reference}</small>}
      </span>
      <span className={`vg-status ${voucher.status.toLowerCase()}`}>
        <Badge tone={voucher.status === 'POSTED' ? 'good' : 'danger'}>
          {voucher.status === 'POSTED' ? 'Posted' : 'Reversed'}
        </Badge>
      </span>
      <ChevronRight className="vg-chev" />
    </button>
  )
}

function Inspector({
  id,
  accounts,
  onClose,
  onOpen,
}: {
  id: string
  accounts: AccountDto[]
  onClose: () => void
  onOpen: () => void
}) {
  const { state } = useApiQuery(() => getJournal(id), [id])

  return (
    <aside className="vg-panel">
      <div className="vg-panel-head">
        <div>
          <h2>{state.status === 'ready' ? state.data.entryNumber : 'Loading…'}</h2>
        </div>
        <button className="vg-btn icon ghost" aria-label="Close panel" onClick={onClose}>
          ✕
        </button>
      </div>

      {state.status === 'loading' && <p>Loading entries…</p>}
      {state.status === 'forbidden' && <p>You do not have permission to view this voucher.</p>}
      {state.status === 'error' && <p>{state.message}</p>}
      {state.status === 'ready' && (
        <InspectorReady entry={state.data} accounts={accounts} onOpen={onOpen} />
      )}
    </aside>
  )
}

function InspectorReady({
  entry,
  accounts,
  onOpen,
}: {
  entry: JournalEntryDetail
  accounts: AccountDto[]
  onOpen: () => void
}) {
  const nameOf = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId)
    return account ? `${account.name} (${account.code})` : accountId
  }
  return (
    <>
      <p>{entry.narration}</p>
      {entry.status === 'REVERSED' && <Banner tone="danger">Reversed.</Banner>}
      <table className="vg-entries">
        <thead>
          <tr>
            <th>#</th>
            <th>Account</th>
            <th className="num">Debit (Rs)</th>
            <th className="num">Credit (Rs)</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((line) => (
            <tr key={line.lineNumber}>
              <td>{line.lineNumber}</td>
              <td>{nameOf(line.accountId)}</td>
              <td className="num">{moneyFromString(line.debit, { zeroAsDash: true })}</td>
              <td className="num">{moneyFromString(line.credit, { zeroAsDash: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="vg-panel-actions">
        <button className="vg-btn primary" onClick={onOpen}>
          Open voucher
        </button>
      </div>
    </>
  )
}
