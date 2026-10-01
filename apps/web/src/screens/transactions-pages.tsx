'use client'
/*
 * /payments — M4-W2: real customer receipts (R1–R8), replacing the mock's combined
 * Payment/Receipt voucher centre. docs/design/M3/ui-plan.md "payments-centre — receipt mode"
 * (PO-approved): the mode switch is removed (no payables/vendor-payment API exists yet — out
 * of this task's scope), there is no paid-to-account field (a receipt's `method` is CASH/BANK
 * only, no specific GL account id on the schema) and no withholding tax field (no counterpart
 * on CreateReceiptRequest). Allocation must leave exactly 0.0000 unallocated to post (R6's own
 * validation; this screen mirrors it for a fast rejection, never decides it).
 *
 * The "Reports & Filters" card's controls were already decorative in the mock (none of
 * cashTab/cashTypeFilter/cashDateFilter/cashNumberFilter ever filtered the table) — kept as
 * inert UI for visual parity rather than wired to a reporting endpoint that does not exist.
 * The KPI tiles' hardcoded cash-balance figures are replaced with "Not tracked yet" (same
 * pattern as parties.tsx's Credit Limit tile) since no cash/bank ledger-balance endpoint is in
 * this task's scope — CLAUDE.md forbids showing an invented number instead.
 *
 * Allocated/unallocated totals, suggested allocation and openInvoices come ONLY from R2
 * (POST /api/receipts/preview) — never summed from the rows in this file.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  BarChart3,
  Check,
  ChevronDown,
  FileText,
  Filter,
  Landmark,
  Search,
  Upload,
  WalletCards,
} from 'lucide-react'
import { Badge, Banner, Button, Modal, Table, moneyFromString } from '@finsoft/ui'
import { Money } from '@finsoft/validation'
import { useNavigate } from '@/lib/router'
import { useAuth } from '@/lib/api/auth-context'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import { todayIso } from '@/lib/date/local-date'
import { listCustomers } from '@/lib/api/customers-client'
import type { CustomerListItem } from '@/lib/api/customers-client'
import {
  cancelReceipt,
  createReceipt,
  listReceipts,
  postReceipt,
  previewReceipt,
  updateReceipt,
} from '@/lib/api/receipts-client'
import type { ReceiptListItem, ReceiptMethod, ReceiptPreview } from '@/lib/api/receipts-types'
import { receivablesErrorMessage } from '@/lib/adapters/receivables-errors'
import { searchTermFor } from '@/lib/adapters/party-search'

export function PaymentsCentre() {
  const { can } = useAuth()
  const canReceive = can('payment.receive')
  const [open, setOpen] = useState(false)
  const [cashTab, setCashTab] = useState<'Reports' | 'Transaction History'>('Reports')
  const [cashTypeFilter, setCashTypeFilter] = useState<
    'Payments' | 'Receipts' | 'All Transactions'
  >('Receipts')
  const [cashDateFilter, setCashDateFilter] = useState<'One (Date Wise)' | 'All (Date Wise)'>(
    'One (Date Wise)',
  )
  const [cashNumberFilter, setCashNumberFilter] = useState<
    'One (Number Wise)' | 'All (Number Wise)'
  >('One (Number Wise)')

  // ---- recent receipts (R1) ---------------------------------------------
  const [receipts, setReceipts] = useState<ReceiptListItem[]>([])
  const [receiptsCursor, setReceiptsCursor] = useState<string | null>(null)
  const [receiptsLoading, setReceiptsLoading] = useState(true)
  const [receiptsError, setReceiptsError] = useState<string | null>(null)
  const loadReceipts = (cursor?: string) => {
    setReceiptsLoading(true)
    setReceiptsError(null)
    listReceipts({ limit: 10, cursor })
      .then((page) => {
        setReceipts((prev) => (cursor ? [...prev, ...page.items] : [...page.items]))
        setReceiptsCursor(page.nextCursor)
      })
      .catch((err) => setReceiptsError(receivablesErrorMessage(err)))
      .finally(() => setReceiptsLoading(false))
  }
  useEffect(() => {
    loadReceipts()
  }, [])

  return (
    <>
      <span className="sr-only">Payments &amp; receipts</span>
      <div className="cash-page-head">
        <div className="cash-title">
          <span>
            <WalletCards />
          </span>
          <div>
            <h1>Receipts</h1>
            <p>Record a customer receipt and allocate it against open invoices.</p>
          </div>
        </div>
        <div className="cash-head-actions">
          <Button disabled={!canReceive} onClick={() => setOpen(true)}>
            <ArrowDown /> New Receipt
          </Button>
        </div>
      </div>
      <div className="cash-kpis">
        <article>
          <span>
            <Landmark />
          </span>
          <div>
            <small>Opening Balance</small>
            <b>—</b>
            <em>Not tracked yet</em>
          </div>
        </article>
        <article>
          <span>
            <ArrowDown />
          </span>
          <div>
            <small>Receipts Loaded</small>
            <b>{receipts.length}</b>
            <em>This page</em>
          </div>
        </article>
        <article>
          <span>
            <WalletCards />
          </span>
          <div>
            <small>Draft Receipts</small>
            <b>{receipts.filter((r) => r.status === 'DRAFT').length}</b>
            <em>This page</em>
          </div>
        </article>
        <article>
          <span>
            <WalletCards />
          </span>
          <div>
            <small>Closing Balance</small>
            <b>—</b>
            <em>Not tracked yet</em>
          </div>
        </article>
      </div>
      <div className="cash-main-grid">
        <section className="cash-create">
          <div className="cash-section-head">
            <h2>
              <FileText /> Create Transaction
            </h2>
            <span className="cash-inflow">
              <ArrowDown /> Cash Inflow
            </span>
          </div>
          <p>
            Use <b>New Receipt</b> above to record and allocate a customer receipt against open
            invoices.
          </p>
        </section>
        <section className="cash-reports">
          <div className="cash-section-head">
            <h2>
              <BarChart3 /> Reports &amp; Filters
            </h2>
            <p>View and print payment &amp; receipt reports</p>
          </div>
          <div className="cash-report-tabs">
            <button
              className={cashTab === 'Reports' ? 'active' : ''}
              onClick={() => setCashTab('Reports')}
            >
              Reports
            </button>
            <button
              className={cashTab === 'Transaction History' ? 'active' : ''}
              onClick={() => setCashTab('Transaction History')}
            >
              Transaction History
            </button>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>1</i> Transaction Type
            </h3>
            <div>
              <button
                className={cashTypeFilter === 'Payments' ? 'active' : ''}
                onClick={() => setCashTypeFilter('Payments')}
              >
                Payments
              </button>
              <button
                className={cashTypeFilter === 'Receipts' ? 'active' : ''}
                onClick={() => setCashTypeFilter('Receipts')}
              >
                Receipts
              </button>
              <button
                className={cashTypeFilter === 'All Transactions' ? 'active' : ''}
                onClick={() => setCashTypeFilter('All Transactions')}
              >
                All Transactions
              </button>
            </div>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>2</i> Date Filter
            </h3>
            <div>
              <button
                className={cashDateFilter === 'One (Date Wise)' ? 'active' : ''}
                onClick={() => setCashDateFilter('One (Date Wise)')}
              >
                One (Date Wise)
              </button>
              <button
                className={cashDateFilter === 'All (Date Wise)' ? 'active' : ''}
                onClick={() => setCashDateFilter('All (Date Wise)')}
              >
                All (Date Wise)
              </button>
            </div>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>3</i> Number Filter
            </h3>
            <div>
              <button
                className={cashNumberFilter === 'One (Number Wise)' ? 'active' : ''}
                onClick={() => setCashNumberFilter('One (Number Wise)')}
              >
                One (Number Wise)
              </button>
              <button
                className={cashNumberFilter === 'All (Number Wise)' ? 'active' : ''}
                onClick={() => setCashNumberFilter('All (Number Wise)')}
              >
                All (Number Wise)
              </button>
            </div>
          </div>
          <div className="cash-report-actions">
            <Button disabled>
              <BarChart3 /> Generate Report
            </Button>
            <button disabled>
              <Upload /> Export <ChevronDown />
            </button>
          </div>
        </section>
      </div>
      <section className="cash-recent">
        <div className="cash-recent-head">
          <div>
            <h2>
              <FileText /> Recent Receipts
            </h2>
            <p>Latest customer receipts</p>
          </div>
          <div>
            <label>
              <Search />
              <input placeholder="Search transactions..." disabled />
            </label>
            <button disabled>
              <Filter /> Filter
            </button>
          </div>
        </div>
        {receiptsError && (
          <Banner tone="danger">
            {receiptsError}{' '}
            <button className="linkable" onClick={() => loadReceipts()}>
              Try again
            </button>
          </Banner>
        )}
        {!receiptsError && receiptsLoading && receipts.length === 0 && (
          <div className="empty-state">Loading receipts…</div>
        )}
        {!receiptsError && !receiptsLoading && receipts.length === 0 && (
          <div className="empty-state">No receipts yet. Record one with New Receipt above.</div>
        )}
        {receipts.length > 0 && <ReceiptsTable receipts={receipts} />}
        {receiptsCursor && (
          <div className="cash-pagination">
            <button onClick={() => loadReceipts(receiptsCursor)} disabled={receiptsLoading}>
              {receiptsLoading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </section>
      {open && (
        <NewReceiptDialog
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false)
            loadReceipts()
          }}
        />
      )}
    </>
  )
}

function ReceiptsTable({ receipts }: { receipts: ReceiptListItem[] }) {
  const navigate = useNavigate()
  return (
    <Table
      headers={['#', 'Receipt No.', 'Date', 'Customer', 'Method', 'Amount', 'Status']}
      rows={receipts.map((r, i) => [
        String(i + 1),
        <button key="n" className="linkable" onClick={() => navigate(`/receipts/${r.id}`)}>
          {r.number ?? 'Draft'}
        </button>,
        r.receiptDate,
        `${r.customer.name} (${r.customer.code})`,
        r.method ?? '—',
        r.amount ? <b>{moneyFromString(r.amount)}</b> : '—',
        <Badge
          key="s"
          tone={r.status === 'POSTED' ? 'good' : r.status === 'REVERSED' ? 'danger' : 'neutral'}
        >
          {r.status}
        </Badge>,
      ])}
    />
  )
}

type AllocRow = { invoiceId: string; number: string; outstanding: string; amount: string }

/** "Name (CODE)", with "— Inactive" appended for an inactive customer — the receipt picker's
 * one sanctioned label, used both to render the datalist option and to resolve a typed/pasted
 * selection back to a customer id, so the two can never drift apart. */
