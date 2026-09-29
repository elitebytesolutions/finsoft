'use client'
/*
 * /vouchers/:id (VoucherDetail) and /vouchers/new (VoucherForm) — real API.
 * docs/design-system/pages/{voucher-detail,voucher-new}/README.md.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, ChevronRight, Plus, RotateCw, ShieldAlert, Trash2 } from 'lucide-react'
import {
  Badge,
  Banner,
  Button,
  Field,
  Modal,
  PageHead,
  TextInput,
  moneyFromString,
} from '@finsoft/ui'
import { useNavigate, useParams } from '@/lib/router'
import { getJournal, listAccounts, postJournal, reverseJournal } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import { postableJournalAccounts } from '@/lib/accounting/account-tree'
import { computeVoucherTotals } from '@/lib/accounting/voucher-totals'
import { ApiError } from '@/lib/api/types'
import type {
  AccountDto,
  JournalEntryDetail,
  PostJournalLineInput,
} from '@/lib/api/accounting-types'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

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
  const [reverseOpen, setReverseOpen] = useState(false)
  const nameOf = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId)
    return a ? `${a.name} (${a.code})` : accountId
  }
  const isReversal = entry.reversalOf !== null
  const canReverse = entry.status === 'POSTED' && !isReversal

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
          {entry.lines.map((line) => (
            <tr key={line.lineNumber}>
              <td>{line.lineNumber}</td>
              <td>{nameOf(line.accountId)}</td>
              <td>{line.memo ?? '—'}</td>
              <td className="num">{moneyFromString(line.debit, { zeroAsDash: true })}</td>
              <td className="num">{moneyFromString(line.credit, { zeroAsDash: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
  const removeLine = (i: number) => setLines((list) => list.filter((_, j) => j !== i))

  const canSubmit = totals.balanced && narration.trim().length > 0 && !submitting

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
        <PageHead
          eyebrow="Accounting / Vouchers"
          title="New Journal Voucher"
          description="Post a balanced journal entry."
        />

        {formError && <Banner tone="danger">{formError}</Banner>}

        <section className="vn-card">
          <div className="vn-grid4">
            <Field label="Voucher date" htmlFor="jv-date" required error={fieldErrors.date}>
              <input
                id="jv-date"
                type="date"
                value={date}
                max={todayIso()}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Reference" htmlFor="jv-reference" helper="Optional, up to 100 characters">
              <TextInput id="jv-reference" value={reference} onChange={setReference} />
            </Field>
          </div>
          <Field label="Narration" htmlFor="jv-narration" required error={fieldErrors.narration}>
            <TextInput id="jv-narration" value={narration} onChange={setNarration} required />
          </Field>
        </section>

        <section className="vn-card">
          <div className="vn-card-head">
            <h2>Voucher Entries</h2>
            <button type="button" className="vn-btn solid" onClick={addLine}>
              <Plus /> Add line
            </button>
          </div>
          <div className="vn-table-wrap">
            <table className="vn-table">
              <thead>
                <tr>
                  <th className="n">#</th>
                  <th>Account</th>
                  <th>Memo</th>
                  <th className="num">Debit (PKR)</th>
                  <th className="num">Credit (PKR)</th>
                  <th className="act">Remove</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className="n">{i + 1}</td>
                    <td>
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
                    </td>
                    <td>
                      <input
                        aria-label={`Memo line ${i + 1}`}
                        value={line.memo}
                        onChange={(e) => setLine(i, { memo: e.target.value })}
                      />
                    </td>
                    <td>
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
                    </td>
                    <td>
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
                    </td>
                    <td className="act">
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
                ))}
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
              <b>{totals.balanced ? 'Balanced' : 'Unbalanced'}</b>
              <small>
                {totals.balanced
                  ? 'Difference is zero'
                  : `Difference ${moneyFromString(totals.difference)}`}
              </small>
            </div>
          </div>
        </section>

        <div className="vn-actionbar">
          <div className="vn-actionbar-right">
            <button type="button" className="vn-btn text" onClick={() => navigate('/vouchers')}>
              Cancel
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
