'use client'
/*
 * /cash-book — the PO's original design (8c5c283), restored, PLUS the real ledger view M2-S
 * built. Two things behind one screen, deliberately additive (CLAUDE.md screen-parity rule:
 * "never delete it"):
 *
 *   1. The original "Cash In" / "Cash Out" quick-entry panels. There is no dedicated
 *      cash-in/cash-out endpoint — M2-S's own note on this screen said so, correctly: "cash
 *      entries are recorded via a Journal Voucher". So a Cash In/Out entry here really is a
 *      plain two-line balanced JV (`@/lib/adapters/cash-book`'s `buildCashEntryRequest`),
 *      posted through the same `postJournal` + idempotency-key + confirm-before-post path
 *      every other posting screen uses. The fabricated "Main Cash Drawer / Bank Account /
 *      Petty Cash" balances the mock invented (locally summed client-side deltas over a fake
 *      base) are GONE — there is no multi-drawer model in the real chart, only the one
 *      CASH_DEFAULT-role account this screen already resolves below.
 *   2. `CashBookReady`/`CashLedger` — M2-S's read-only statement of that same account,
 *      unchanged (same markup, same text, same role/code-fallback banner), so its existing
 *      tests (cashbook.test.tsx) keep passing without a single selector change.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
  CloudUpload,
  CreditCard,
  FileText,
  MessageSquareText,
  RotateCw,
  Save,
  ShieldAlert,
  Tag,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import { Banner, Button, Modal, moneyFromString } from '@finsoft/ui'
import { useNavigate } from '@/lib/router'
import { listAccounts, getLedger, postJournal } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import {
  accountByRole,
  accountByCode,
  postableJournalAccounts,
} from '@/lib/accounting/account-tree'
import { adaptLedgerPages } from '@/lib/adapters/account-ledger'
import { buildCashEntryRequest } from '@/lib/adapters/cash-book'
import { formatRunningBalance } from '@/lib/money/running-balance'
import { startOfMonthIso, todayIso } from '@/lib/date/local-date'
import { ApiError } from '@/lib/api/types'
import type { AccountDto, LedgerResponse } from '@/lib/api/accounting-types'

const CASH_ROLE = 'CASH_DEFAULT'
const CASH_CODE_INTERIM = '1110'

export function CashBook() {
  const navigate = useNavigate()
  const { state, reload } = useApiQuery(() => listAccounts().then((r) => [...r.accounts]), [])

  return (
    <div className="cb-page">
      <div className="cb-head">
        <div>
          <h1>Cash Book</h1>
          <p>Record cash movement quickly, and see the account's statement below.</p>
        </div>
        <Button kind="secondary" onClick={() => navigate('/vouchers/new')}>
          <Wallet size={14} /> Post a full voucher instead
        </Button>
      </div>

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

  return <CashScreen cash={cash} accounts={accounts} usedInterimLookup={!byRole} />
}

function CashScreen({
  cash,
  accounts,
  usedInterimLookup,
}: {
  cash: AccountDto
  accounts: AccountDto[]
  usedInterimLookup: boolean
}) {
  const [refreshToken, setRefreshToken] = useState(0)
  return (
    <>
      <CashEntryPanels
        cashAccount={cash}
        counterAccounts={postableJournalAccounts(accounts).filter((a) => a.id !== cash.id)}
        onPosted={() => setRefreshToken((n) => n + 1)}
      />
      <CashLedger
        account={cash}
        usedInterimLookup={usedInterimLookup}
        refreshToken={refreshToken}
      />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Restored original — Cash In / Cash Out quick entry
 * ------------------------------------------------------------------ */

type Kind = 'In' | 'Out'
interface EntryForm {
  date: string
  party: string
  counterAccountId: string
  mode: string
  reference: string
  amount: string
  notes: string
}
const emptyForm = (): EntryForm => ({
  date: todayIso(),
  party: '',
  counterAccountId: '',
  mode: 'Cash',
  reference: '',
  amount: '',
  notes: '',
})

function Field({
  label,
  required,
  icon,
  children,
  full,
}: {
  label: string
  required?: boolean
  icon: ReactNode
  children: ReactNode
  full?: boolean
}) {
  return (
    <label className={`cb-f${full ? ' full' : ''}`}>
      <span className="cb-l">
        {label}
        {required && <em>*</em>}
      </span>
      <span className="cb-in">
        <i>{icon}</i>
        {children}
      </span>
    </label>
  )
}
function GroupLabel({ label, first }: { label: string; first?: boolean }) {
  return <div className={`cb-group-label${first ? ' first' : ''}`}>{label}</div>
}

