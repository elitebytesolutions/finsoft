'use client'
/*
 * /sales/voucher — M4-W2: service-mode sales invoice create/edit, real API
 * (docs/design/M3/ui-plan.md "sales-voucher — service line mode", PO-approved).
 *
 * The mock's product/batch/GST sale has no counterpart in the real invoice contract
 * (packages/shared-types/src/receivables.ts: a line is `{description, quantity, unitPrice}`
 * only — no product, pack, batch/expiry, bonus, disc%, GST%). Per the approved plan this
 * screen keeps the `.sav-*` page chrome and card layout but: the Item Entry grid becomes a
 * service-line grid (#, Description, Qty, Rate, Net amount); the "Fulfillment & Sales Team"
 * card is removed (booker/deliveryman/salesman/doctor/supervisor/saleType/place/area were all
 * fabricated — no schema field); the doc-number strip keeps only Invoice No and Invoice Date
 * (Sale No, PO No/Date, Bill Book No had no backend counterpart). Due date and Narration are
 * real fields the mock never had, added to the customer card.
 *
 * Totals are never computed in the browser: every net amount and the invoice total come from
 * I6 `POST /api/invoices/calculate` (debounced, re-run on every line edit) — the same domain
 * function posting runs — never from `qty * rate` in this file.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from '@/lib/router'
import {
  BookOpen,
  Calculator,
  CalendarDays,
  Check,
  FileText,
  Info,
  Plus,
  Save,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { Banner, Button, Field, Modal, TextInput, moneyFromString } from '@finsoft/ui'
import { useAuth } from '@/lib/api/auth-context'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import { ApiError } from '@/lib/api/types'
import { todayIso } from '@/lib/date/local-date'
import { getCustomer, listCustomers } from '@/lib/api/customers-client'
import type { CustomerListItem } from '@/lib/api/customers-client'
import {
  calculateInvoice,
  cancelInvoice,
  createInvoice,
  getInvoice,
  postInvoice,
  updateInvoice,
} from '@/lib/api/invoices-client'
import type { InvoiceCalculation, InvoiceStatus } from '@/lib/api/invoices-types'
import { receivablesErrorMessage } from '@/lib/adapters/receivables-errors'
import { searchTermFor } from '@/lib/adapters/party-search'

type Line = { key: number; description: string; quantity: string; unitPrice: string }

let lineKeySeq = 1
const newLine = (): Line => ({ key: lineKeySeq++, description: '', quantity: '', unitPrice: '' })

function isLineComplete(l: Line): boolean {
  return l.description.trim() !== '' && l.quantity.trim() !== '' && l.unitPrice.trim() !== ''
}

export function SalesVoucher() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [params] = useSearchParams()
  const editInvoiceId = params.get('invoice')
  const presetCustomerId = params.get('customer')

  const canCreate = can('invoice.create')
  const canPost = can('invoice.post')

  // ---- draft identity -------------------------------------------------
  const [invoiceId, setInvoiceId] = useState<string | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null)
  const [status, setStatus] = useState<InvoiceStatus | null>(null)

  // ---- form fields ------------------------------------------------------
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOptions, setCustomerOptions] = useState<CustomerListItem[]>([])
  const [invoiceDate, setInvoiceDate] = useState(todayIso())
  const [dueDate, setDueDate] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<Line[]>(() => [newLine()])

  // ---- loading / hydration ----------------------------------------------
  const [hydrating, setHydrating] = useState(Boolean(editInvoiceId))
  const [loadError, setLoadError] = useState<string | null>(null)
  const hydratedRef = useRef(false)

  // ---- calculation (I6) ---------------------------------------------------
  const [calc, setCalc] = useState<InvoiceCalculation | null>(null)
  const [calcPending, setCalcPending] = useState(false)

  // ---- submission state ----------------------------------------------------
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [savingDraft, setSavingDraft] = useState(false)
  const [postOpen, setPostOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const { key: createKey, reset: resetCreateKey } = useIdempotencyKey()
  const { key: postKey, reset: resetPostKey } = useIdempotencyKey()

  // Load an existing draft (?invoice=) or pre-select a customer (?customer=) — once.
  useEffect(() => {
    let active = true
    if (editInvoiceId) {
      getInvoice(editInvoiceId)
        .then((inv) => {
          if (!active || hydratedRef.current) return
          hydratedRef.current = true
          setInvoiceId(inv.id)
          setVersion(inv.version)
          setInvoiceNumber(inv.number)
          setStatus(inv.status)
          setCustomerId(inv.customer.id)
          setCustomerQuery(`${inv.customer.name} (${inv.customer.code})`)
          setInvoiceDate(inv.invoiceDate)
          setDueDate(inv.dueDate ?? '')
          setNarration(inv.narration ?? '')
          setLines(
            inv.lines.length
              ? inv.lines.map((l) => ({
                  key: lineKeySeq++,
                  description: l.description,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                }))
              : [newLine()],
          )
          setHydrating(false)
        })
        .catch((err: unknown) => {
          if (!active) return
          setLoadError(
            err instanceof ApiError && err.status === 403
              ? 'You do not have permission to view this invoice.'
              : receivablesErrorMessage(err),
          )
          setHydrating(false)
        })
    }
    return () => {
      active = false
    }
  }, [editInvoiceId])

  // Resolve a preset customer id (from a customer's "New Transaction" link) to a label — C3,
  // a direct lookup by id, not a search that might miss it past the first page.
  useEffect(() => {
    if (!presetCustomerId || editInvoiceId || customerId) return
    let active = true
    getCustomer(presetCustomerId)
      .then((found) => {
        if (!active) return
        setCustomerId(found.id)
        setCustomerQuery(`${found.name} (${found.code})`)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [presetCustomerId, editInvoiceId, customerId])

  // Debounced customer search (C1) — never an unbounded local list.
  useEffect(() => {
    const q = customerQuery.trim()
    if (!q) {
      setCustomerOptions([])
      return
    }
    // Already resolved to a selection matching this exact text — no need to re-search.
    if (customerId && q === customerQuery) {
      const current = customerOptions.find((c) => c.id === customerId)
      if (current && `${current.name} (${current.code})` === q) return
    }
    let active = true
    const t = setTimeout(() => {
      listCustomers({ q: searchTermFor(q), status: 'ACTIVE', limit: 8 })
        .then((page) => {
          if (!active) return
          setCustomerOptions([...page.items])
          // The text may already be a complete, exact match (typed fast, pasted, or filled by
          // a test/automation tool) that arrived before this search resolved — resolve it now
          // rather than silently leaving customerId unset.
          const exact = page.items.find((c) => `${c.name} (${c.code})` === q)
          if (exact) setCustomerId(exact.id)
        })
        .catch(() => {
          if (active) setCustomerOptions([])
        })
    }, 300)
    return () => {
      active = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerQuery])

  const onCustomerQueryChange = (v: string) => {
    setCustomerQuery(v)
    const match = customerOptions.find((c) => `${c.name} (${c.code})` === v)
    setCustomerId(match ? match.id : null)
  }

  // Debounced I6 recalculation — the one sanctioned source for a line's net amount and the
  // invoice total while the user types (rule 19: no money arithmetic in the browser).
  useEffect(() => {
    const complete = lines.filter(isLineComplete)
    if (complete.length === 0) {
      setCalc(null)
      return
    }
    let active = true
    setCalcPending(true)
    const t = setTimeout(() => {
      calculateInvoice(
        lines.map((l) => ({
          description: l.description,
          quantity: l.quantity || '0',
          unitPrice: l.unitPrice || '0',
        })),
      )
        .then((result) => {
          if (active) setCalc(result)
        })
        .catch(() => {
          if (active) setCalc(null)
        })
        .finally(() => {
          if (active) setCalcPending(false)
        })
    }, 400)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [lines])

  const patchLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addRow = () => setLines((ls) => [...ls, newLine()])
  const removeRow = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key))

  const isDraftEditable = status === null || status === 'DRAFT'
  const validLines = lines.filter(isLineComplete)

  async function ensureDraft(): Promise<{ id: string; version: number }> {
    const body = {
      customerId: customerId!,
      invoiceDate,
      dueDate: dueDate || null,
      narration: narration || null,
      lines: validLines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
    }
    if (!invoiceId) {
      const inv = await createInvoice(body, createKey)
      setInvoiceId(inv.id)
      setVersion(inv.version)
      setInvoiceNumber(inv.number)
      setStatus(inv.status)
      resetCreateKey()
      return { id: inv.id, version: inv.version }
    }
    const inv = await updateInvoice(invoiceId, { ...body, version: version! })
    setVersion(inv.version)
    return { id: invoiceId, version: inv.version }
  }

  const validate = (): string | null => {
    if (!customerId) return 'Select a customer.'
    if (validLines.length === 0)
      return 'Add at least one line with a description, quantity and rate.'
    return null
  }

  const saveDraft = async (e: FormEvent) => {
    e.preventDefault()
    if (savingDraft) return
    const problem = validate()
    if (problem) {
      setFormError(problem)
      return
    }
    setFormError(null)
    setSavingDraft(true)
    try {
      await ensureDraft()
      setToast(invoiceId ? 'Draft updated.' : 'Saved as draft.')
    } catch (err) {
      setFormError(receivablesErrorMessage(err))
    } finally {
      setSavingDraft(false)
    }
  }

  const openPost = () => {
    const problem = validate()
    if (problem) {
      setFormError(problem)
      return
    }
    setFormError(null)
    setPostOpen(true)
  }

  if (!canCreate) {
    return (
      <div className="state-page" role="alert">
        <h1>Access restricted</h1>
        <p>Your role does not have permission to create invoices.</p>
      </div>
    )
  }

  if (hydrating) {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <h1>Loading draft invoice…</h1>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="state-page" role="alert">
        <h1>We could not load this draft</h1>
        <p>{loadError}</p>
        <Button kind="secondary" onClick={() => navigate('/sales')}>
          Back to sales
        </Button>
      </div>
    )
  }

  return (
    <div className="sav-page">
      <header className="sav-head">
        <span className="sav-head-icon">
          <FileText />
        </span>
        <div>
          <h1>Sales Voucher</h1>
          <p>Create and record a service invoice with customer and line details.</p>
        </div>
        <div className="sav-head-btns">
          <button
            type="button"
            className="sav-btn"
            disabled={savingDraft || !isDraftEditable}
            onClick={saveDraft}
          >
            <Save /> Save Draft
          </button>
          <button
            type="button"
            className="sav-btn solid"
            disabled={!canPost || !isDraftEditable || savingDraft}
            onClick={openPost}
          >
            <Check /> Save &amp; Post
          </button>
          {invoiceId && isDraftEditable && (
            <button type="button" className="sav-btn danger" onClick={() => setCancelOpen(true)}>
              <X /> Cancel Draft
            </button>
          )}
        </div>
      </header>
      {toast && (
        <div className="sav-toast" role="status">
          <Check />
          {toast}
          <button aria-label="Dismiss" onClick={() => setToast('')}>
            <X />
          </button>
        </div>
      )}
      {formError && <Banner tone="danger">{formError}</Banner>}
      {!isDraftEditable && invoiceId && (
        <Banner tone="info">
          This invoice is {status?.toLowerCase()}. It can no longer be edited here.{' '}
          <button className="linkable" onClick={() => navigate(`/sales/${invoiceId}`)}>
            Open it
          </button>
        </Banner>
      )}

      <div className="sav-refs">
        <div className="sav-ref">
          <span>
            <FileText />
          </span>
          <div>
            <small>Invoice No</small>
            <b>{invoiceNumber ?? 'Not yet assigned'}</b>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <CalendarDays />
          </span>
          <div>
            <small>Invoice Date</small>
            <label className="sav-date">
              <input
                type="date"
                aria-label="Invoice date"
                value={invoiceDate}
                disabled={!isDraftEditable}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <CalendarDays />
          </span>
          <div>
            <small>Due Date</small>
            <label className="sav-date">
              <input
                type="date"
                aria-label="Due date"
                value={dueDate}
                disabled={!isDraftEditable}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <BookOpen />
          </span>
          <div>
            <small>Status</small>
            <b>{status ?? 'DRAFT (unsaved)'}</b>
          </div>
        </div>
      </div>

      <section className="sav-card">
        <div className="sav-card-head">
          <UserRound />
          <h2>Order &amp; Customer Information</h2>
          <span className="sav-hint">
            <Info /> Search by name or code.
          </span>
        </div>
        <div className="sav-form two">
          <label className="sav-field">
            <span>
              Customer / Party<i>*</i>
            </span>
            <span className="sav-input">
              <input
                aria-label="Customer"
                placeholder="Search customer by name or code…"
                value={customerQuery}
                disabled={!isDraftEditable}
                onChange={(e) => onCustomerQueryChange(e.target.value)}
                list="sav-customers"
              />
            </span>
            <datalist id="sav-customers">
              {customerOptions.map((c) => (
                <option key={c.id} value={`${c.name} (${c.code})`} />
              ))}
            </datalist>
          </label>
          <Field label="Narration" htmlFor="sav-narration">
            <TextInput
              id="sav-narration"
              value={narration}
              onChange={setNarration}
              disabled={!isDraftEditable}
              placeholder="Add narration (optional)"
            />
          </Field>
        </div>
      </section>

      <section className="sav-card sav-items">
        <div className="sav-card-head">
          <h2>Item Entry</h2>
          <p>
            Service lines — description, quantity and rate. The net amount is calculated by the
            server.
          </p>
        </div>
        <div className="sav-table-wrap">
          <table className="sav-table">
            <thead>
              <tr>
                <th>#</th>
                <th>
                  Description <i>*</i>
                </th>
                <th>Qty</th>
                <th>Rate</th>
                <th>Net Amount</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const calcLine = calc?.lines[i]
                const problem = calc?.problems.find((p) => p.lineNo === i + 1)
                return (
                  <tr key={l.key}>
                    <td className="sav-idx">{i + 1}</td>
                    <td>
                      <span className="sav-input">
                        <input
                          aria-label={`Description ${i + 1}`}
                          value={l.description}
                          disabled={!isDraftEditable}
                          onChange={(e) => patchLine(l.key, { description: e.target.value })}
                        />
                      </span>
                      {problem && (
                        <small className="sav-line-error">
                          Quantity and rate must be greater than zero.
                        </small>
                      )}
                    </td>
                    <td>
                      <input
                        aria-label={`Qty ${i + 1}`}
                        className="sav-num"
                        inputMode="decimal"
                        value={l.quantity}
                        disabled={!isDraftEditable}
                        onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Rate ${i + 1}`}
                        className="sav-num money"
                        inputMode="decimal"
                        value={l.unitPrice}
                        disabled={!isDraftEditable}
                        onChange={(e) => patchLine(l.key, { unitPrice: e.target.value })}
                      />
                    </td>
                    <td>
                      <output className="sav-num ro money">
                        {calcLine ? moneyFromString(calcLine.lineNet) : '—'}
                      </output>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sav-del"
                        aria-label={`Remove row ${i + 1}`}
                        disabled={!isDraftEditable}
                        onClick={() => removeRow(l.key)}
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
        <div className="sav-table-foot">
          <button
            type="button"
            className="sav-btn green"
            disabled={!isDraftEditable}
            onClick={addRow}
          >
            <Plus /> Add Row
          </button>
          <span className="sav-hint plain">
            <Info /> Net amount is calculated by the server as you type.
          </span>
        </div>
      </section>

      <footer className="sav-foot">
        <div>
          <span>
            <FileText />
          </span>
          <div>
            <small>Total Items</small>
            <b>{validLines.length}</b>
          </div>
        </div>
        <div className="net">
          <span>
            <Calculator />
          </span>
          <div>
            <small>Net Amount</small>
            <b>{calcPending ? 'Calculating…' : calc ? moneyFromString(calc.netAmount) : '—'}</b>
          </div>
        </div>
      </footer>

      {postOpen && calc && customerId && (
        <PostConfirmDialog
          customerLabel={customerQuery}
          netAmount={calc.netAmount}
          lineCount={validLines.length}
          onClose={() => setPostOpen(false)}
          onConfirm={async () => {
            setSavingDraft(true)
            try {
              const draft = await ensureDraft()
              const posted = await postInvoice(draft.id, { version: draft.version }, postKey)
              resetPostKey()
              setInvoiceNumber(posted.number)
              setStatus(posted.status)
              setPostOpen(false)
              navigate(`/sales/${posted.id}`)
            } catch (err) {
              setPostOpen(false)
              setFormError(receivablesErrorMessage(err))
            } finally {
              setSavingDraft(false)
            }
          }}
          busy={savingDraft}
        />
      )}
      {cancelOpen && invoiceId && version !== null && (
        <CancelDraftDialog
          invoiceId={invoiceId}
          version={version}
          onClose={() => setCancelOpen(false)}
          onDone={() => {
            setCancelOpen(false)
            navigate('/sales')
          }}
        />
      )}
    </div>
  )
}

function PostConfirmDialog({
  customerLabel,
  netAmount,
  lineCount,
  onClose,
  onConfirm,
  busy,
}: {
  customerLabel: string
  netAmount: string
  lineCount: number
  onClose: () => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <Modal title="Post invoice" onClose={onClose}>
      <p>
        This posts a {lineCount}-line invoice for <b>{customerLabel}</b>, net amount{' '}
        <b>{moneyFromString(netAmount)}</b>, to the ledger. Posted invoices are immutable — they can
        only be corrected by reversal.
      </p>
      <div className="modal-foot">
        <Button kind="secondary" onClick={onClose} type="button">
          Cancel
        </Button>
        <Button onClick={onConfirm} busy={busy}>
          Post invoice
        </Button>
      </div>
    </Modal>
  )
}

function CancelDraftDialog({
  invoiceId,
  version,
  onClose,
  onDone,
}: {
  invoiceId: string
  version: number
  onClose: () => void
  onDone: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await cancelInvoice(invoiceId, { version })
      onDone()
    } catch (err) {
      setError(receivablesErrorMessage(err))
      setSubmitting(false)
    }
  }
  return (
    <Modal title="Cancel draft" onClose={onClose}>
      <p>This cancels the draft. It will not appear on any ledger and cannot be recovered.</p>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="modal-foot">
        <Button kind="secondary" onClick={onClose} type="button">
          Keep draft
        </Button>
        <Button kind="danger" onClick={submit} busy={submitting}>
          Cancel draft
        </Button>
      </div>
    </Modal>
  )
}
