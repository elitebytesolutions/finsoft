'use client'
/*
 * /vouchers/:id (VoucherDetail) and /vouchers/new (VoucherForm) — the PO's original design
 * (8c5c283), restored around M2-S's real, tested posting logic, which is kept intact rather
 * than rewritten (M2-UI brief: "keep everything correct that M2-S added... behind the original
 * UI"). See the M2-UI report's DECISIONS for the two structural points that could not be a
 * literal restore:
 *
 *   - The mock's "Accounting entries" table paired one dr-account with one cr-account per row
 *     (`VoucherLine{debit,credit,amount}`). A real entry is N debit lines and M credit lines
 *     (`JournalLineDto[]`, `journal-voucher.md`) with no guaranteed pairing — the paired-column
 *     table cannot represent that without inventing pairings, so the restored table is one row
 *     per real line (# / Account / Memo / Debit / Credit), matching M2-S's structure, inside
 *     the original Panel/table chrome.
 *   - Branch, Department, Approver, Cost Centre, Attachments, Comments, "Save as template" and
 *     "Save Draft" have no backing field in `PostJournalRequest`/`JournalEntryDto` — M2 posts a
 *     single-step JV, no draft, no approval (journal-voucher.md §1). Every one of these stays on
 *     screen, visibly disabled/"coming soon" (never deleted, never sent to the server, never
 *     silently pretending to work).
 */
import { useMemo, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  Landmark,
  ListPlus,
  MoreHorizontal,
  Paperclip,
  Plus,
  ReceiptText,
  RotateCw,
  Save,
  Scale,
  Settings2,
  ShieldAlert,
  Trash2,
  UserRound,
  WalletCards,
} from 'lucide-react'
import {
  Badge,
  Banner,
  Button,
  Field,
  Modal,
  Panel,
  Table,
  TextInput,
  moneyFromString,
} from '@finsoft/ui'
import { useNavigate, useParams } from '@/lib/router'
import { getJournal, listAccounts, postJournal, reverseJournal } from '@/lib/api/accounting-client'
import { useAuth } from '@/lib/api/auth-context'
import { useApiQuery } from '@/lib/api/use-api-query'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import { postableJournalAccounts } from '@/lib/accounting/account-tree'
import { computeVoucherTotals } from '@/lib/accounting/voucher-totals'
import { adaptVoucherLines, adaptVoucherTotal } from '@/lib/adapters/vouchers'
import { todayIso } from '@/lib/date/local-date'
import { ApiError } from '@/lib/api/types'
import type {
  AccountDto,
  JournalEntryDetail,
  PostJournalLineInput,
} from '@/lib/api/accounting-types'

/* ------------------------------------------------------------------ *
 * Voucher detail — /vouchers/:id
 * ------------------------------------------------------------------ */

export function VoucherDetail() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { state, reload } = useApiQuery(() => getJournal(id!), [id])
  const { state: accountsState } = useApiQuery(
    () => listAccounts().then((r) => [...r.accounts]),
    [],
  )

  if (state.status === 'loading') {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <span>
          <RotateCw />
        </span>
        <h1>Loading voucher…</h1>
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
        <p>Your role does not have permission to view this voucher.</p>
      </div>
    )
  }
  if (state.status === 'error') {
    if (
      state.message.toLowerCase().includes('not found') ||
      state.message.toLowerCase().includes('entry_not_found')
    ) {
      return (
        <div className="state-page">
          <h1>Record not found</h1>
          <p>This document does not exist, or it belongs to another company.</p>
          <Button kind="secondary" onClick={() => navigate('/vouchers')}>
            <ArrowLeft /> Back to vouchers
          </Button>
        </div>
      )
    }
    return (
      <div className="state-page" role="alert">
        <span>
          <ShieldAlert />
        </span>
        <h1>We could not load this voucher</h1>
        <p>{state.message}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    )
  }

  return (
    <VoucherDetailReady
      entry={state.data}
      accounts={accountsState.status === 'ready' ? accountsState.data : []}
      onReversed={reload}
    />
  )
}