function CashEntryPanels({
  cashAccount,
  counterAccounts,
  onPosted,
}: {
  cashAccount: AccountDto
  counterAccounts: AccountDto[]
  onPosted: () => void
}) {
  const [fin, setFin] = useState(emptyForm())
  const [fout, setFout] = useState(emptyForm())
  const [confirmKind, setConfirmKind] = useState<Kind | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key: keyIn, reset: resetIn } = useIdempotencyKey()
  const { key: keyOut, reset: resetOut } = useIdempotencyKey()

  const requestSubmit = (kind: Kind) => (e: FormEvent) => {
    e.preventDefault()
    const f = kind === 'In' ? fin : fout
    if (!f.counterAccountId || !f.amount) return
    setError(null)
    setConfirmKind(kind)
  }

  const doPost = async (kind: Kind) => {
    const f = kind === 'In' ? fin : fout
    setSubmitting(true)
    setError(null)
    try {
      const body = buildCashEntryRequest({
        kind,
        cashAccountId: cashAccount.id,
        counterAccountId: f.counterAccountId,
        amount: f.amount,
        date: f.date,
        party: f.party,
        reference: f.reference,
        notes:
          kind === 'Out' && f.mode !== 'Cash' ? `Payment mode: ${f.mode}. ${f.notes}` : f.notes,
      })
      const usedKey = kind === 'In' ? keyIn : keyOut
      await postJournal(body, usedKey)
      if (kind === 'In') {
        resetIn()
        setFin(emptyForm())
      } else {
        resetOut()
        setFout(emptyForm())
      }
      setConfirmKind(null)
      onPosted()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post this entry. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const renderPanel = (kind: Kind) => {
    const f = kind === 'In' ? fin : fout,
      set = (p: Partial<EntryForm>) =>
        kind === 'In' ? setFin((x) => ({ ...x, ...p })) : setFout((x) => ({ ...x, ...p }))
    const out = kind === 'Out'
    return (
      <form className={`cb-panel ${out ? 'out' : 'in'}`} onSubmit={requestSubmit(kind)}>
        <div className="cb-ph">
          <span className="cb-ph-icon">{out ? <ArrowUpFromLine /> : <ArrowDownToLine />}</span>
          <div>
            <h2>{out ? 'Cash Out' : 'Cash In'}</h2>
            <p>{out ? `From ${cashAccount.name}` : `Into ${cashAccount.name}`}</p>
          </div>
        </div>
        <div className="cb-grid">
          <GroupLabel label="When" first />
          <Field label="Date" required icon={<CalendarDays />}>
            <input
              type="date"
              value={f.date}
              max={todayIso()}
              onChange={(e) => set({ date: e.target.value })}
            />
          </Field>
          <GroupLabel label="Who" />
          <Field label={out ? 'Paid To / Party' : 'Received From / Party'} icon={<User />} full>
            <input
              value={f.party}
              onChange={(e) => set({ party: e.target.value })}
              placeholder={out ? 'Office Mart Sdn Bhd' : 'Walk-in Customer'}
            />
          </Field>
          <Field label="Customer / Vendor" icon={<Users />} full>
            <select disabled title="Coming soon — see Receivables">
              <option>Picker coming soon</option>
            </select>
          </Field>
          <GroupLabel label="What" />
          <Field
            label={out ? 'Expense / Payable account' : 'Income / Receivable account'}
            required
            icon={<Tag />}
          >
            <select
              aria-label={out ? 'Expense or payable account' : 'Income or receivable account'}
              value={f.counterAccountId}
              onChange={(e) => set({ counterAccountId: e.target.value })}
            >
              <option value="">Select an account</option>
              {counterAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment Mode" icon={<CreditCard />}>
            <select value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
              {['Cash', 'Cheque', 'Bank transfer', 'Card'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Reference No." icon={<FileText />}>
            <input
              value={f.reference}
              onChange={(e) => set({ reference: e.target.value })}
              placeholder={out ? 'e.g. BILL-2045' : 'e.g. INV-1042'}
            />
          </Field>
          <GroupLabel label="Amount" />
          <Field label="Amount (PKR)" required icon={<b className="cb-rs">Rs</b>} full>
            <input
              aria-label={`${out ? 'Cash out' : 'Cash in'} amount`}
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="0.00"
            />
          </Field>
          <GroupLabel label="Notes" />
          <Field label="Notes / Narration" icon={<MessageSquareText />} full>
            <input
              value={f.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder={
                out
                  ? 'e.g. Office supplies purchase, invoice no., etc.'
                  : 'e.g. Payment for invoice'
              }
            />
          </Field>
        </div>
        <div className="cb-attach">
          <span className="cb-l">Receipt / Attachment</span>
          <label className="cb-drop" title="Coming soon">
            <div className="cb-drop-icon">
              <CloudUpload />
            </div>
            <div className="cb-drop-body">
              <b>Attachments are not available yet</b>
              <small>PDF · JPG · PNG — coming soon</small>
            </div>
            <input type="file" hidden disabled />
          </label>
        </div>
        <button className="cb-save" type="submit" disabled={!f.counterAccountId || !f.amount}>
          <Save /> {out ? 'Save Cash Out' : 'Save Cash In'}
        </button>
      </form>
    )
  }

  const confirmForm = confirmKind === 'In' ? fin : confirmKind === 'Out' ? fout : null
  const confirmAccount = confirmForm
    ? counterAccounts.find((a) => a.id === confirmForm.counterAccountId)
    : null
  const confirmAmountDisplay = (() => {
    if (!confirmForm?.amount) return '—'
    try {
      return moneyFromString(confirmForm.amount)
    } catch {
      return confirmForm.amount
    }
  })()

  return (
    <>
      <div className="cb-kpis">
        <article className="main">
          <span>
            <Wallet />
          </span>
          <div>
            <small>Cash entry account</small>
            <b>{cashAccount.name}</b>
            <em>Posts a real Journal Voucher</em>
          </div>
        </article>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="cb-panels">
        {renderPanel('In')}
        {renderPanel('Out')}
      </div>
      {confirmKind && confirmForm && (
        <Modal
          title={`Confirm cash ${confirmKind === 'In' ? 'in' : 'out'}`}
          onClose={() => setConfirmKind(null)}
        >
          <p>
            Post {confirmKind === 'In' ? 'Dr' : 'Cr'} {cashAccount.name} /{' '}
            {confirmKind === 'In' ? 'Cr' : 'Dr'} {confirmAccount?.name ?? '—'} for{' '}
            <b>{confirmAmountDisplay}</b> on <b>{confirmForm.date}</b>? This posts a journal voucher
            — posted entries cannot be edited, only reversed.
          </p>
          <div className="modal-foot">
            <Button kind="secondary" onClick={() => setConfirmKind(null)}>
              Cancel
            </Button>
            <Button busy={submitting} onClick={() => doPost(confirmKind)}>
              Post entry
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * M2-S, unchanged — the real ledger of the resolved cash account.
 * ------------------------------------------------------------------ */

function CashLedger({
  account,
  usedInterimLookup,
  refreshToken = 0,
}: {
  account: AccountDto
  usedInterimLookup: boolean
  refreshToken?: number
}) {
  const [from] = useState(startOfMonthIso)
  const [to] = useState(todayIso)
  const [pages, setPages] = useState<LedgerResponse[]>([])
  const { state, reload } = useApiQuery(
    () => getLedger(account.id, { from, to }),
    [account.id, from, to, refreshToken],
  )

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
  const adapted = adaptLedgerPages(pages)
  const opening = formatRunningBalance(pages[0].openingBalance)
  const closing = formatRunningBalance(lastPage.closingBalance)

  return (
    <>
      {usedInterimLookup && (
        <Banner tone="warn">
          Resolved by code {CASH_CODE_INTERIM}, not by role — no account in this tenant's chart
          holds the {CASH_ROLE} role. If this tenant's chart ever diverges from the standard
          template, this page may be looking at the wrong account.
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

      {adapted.rows.length === 0 ? (
        <div className="empty-state">
          No cash movements between {from} and {to}.
        </div>
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
              {lastPage.lines.map((line) => {
                const running = formatRunningBalance(line.runningBalance)
                return (
                  <tr key={line.lineId}>
                    <td>{line.occurredAt}</td>
                    <td>{line.entryNumber}</td>
                    <td>{line.narration}</td>
                    <td className="num money-debit">
                      {moneyFromString(line.debit, { zeroAsDash: true })}
                    </td>
                    <td className="num money-credit">
                      {moneyFromString(line.credit, { zeroAsDash: true })}
                    </td>
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