function receiptCustomerLabel(c: CustomerListItem): string {
  return `${c.name} (${c.code})${c.status === 'INACTIVE' ? ' — Inactive' : ''}`
}

function NewReceiptDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOptions, setCustomerOptions] = useState<CustomerListItem[]>([])
  const [receiptDate, setReceiptDate] = useState(todayIso())
  const [method, setMethod] = useState<ReceiptMethod>('CASH')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [narration, setNarration] = useState('')
  const [rows, setRows] = useState<AllocRow[]>([])
  const [preview, setPreview] = useState<ReceiptPreview | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { key: createKey, reset: resetCreateKey } = useIdempotencyKey()
  const { key: postKey, reset: resetPostKey } = useIdempotencyKey()
  /*
   * R2's own rule (modules/receivables/application/preview-receipt.ts): it only computes the
   * oldest-first suggestion when `allocations` is OMITTED from the request entirely (null or
   * undefined) — an explicit `[]` (meaning "the caller has an allocation plan, and it is
   * empty") turns the suggestion off. Before the user has touched a row, send no `allocations`
   * key at all so the first preview can suggest one; once they have (an edit, or accepting the
   * suggestion), send their own rows from then on, even if they clear everything back to zero.
   */
  const [touched, setTouched] = useState(false)

  // Debounced customer search (C1).
  useEffect(() => {
    const q = customerQuery.trim()
    if (!q) {
      setCustomerOptions([])
      return
    }
    let active = true
    const t = setTimeout(() => {
      // Not filtered to ACTIVE (unlike the invoice picker on /sales/voucher, which creates new
      // billing against a customer and stays ACTIVE-only): a receipt SETTLES a debt, and an
      // inactive customer can still owe one. Ruling R-2 — excluding INACTIVE here would make an
      // inactive customer's balance uncollectable through this screen.
      listCustomers({ q: searchTermFor(q), limit: 8 })
        .then((page) => {
          if (!active) return
          setCustomerOptions([...page.items])
          // Same reasoning as sales-voucher.tsx: resolve an exact match that arrived after it
          // was typed, instead of silently leaving customerId unset. The label it matches
          // against is the plain "Name (CODE)" the datalist option's VALUE carries — the
          // "(Inactive)" suffix is display-only (label below), not part of that value.
          const exact = page.items.find((c) => receiptCustomerLabel(c) === q)
          if (exact) setCustomerId(exact.id)
        })
        .catch(() => active && setCustomerOptions([]))
    }, 300)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [customerQuery])

  const onCustomerQueryChange = (v: string) => {
    setCustomerQuery(v)
    const match = customerOptions.find((c) => receiptCustomerLabel(c) === v)
    setCustomerId(match ? match.id : null)
    setRows([])
    setPreview(null)
    setTouched(false)
  }

  // The request body's `allocations` — every row with a nonzero amount, invoiceId+amount only —
  // but ONLY once the user has touched a row; while untouched it is the constant `''`
  // regardless of how `rows` changes, so the effect's own response (which syncs `rows` to the
  // server's suggested amounts) can never retrigger it. Without that gate, the very first
  // suggestion sync would change this key once more (empty -> suggested), firing a second,
  // redundant request that converges back to the same key — not an infinite loop, but a visible
  // double round-trip that flickers the Post button's disabled state right as a user reaches
  // for it (Accounting review, 034b005). Used both as the effect's dependency (a primitive
  // string) and, via rowsRef below, as the value the effect sends — `rows` itself is NOT a
  // dependency (Accounting review, 66019c0).
  const activeAllocationsKey = touched
    ? JSON.stringify(
        rows
          .filter((r) => r.amount.trim() !== '' && r.amount.trim() !== '0')
          .map((r) => ({ invoiceId: r.invoiceId, amount: r.amount })),
      )
    : ''
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // R2 — debounced preview: the only sanctioned source of openInvoices, allocatedTotal,
  // unallocated and the oldest-first suggestion. Re-run on every customer/date/amount/row edit
  // (activeAllocationsKey changes whenever an edited row's amount does — fixes the totals and
  // the post-confirm figures going stale after an edit, Accounting review 66019c0).
  useEffect(() => {
    if (!customerId) {
      setPreview(null)
      return
    }
    let active = true
    setPreviewPending(true)
    const t = setTimeout(() => {
      previewReceipt({
        customerId,
        receiptId: receiptId ?? undefined,
        receiptDate,
        amount: amount || undefined,
        allocations: touched
          ? rowsRef.current
              .filter((r) => r.amount.trim() !== '' && r.amount.trim() !== '0')
              .map((r) => ({ invoiceId: r.invoiceId, amount: r.amount }))
          : undefined,
      })
        .then((p) => {
          if (!active) return
          setPreview(p)
          setRows((prev) => {
            const byId = new Map(prev.map((r) => [r.invoiceId, r]))
            return p.openInvoices.map((inv) => {
              const existing = byId.get(inv.invoiceId)
              const suggested = p.allocations.find((a) => a.invoiceId === inv.invoiceId)
              return {
                invoiceId: inv.invoiceId,
                number: inv.number,
                outstanding: inv.outstanding,
                amount: existing ? existing.amount : suggested ? suggested.amount : '',
              }
            })
          })
        })
        .catch(() => active && setPreview(null))
        .finally(() => active && setPreviewPending(false))
    }, 350)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [customerId, receiptDate, amount, activeAllocationsKey, receiptId, touched])

  const setRowAmount = (invoiceId: string, value: string) => {
    setTouched(true)
    setRows((rs) => rs.map((r) => (r.invoiceId === invoiceId ? { ...r, amount: value } : r)))
  }

  const applySuggested = () => {
    if (!preview) return
    setTouched(true)
    setRows((rs) =>
      rs.map((r) => {
        const s = preview.allocations.find((a) => a.invoiceId === r.invoiceId)
        return s ? { ...r, amount: s.amount } : r
      }),
    )
  }

  const activeAllocations = () =>
    rows
      .filter((r) => r.amount.trim() !== '' && r.amount.trim() !== '0')
      .map((r) => ({ invoiceId: r.invoiceId, amount: r.amount }))

  async function ensureDraft(): Promise<{ id: string; version: number }> {
    const body = {
      customerId: customerId!,
      receiptDate,
      method,
      amount: amount || null,
      reference: reference || null,
      narration: narration || null,
      allocations: activeAllocations(),
    }
    if (!receiptId) {
      const r = await createReceipt(body, createKey)
      setReceiptId(r.id)
      setVersion(r.version)
      resetCreateKey()
      return { id: r.id, version: r.version }
    }
    const r = await updateReceipt(receiptId, { ...body, version: version! })
    setVersion(r.version)
    return { id: receiptId, version: r.version }
  }

  const validate = (): string | null => {
    if (!customerId) return 'Select a customer.'
    if (!amount.trim()) return 'Enter the amount received.'
    if (activeAllocations().length === 0) return 'Allocate at least one invoice.'
    return null
  }

  const saveDraft = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await ensureDraft()
    } catch (err) {
      setError(receivablesErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const [confirmOpen, setConfirmOpen] = useState(false)
  const openConfirm = () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setConfirmOpen(true)
  }

  const post = async () => {
    setSubmitting(true)
    try {
      const draft = await ensureDraft()
      await postReceipt(draft.id, { version: draft.version }, postKey)
      resetPostKey()
      setConfirmOpen(false)
      onDone()
    } catch (err) {
      setConfirmOpen(false)
      setError(receivablesErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const cancelDraft = async () => {
    if (!receiptId || version === null) return
    setSubmitting(true)
    try {
      await cancelReceipt(receiptId, { version })
      onClose()
    } catch (err) {
      setError(receivablesErrorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <Modal title="New receipt — allocate against open invoices" onClose={onClose} wide>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="form-grid">
        <label>
          Customer
          <input
            aria-label="Customer"
            placeholder="Search customer by name or code…"
            value={customerQuery}
            onChange={(e) => onCustomerQueryChange(e.target.value)}
            list="receipt-customers"
          />
          <datalist id="receipt-customers">
            {customerOptions.map((c) => (
              <option key={c.id} value={receiptCustomerLabel(c)} />
            ))}
          </datalist>
        </label>
        <label>
          Receipt date
          <input
            type="date"
            aria-label="Receipt date"
            value={receiptDate}
            onChange={(e) => setReceiptDate(e.target.value)}
          />
        </label>
        <label>
          Method
          <select
            aria-label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value as ReceiptMethod)}
          >
            <option value="CASH">Cash</option>
            <option value="BANK">Bank</option>
          </select>
        </label>
        <label>
          Amount received
          <input
            aria-label="Amount"
            inputMode="decimal"
            placeholder="0.0000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Reference
          <input
            aria-label="Reference"
            placeholder="Cheque / transfer reference (optional)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label>
          Narration
          <input
            aria-label="Narration"
            placeholder="Add narration (optional)"
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
          />
        </label>
      </div>
      {customerId && (
        <>
          <div className="cash-section-head">
            <h2>Allocate against open invoices</h2>
            <button type="button" className="linkable" onClick={applySuggested} disabled={!preview}>
              Use suggested allocation (oldest first)
            </button>
          </div>
          {preview && preview.openInvoices.length === 0 && (
            <div className="empty-state">This customer has no open invoices.</div>
          )}
          {rows.length > 0 && (
            <Table
              headers={['Invoice', 'Outstanding', 'Allocate']}
              rows={rows.map((r) => [
                <b key="n">{r.number}</b>,
                moneyFromString(r.outstanding),
                <input
                  key="a"
                  aria-label={`Allocate ${r.number}`}
                  style={{ width: 110 }}
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => setRowAmount(r.invoiceId, e.target.value)}
                />,
              ])}
            />
          )}
          <div className="summary-strip">
            <span>
              Allocated
              <b>
                {preview ? moneyFromString(preview.allocatedTotal) : previewPending ? '…' : '—'}
              </b>
            </span>
            <span>
              Unallocated
              <b>{preview ? moneyFromString(preview.unallocated) : previewPending ? '…' : '—'}</b>
            </span>
          </div>
          {preview && preview.problems.length > 0 && (
            <Banner tone="warn">{preview.problems.map((p) => p.code).join(', ')}</Banner>
          )}
        </>
      )}
      <div className="modal-foot">
        <Button kind="secondary" onClick={onClose} type="button">
          Close
        </Button>
        {receiptId && (
          <Button kind="secondary" onClick={cancelDraft} busy={submitting} type="button">
            Cancel draft
          </Button>
        )}
        <Button kind="secondary" onClick={saveDraft} busy={submitting} type="button">
          <FileText /> Save draft
        </Button>
        <Button onClick={openConfirm} busy={submitting} disabled={previewPending} type="button">
          <Check /> Post receipt
        </Button>
      </div>
      {confirmOpen && preview && (
        <Modal title="Post receipt" onClose={() => setConfirmOpen(false)}>
          <p>
            This posts a receipt of <b>{moneyFromString(amount || '0')}</b> for this customer,
            allocating <b>{moneyFromString(preview.allocatedTotal)}</b> against{' '}
            {activeAllocations().length} invoice(s)
            {!Money.isZero(Money.from(preview.unallocated)) && (
              <>
                {' '}
                — <b>{moneyFromString(preview.unallocated)}</b> will remain unallocated, which the
                server will refuse
              </>
            )}
            . Posted receipts are immutable — they can only be corrected by reversal.
          </p>
          <div className="modal-foot">
            <Button kind="secondary" onClick={() => setConfirmOpen(false)} type="button">
              Back
            </Button>
            <Button onClick={post} busy={submitting}>
              Post receipt
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}