function VoucherDetailReady({
  entry,
  accounts,
  onReversed,
}: {
  entry: JournalEntryDetail
  accounts: AccountDto[]
  onReversed: () => void
}) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [reverseOpen, setReverseOpen] = useState(false)
  const isReversal = entry.reversalOf !== null
  // M4-W: `voucher.reverse` is a privileged permission (catalog.ts) — offered only to a
  // holder, same UI-affordance-only reasoning as PeriodTable's Close/Reopen. The route's
  // own 403 on POST /journals/:id/reverse is still the real gate.
  const canReverse = entry.status === 'POSTED' && !isReversal && can('voucher.reverse')
  const lines = adaptVoucherLines(entry.lines, accounts)
  const total = adaptVoucherTotal(entry)

  return (
    <>
      <div className="vou-breadcrumb">
        <button onClick={() => navigate('/vouchers')}>Voucher Register</button>
        <ChevronRight />
        <b>{entry.entryNumber}</b>
      </div>
      <div className="vd-head">
        <div className="vd-title">
          <div>
            <Badge tone="info">Journal Voucher</Badge>
            <Badge tone={entry.status === 'POSTED' ? 'good' : 'danger'}>
              {entry.status === 'POSTED' ? 'Posted' : 'Reversed'}
            </Badge>
          </div>
          <h1>{entry.entryNumber}</h1>
          <p>{entry.narration}</p>
        </div>
        <div className="vd-actions">
          {canReverse && (
            <Button kind="danger" onClick={() => setReverseOpen(true)}>
              Reverse
            </Button>
          )}
          <Button kind="secondary" onClick={() => navigate('/vouchers')}>
            <ArrowLeft /> Back
          </Button>
        </div>
      </div>

      {entry.status === 'REVERSED' && entry.reversedBy && (
        <Banner tone="danger">Reversed. See the reversing voucher for the full effect.</Banner>
      )}
      {isReversal && entry.reversalOf && (
        <Banner tone="info">This voucher reverses an earlier entry. {entry.reversalReason}</Banner>
      )}

      <div className="vd-grid">
        <section className="vd-main">
          <Panel title="Voucher header" sub="Posting information">
            <div className="vd-fields">
              <div>
                <small>Voucher no.</small>
                <b>{entry.entryNumber}</b>
              </div>
              <div>
                <small>Voucher type</small>
                <b>Journal Voucher</b>
              </div>
              <div>
                <small>Voucher date</small>
                <b>{entry.occurredAt}</b>
              </div>
              <div>
                <small>Reference</small>
                <b>{entry.reference || '—'}</b>
              </div>
              <div>
                <small>Branch</small>
                <b>—</b>
              </div>
              <div>
                <small>Department</small>
                <b>—</b>
              </div>
              <div>
                <small>Currency</small>
                <b>PKR — Pakistani Rupee</b>
              </div>
            </div>
          </Panel>
          <Panel title="Accounting entries" sub="Debit and credit lines · double-entry balanced">
            <div className="vou-entries">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Account</th>
                    <th>Memo</th>
                    <th className="num">Debit (PKR)</th>
                    <th className="num">Credit (PKR)</th>
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
                  <tr className="vou-total">
                    <td colSpan={3}>Total</td>
                    <td className="num">
                      <b>{total}</b>
                    </td>
                    <td className="num">
                      <b>{total}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Related documents" sub="Source and destination records">
            {entry.sourceType === 'journal_voucher' ? (
              <div className="empty-state">
                This is a manual journal voucher — it has no source document.
              </div>
            ) : (
              <Table
                headers={['Source type', 'Source id']}
                rows={[[entry.sourceType, entry.sourceId]]}
              />
            )}
          </Panel>
        </section>
        <aside className="vd-rail">
          <Panel title="Status & audit">
            <div className="vd-info">
              {/* Not a second "Posted"/"Reversed" Badge — the header above already carries that
               * exact one-word fact; repeating the identical badge text here would give an
               * automated check (and a screen-reader user) two indistinguishable
               * "Reversed" elements on one page for no added information. This row adds the
               * one thing the header doesn't: the entry number the status applies to. */}
              <p>
                <span>Entry</span>
                <b>
                  {entry.entryNumber} — {entry.status === 'POSTED' ? 'Posted' : 'Reversed'}
                </b>
              </p>
              <p>
                <span>Created by</span>
                <b>—</b>
              </p>
              <p>
                <span>Posted on</span>
                <b>{entry.occurredAt}</b>
              </p>
              <p>
                <span>Reversal reason</span>
                <b>{entry.reversalReason || '—'}</b>
              </p>
            </div>
          </Panel>
          <Panel
            title="Attachments"
            sub="Not available yet"
            action={
              <Button kind="ghost" disabled>
                <Paperclip size={14} /> Add
              </Button>
            }
          >
            <div className="empty-state">Attachments are not available yet.</div>
          </Panel>
          <Panel title="Comments" sub="Not available yet">
            <div className="vd-comment">
              <b>No comments yet</b>
              <p>Comments are not available yet.</p>
            </div>
          </Panel>
        </aside>
      </div>

      {reverseOpen && (
        <ReverseDialog
          entryId={entry.id}
          onClose={() => setReverseOpen(false)}
          onDone={() => {
            setReverseOpen(false)
            onReversed()
          }}
        />
      )}
    </>
  )
}

function ReverseDialog({
  entryId,
  onClose,
  onDone,
}: {
  entryId: string
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key } = useIdempotencyKey()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    if (!confirmed) {
      setError('Confirm that you understand this posts a new reversing entry.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await reverseJournal(entryId, { reason: reason.trim() }, key)
      onDone()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Could not reverse this voucher. Try again.'
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Reverse voucher" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>
          This posts a new reversing entry that exactly neutralises this voucher. Both entries
          remain in the ledger permanently. This cannot be undone.
        </p>
        <Field label="Reason" htmlFor="reverse-reason" required error={error ?? undefined}>
          <TextInput id="reverse-reason" value={reason} onChange={setReason} required />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I understand this cannot be undone.
        </label>
        <div className="modal-foot">
          <Button kind="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button kind="danger" type="submit" busy={submitting}>
            Reverse voucher
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * New voucher — /vouchers/new
 * ------------------------------------------------------------------ */

interface FormLine {
  accountId: string
  debit: string
  credit: string
  memo: string
}

const emptyLine = (): FormLine => ({ accountId: '', debit: '', credit: '', memo: '' })

const typeCards = [
  { type: 'JV', label: 'Journal', sub: 'General entry', icon: FileSpreadsheet },
  { type: 'CPV', label: 'Cash Payment', sub: 'Cash out', icon: WalletCards },
  { type: 'CRV', label: 'Cash Receipt', sub: 'Cash in', icon: Banknote },
  { type: 'BPV', label: 'Bank Payment', sub: 'From bank', icon: Landmark },
  { type: 'BRV', label: 'Bank Receipt', sub: 'To bank', icon: ReceiptText },
  { type: 'CV', label: 'More', sub: 'Other types', icon: MoreHorizontal },
] as const

export function VoucherForm() {
  const { state: accountsState, reload: reloadAccounts } = useApiQuery(
    () => listAccounts().then((r) => [...r.accounts]),
    [],
  )

  if (accountsState.status === 'loading') {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <span>
          <RotateCw />
        </span>
        <h1>Loading…</h1>
      </div>
    )
  }
  if (accountsState.status === 'forbidden') {
    return (
      <div className="state-page" role="alert">
        <span>
          <ShieldAlert />
        </span>
        <h1>Access restricted</h1>
        <p>Your role does not have permission to post a journal voucher.</p>
      </div>
    )
  }
  if (accountsState.status === 'error') {
    return (
      <div className="state-page" role="alert">
        <span>
          <ShieldAlert />
        </span>
        <h1>We could not load the account list</h1>
        <p>{accountsState.message}</p>
        <Button onClick={reloadAccounts}>Try again</Button>
      </div>
    )
  }

  return <VoucherFormReady accounts={postableJournalAccounts(accountsState.data)} />
}

function VoucherFormReady({ accounts }: { accounts: AccountDto[] }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [preset, setPreset] = useState<(typeof typeCards)[number]['type']>('JV')
  const [date, setDate] = useState(todayIso())
  const [reference, setReference] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<FormLine[]>([emptyLine(), emptyLine()])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // One key per form INSTANCE (useIdempotencyKey's own contract), not per attempt: opening the
  // confirm dialog and cancelling it, then clicking Post again, is still the same logical
  // submission — `reset()` below is called only after a successful post, never on cancel, so a
  // cancel-then-post reuses this exact key and the server's replay/idempotency guarantee
  // (journal-voucher.md §7) still covers a double-post from this one form.
  const { key, reset } = useIdempotencyKey()

  const totals = useMemo(
    () => computeVoucherTotals(lines.map((l) => ({ debit: l.debit, credit: l.credit }))),
    [lines],
  )
  const lineCount = useMemo(
    () => lines.filter((l) => l.accountId && (l.debit || l.credit)).length,
    [lines],
  )

  const setLine = (i: number, patch: Partial<FormLine>) =>
    setLines((list) => list.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((list) => [...list, emptyLine()])
  const addLines = (n: number) =>
    setLines((list) => [...list, ...Array.from({ length: n }, emptyLine)])
  const removeLine = (i: number) => setLines((list) => list.filter((_, j) => j !== i))
  const dupLine = (i: number) =>
    setLines((list) => [...list.slice(0, i + 1), { ...list[i] }, ...list.slice(i + 1)])

  // M4-W: `voucher.post` gates the button, same UI-affordance-only reasoning as
  // PeriodTable's Close/Reopen and VoucherDetailReady's Reverse — the server's own
  // @RequirePermission on POST /api/journals is the real gate regardless.
  const canSubmit =
    totals.balanced && narration.trim().length > 0 && !submitting && can('voucher.post')

  // Opens the confirm dialog — posting itself happens only from there, in doPost below.
  const requestSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setConfirmOpen(true)
  }

  const doPost = async () => {
    setSubmitting(true)
    setFormError(null)
    setFieldErrors({})

    const body = {
      occurredAt: date,
      narration: narration.trim(),
      reference: reference.trim() || undefined,
      lines: lines
        .filter((l) => l.accountId && (l.debit || l.credit))
        .map<PostJournalLineInput>((l) => ({
          accountId: l.accountId,
          ...(l.debit ? { debit: l.debit } : { credit: l.credit }),
          ...(l.memo ? { memo: l.memo } : {}),
        })),
    }

    try {
      const result = await postJournal(body, key)
      reset()
      navigate(`/vouchers/${result.id}`)
    } catch (err) {
      setConfirmOpen(false)
      if (err instanceof ApiError) {
        const code = err.serverCode
        if (code === 'jv_unbalanced') {
          setFormError(
            `Debits and credits differ. Server totals — debit ${err.serverDetails?.totalDebit}, credit ${err.serverDetails?.totalCredit}.`,
          )
        } else if (code === 'narration_required' || code === 'narration_too_long') {
          setFieldErrors({ narration: err.message })
        } else if (code === 'date_in_future') {
          setFieldErrors({ date: err.message })
        } else if (
          code === 'period_closed' ||
          code === 'period_locked' ||
          code === 'period_not_found'
        ) {
          setFormError(err.message)
        } else {
          setFormError(err.message)
        }
      } else {
        setFormError('Something went wrong. Try again.')
      }
      setSubmitting(false)
    }
  }

  return (
    <>
      <form className="vn-page" onSubmit={requestSubmit} noValidate>
        <div className="vn-head">
          <button
            type="button"
            className="vn-back"
            aria-label="Back to vouchers"
            onClick={() => navigate('/vouchers')}
          >
            <ArrowLeft />
          </button>
          <div className="vn-title">
            <h1>New Voucher</h1>
            <p>Enter a balanced voucher — every debit has a matching credit.</p>
          </div>
          {/* Only Journal is real — a manual JV is the only thing POST /api/journals accepts in
           * this release. The other five stay visible (never deleted) but disabled, not wired
           * to a preset, per the coordinator's review: cash/bank JV presets were separately
           * approved for the Cash Book screen (with a line preview, restricted picker and role-
           * based account resolution — see cashbook.tsx), not for this generic entries table,
           * which has no equivalent per-preset direction control to preview safely. */}
          <div className="vn-types">
            {typeCards.map((card) => {
              const Icon = card.icon
              const enabled = card.type === 'JV'
              return (
                <button
                  type="button"
                  key={card.type}
                  className={preset === card.type ? 'active' : ''}
                  disabled={!enabled}
                  title={
                    enabled
                      ? undefined
                      : 'Coming soon — every voucher posts as a Journal Voucher for now'
                  }
                  onClick={() => enabled && setPreset(card.type)}
                >
                  <Icon />
                  <b>{card.label}</b>
                  <small>{card.sub}</small>
                </button>
              )
            })}
          </div>
        </div>

        {formError && <Banner tone="danger">{formError}</Banner>}

        <section className="vn-card">
          <div className="vn-card-head">
            <span className="vn-ico">
              <FileText />
            </span>
            <div>
              <h2>Voucher Details</h2>
              <p>Basic information about this voucher</p>
            </div>
            <span className="vn-auto">
              Server assigns the number on post
              <Settings2 />
            </span>
          </div>
          <div className="vn-grid4">
            <label className="vn-fld">
              <span>
                Voucher date<em>*</em>
              </span>
              <span className="vn-in">
                <i>
                  <CalendarDays />
                </i>
                <input
                  id="jv-date"
                  type="date"
                  value={date}
                  max={todayIso()}
                  onChange={(e) => setDate(e.target.value)}
                  aria-invalid={!!fieldErrors.date}
                  aria-describedby={fieldErrors.date ? 'jv-date-error' : undefined}
                />
              </span>
              {fieldErrors.date && (
                <p className="field-message error" id="jv-date-error" role="alert">
                  {fieldErrors.date}
                </p>
              )}
            </label>
            <label className="vn-fld">
              <span>Reference</span>
              <span className="vn-in">
                <i>
                  <ReceiptText />
                </i>
                <input
                  id="jv-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Optional"
                />
              </span>
            </label>
            <label className="vn-fld">
              <span>Branch</span>
              <span className="vn-in sel">
                <i>
                  <Landmark />
                </i>
                <select disabled title="Coming soon">
                  <option>Not available yet</option>
                </select>
              </span>
            </label>
            <label className="vn-fld">
              <span>Department</span>
              <span className="vn-in sel">
                <i>
                  <UserRound />
                </i>
                <select disabled title="Coming soon">
                  <option>Not available yet</option>
                </select>
              </span>
            </label>
          </div>
          <Field label="Narration" htmlFor="jv-narration" required error={fieldErrors.narration}>
            <TextInput id="jv-narration" value={narration} onChange={setNarration} required />
          </Field>
        </section>

        <section className="vn-card">
          <div className="vn-card-head">
            <span className="vn-ico">
              <ListPlus />
            </span>
            <div>
              <h2>Voucher Entries</h2>
              <p>Add debit and credit lines. The voucher must be balanced.</p>
            </div>
            <div className="vn-entry-actions">
              <button type="button" className="vn-btn ghost" onClick={() => addLines(3)}>
                <Plus /> Add multiple lines
              </button>
              <button type="button" className="vn-btn solid" onClick={addLine}>
                <Plus /> Add line
              </button>
            </div>
          </div>
          <div className="vn-table-wrap">
            <table className="vn-table">
              <thead>
                <tr>
                  <th className="n">#</th>
                  <th>Account</th>
                  <th>Code</th>
                  <th>Memo</th>
                  <th className="num">Debit (PKR)</th>
                  <th className="num">Credit (PKR)</th>
                  <th>Cost Center</th>
                  <th className="act">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const account = accounts.find((a) => a.id === line.accountId)
                  return (
                    <tr key={i}>
                      <td className="n">{i + 1}</td>
                      <td>
                        <span className="vn-in sel sm">
                          <select
                            aria-label={`Account line ${i + 1}`}
                            value={line.accountId}
                            onChange={(e) => setLine(i, { accountId: e.target.value })}
                          >
                            <option value="">Select an account</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({a.code})
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="chev" />
                        </span>
                      </td>
                      <td>
                        <span className="vn-in sm">
                          <input readOnly value={account?.code ?? '—'} />
                        </span>
                      </td>
                      <td>
                        <span className="vn-in sm">
                          <input
                            aria-label={`Memo line ${i + 1}`}
                            value={line.memo}
                            onChange={(e) => setLine(i, { memo: e.target.value })}
                          />
                        </span>
                      </td>
                      <td>
                        <span className="vn-in sm num">
                          <input
                            aria-label={`Debit line ${i + 1}`}
                            inputMode="decimal"
                            value={line.debit}
                            onChange={(e) =>
                              setLine(i, {
                                debit: e.target.value,
                                credit: e.target.value ? '' : line.credit,
                              })
                            }
                          />
                        </span>
                      </td>
                      <td>
                        <span className="vn-in sm num">
                          <input
                            aria-label={`Credit line ${i + 1}`}
                            inputMode="decimal"
                            value={line.credit}
                            onChange={(e) =>
                              setLine(i, {
                                credit: e.target.value,
                                debit: e.target.value ? '' : line.debit,
                              })
                            }
                          />
                        </span>
                      </td>
                      <td>
                        <span className="vn-in sel sm">
                          <select disabled title="Coming soon">
                            <option>—</option>
                          </select>
                          <ChevronDown className="chev" />
                        </span>
                      </td>
                      <td className="act">
                        <button
                          type="button"
                          aria-label={`Duplicate line ${i + 1}`}
                          onClick={() => dupLine(i)}
                        >
                          <FileSpreadsheet />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove line ${i + 1}`}
                          disabled={lines.length <= 2}
                          onClick={() => removeLine(i)}
                        >
                          <Trash2 />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="vn-totals">
            <div>
              <small>Total Debit</small>
              <b>{moneyFromString(totals.totalDebit)}</b>
            </div>
            <div>
              <small>Total Credit</small>
              <b>{moneyFromString(totals.totalCredit)}</b>
            </div>
            <div className={`vn-bal ${totals.balanced ? 'ok' : 'pending'}`}>
              <span>{totals.balanced ? <Check /> : <Scale />}</span>
              <div>
                <b>{totals.balanced ? 'Balanced' : 'Unbalanced'}</b>
                <small>
                  {totals.balanced
                    ? 'Difference is zero'
                    : `Difference ${moneyFromString(totals.difference)}`}
                </small>
              </div>
            </div>
          </div>
        </section>

        <div className="vn-lower">
          <section className="vn-card">
            <div className="vn-card-head">
              <span className="vn-ico">
                <Paperclip />
              </span>
              <div>
                <h2>Attachments</h2>
              </div>
            </div>
            <label className="cb-drop" title="Coming soon">
              <CloudUpload />
              <b>Attachments are not available yet</b>
              <small>PDF, Excel, JPG — coming soon</small>
              <input type="file" multiple hidden disabled />
            </label>
          </section>
          <section className="vn-card">
            <div className="vn-card-head">
              <span className="vn-ico">
                <FileText />
              </span>
              <div>
                <h2>Additional Information</h2>
              </div>
            </div>
            <div className="vn-extra">
              <label className="vn-fld">
                <span>Tags</span>
                <span className="vn-in">
                  <input placeholder="Coming soon" disabled />
                </span>
              </label>
              <label className="vn-fld">
                <span>Comments</span>
                <span className="vn-in area plain">
                  <textarea rows={2} placeholder="Coming soon" disabled />
                </span>
              </label>
            </div>
          </section>
        </div>

        <div className="vn-actionbar">
          <label
            className="vn-switch"
            title="Coming soon — M2 posts a single-step voucher, no draft"
          >
            <input type="checkbox" disabled />
            <i />
            <span>
              <b>Save as template</b>
              <small>Coming soon</small>
            </span>
          </label>
          <div className="vn-actionbar-right">
            <button type="button" className="vn-btn text" onClick={() => navigate('/vouchers')}>
              Cancel
            </button>
            <button
              type="button"
              className="vn-btn ghost"
              disabled
              title="Coming soon — M2 has no draft state"
            >
              <Save />
              Save Draft
            </button>
            <Button type="submit" busy={submitting} disabled={!canSubmit}>
              Post voucher
            </Button>
          </div>
        </div>
      </form>
      {confirmOpen && (
        <PostConfirmDialog
          date={date}
          totals={totals}
          lineCount={lineCount}
          submitting={submitting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={doPost}
        />
      )}
    </>
  )
}

function PostConfirmDialog({
  date,
  totals,
  lineCount,
  submitting,
  onCancel,
  onConfirm,
}: {
  date: string
  totals: ReturnType<typeof computeVoucherTotals>
  lineCount: number
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal title="Post voucher" onClose={onCancel}>
      <p>
        Post {lineCount} line{lineCount === 1 ? '' : 's'} totalling{' '}
        <b>{moneyFromString(totals.totalDebit)}</b> to <b>{date}</b>? Posted entries cannot be
        edited — a mistake is corrected by reversal, never by editing.
      </p>
      <div className="totals-card">
        <div>
          <span>Voucher date</span>
          <b>{date}</b>
        </div>
        <div>
          <span>Lines</span>
          <b>{lineCount}</b>
        </div>
        <div>
          <span>Total debit</span>
          <b>{moneyFromString(totals.totalDebit)}</b>
        </div>
        <div>
          <span>Total credit</span>
          <b>{moneyFromString(totals.totalCredit)}</b>
        </div>
      </div>
      <div className="modal-foot">
        <Button kind="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" busy={submitting} onClick={onConfirm}>
          Post voucher
        </Button>
      </div>
    </Modal>
  )
}
