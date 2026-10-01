'use client'
/*
 * /sales/voucher — PO decision 2026-10-01: two modes behind a Service/Product switch.
 *
 * Service mode (M4-W2, default) — real API (docs/design/M3/ui-plan.md "sales-voucher —
 * service line mode", PO-approved). The mock's product/batch/GST sale has no counterpart in
 * the real invoice contract (packages/shared-types/src/receivables.ts: a line is
 * `{description, quantity, unitPrice}` only). This screen keeps the `.sav-*` page chrome and
 * card layout but: the Item Entry grid becomes a service-line grid (#, Description, Qty, Rate,
 * Net amount); the "Fulfillment & Sales Team" card is removed (no schema field); the doc-number
 * strip keeps only Invoice No and Invoice Date. Due date and Narration are real fields the mock
 * never had. Totals are never computed in the browser: every net amount and the invoice total
 * come from I6 `POST /api/invoices/calculate` (debounced, re-run on every line edit) — never
 * `qty * rate` in this file.
 *
 * Product mode — the PO's original product/batch/GST sale form, restored verbatim from
 * before this change (`git show 65efbba:apps/web/src/screens/sales-voucher.tsx`, = the file at
 * origin/develop 4e90864) as ProductSalesVoucher below: every field, panel, button and
 * calculation display, unchanged. It stays a prototype — the "Prototype — not connected to the
 * ledger" banner shows only while this mode is active (the route is API-backed now, so the
 * shell's own automatic banner, which keys off API_BACKED_ROUTES, no longer fires for it) —
 * and it never posts or calls the API: Save Draft and Save & Post are permanently disabled,
 * labelled "Coming with inventory and tax (Waves 5–9)". `onAdd` (the mock mutator the original
 * component took as a prop) is gone along with the create path that called it; everything else
 * about this component's body is untouched.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from '@/lib/router'
import {
  BookOpen,
  Calculator,
  CalendarDays,
  Check,
  ChevronDown,
  Coins,
  Ellipsis,
  FileText,
  Info,
  MapPin,
  Package,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Tag,
  Trash2,
  Truck,
  UserRound,
  Wallet,
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
import { useFinsoft } from '@/app-context'
import type { Master, Product } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Line = { key: number; description: string; quantity: string; unitPrice: string }

let lineKeySeq = 1
const newLine = (): Line => ({ key: lineKeySeq++, description: '', quantity: '', unitPrice: '' })

function isLineComplete(l: Line): boolean {
  return l.description.trim() !== '' && l.quantity.trim() !== '' && l.unitPrice.trim() !== ''
}

/*
 * The mode switch itself — the one genuinely new piece of markup this file adds. `.mode-picker`
 * is the existing kit class the mock's own Payment/Receipt switch used (transactions-pages.tsx,
 * before M4-W2) — reused rather than invented.
 */
export function SalesVoucher() {
  const [mode, setMode] = useState<'Service' | 'Product'>('Service')
  const { data } = useFinsoft()
  return (
    <>
      <div className="mode-picker">
        <button
          type="button"
          className={mode === 'Service' ? 'active' : ''}
          onClick={() => setMode('Service')}
        >
          Service
        </button>
        <button
          type="button"
          className={mode === 'Product' ? 'active' : ''}
          onClick={() => setMode('Product')}
        >
          Product
        </button>
      </div>
      {mode === 'Product' && <Banner tone="warn">Prototype — not connected to the ledger</Banner>}
      {mode === 'Service' ? <ServiceSalesVoucher /> : <ProductSalesVoucher data={data} />}
    </>
  )
}

function ServiceSalesVoucher() {
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

/* ------------------------------------------------------------------ *
 * Product mode — restored verbatim from before M4-W2 (git show
 * 65efbba:apps/web/src/screens/sales-voucher.tsx, identical to origin/develop 4e90864).
 * A prototype: never posts, never calls the API. Renamed only where the original name would
 * collide with Service mode above (Line -> ProductLine, Field -> ProductField, Pick ->
 * ProductPick) — everything else, including every class name, field, column and calculation,
 * is unchanged.
 * ------------------------------------------------------------------ */

type ProductLine = {
  key: number
  product?: Product
  name: string
  pack: string
  batch: string
  qty: number
  bonus: number
  rate: number
  disc: number
  gst: number
}
const productFmt = (v: number) =>
  v.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const productPacks = ["10's", "20's", "30's", "100's", 'Bottle', 'Box']
const productGross = (l: ProductLine) => l.qty * l.rate
const productNet = (l: ProductLine) => productGross(l) * (1 - l.disc / 100) * (1 + l.gst / 100)
const productNetRate = (l: ProductLine) => (l.qty ? productNet(l) / l.qty : 0)
const productSeed = (products: Product[]): ProductLine[] =>
  [
    [10, 2, 12, 5],
    [5, 1, 28, 0],
    [20, 0, 8.5, 10],
    [10, 1, 22, 5],
    [15, 2, 15, 0],
  ].map(([qty, bonus, rate, disc], i) => {
    const p = products[i % products.length]
    return {
      key: i + 1,
      product: p,
      name: p.name,
      pack: "10's",
      batch: p.batches[0]?.id ?? p.batch,
      qty,
      bonus,
      rate,
      disc,
      gst: 7,
    }
  })

function ProductField({
  label,
  children,
  required,
}: {
  label: string
  children: ReactNode
  required?: boolean
}) {
  return (
    <label className="sav-field">
      <span>
        {label}
        {required && <i>*</i>}
      </span>
      {children}
    </label>
  )
}
function ProductPick({
  value,
  onChange,
  options,
  aria,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  aria?: string
}) {
  return (
    <span className="sav-input">
      <select aria-label={aria} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <ChevronDown />
    </span>
  )
}

function ProductSalesVoucher({ data }: { data: AppData }) {
  const navigate = useNavigate()
  const customers = data.masters.filter((m: Master) => m.type === 'Customer')
  const [customer, setCustomer] = useState(customers[0]?.name ?? '')
  const cust = customers.find((c) => c.name === customer)
  const [area, setArea] = useState(cust?.extra?.area ?? 'Gulberg'),
    [city, setCity] = useState(cust?.city ?? 'Lahore')
  const pickCustomer = (n: string) => {
    setCustomer(n)
    const c = customers.find((x) => x.name === n)
    if (c) {
      setArea(c.extra?.area ?? area)
      setCity(c.city || city)
    }
  }
  const [saleDate, setSaleDate] = useState('2026-09-13'),
    [po, setPo] = useState('PO-78956'),
    [poDate, setPoDate] = useState('2026-09-12')
  const [booker, setBooker] = useState('Ahmed Khan'),
    [delivery, setDelivery] = useState('Rafiq Shah'),
    [salesman, setSalesman] = useState('Tanvir Hasan'),
    [doctor, setDoctor] = useState('Dr. Rashid Ahmed'),
    [supervisor, setSupervisor] = useState('Salma Akter'),
    [saleType, setSaleType] = useState('Regular'),
    [place, setPlace] = useState('Main Warehouse'),
    [remarks, setRemarks] = useState('Urgent delivery requested.')
  const [lines, setLines] = useState<ProductLine[]>(() => productSeed(data.products)),
    [query, setQuery] = useState(''),
    [toast, setToast] = useState('')
  const saleNo = `SV-2026-${String(123 + data.sales.length).padStart(6, '0')}`,
    invNo = `INV-${String(8912 + data.sales.length).padStart(6, '0')}`
  const totals = useMemo(() => {
    const g = lines.reduce((a, l) => a + productGross(l), 0)
    const d = lines.reduce((a, l) => a + (productGross(l) * l.disc) / 100, 0)
    const t = lines.reduce((a, l) => a + (productGross(l) * (1 - l.disc / 100) * l.gst) / 100, 0)
    return {
      items: lines.length,
      qty: lines.reduce((a, l) => a + l.qty + l.bonus, 0),
      gross: g,
      disc: d,
      gst: t,
      net: g - d + t,
    }
  }, [lines])
  const patch = (k: number, p: Partial<ProductLine>) =>
    setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)))
  const setProduct = (k: number, name: string) => {
    const p = data.products.find((x) => x.name === name)
    patch(k, { name, product: p, batch: p?.batches[0]?.id ?? p?.batch ?? '', rate: p?.price ?? 0 })
  }
  const addRow = (name = '') => {
    const p = name ? data.products.find((x) => x.name === name) : undefined
    setLines((ls) => [
      ...ls,
      {
        key: Date.now(),
        product: p,
        name: p?.name ?? '',
        pack: "10's",
        batch: p?.batches[0]?.id ?? '',
        qty: 1,
        bonus: 0,
        rate: p?.price ?? 0,
        disc: 0,
        gst: 7,
      },
    ])
    setQuery('')
  }
  const findProduct = () => {
    const q = query.trim().toLowerCase()
    if (!q) return
    const p = data.products.find(
      (x) =>
        x.name.toLowerCase().includes(q) ||
        x.id.toLowerCase().includes(q) ||
        x.generic.toLowerCase().includes(q),
    )
    if (p) addRow(p.name)
    else setToast(`No product matches "${query}"`)
  }
  const num = (l: ProductLine, k: 'qty' | 'bonus' | 'rate' | 'disc', cls = '') => (
    <input
      aria-label={`${k} ${l.name || l.key}`}
      className={`sav-num ${cls}`}
      type="number"
      min={0}
      step={k === 'rate' ? '0.01' : '1'}
      value={l[k]}
      onChange={(e) => patch(l.key, { [k]: Number(e.target.value) } as Partial<ProductLine>)}
    />
  )

  return (
    <div className="sav-page">
      <header className="sav-head">
        <span className="sav-head-icon">
          <FileText />
        </span>
        <div>
          <h1>Sales Voucher</h1>
          <p>Create and record a sales invoice with customer, order and item details.</p>
        </div>
        <div className="sav-head-btns">
          <button
            type="button"
            className="sav-btn"
            disabled
            title="Coming with inventory and tax (Waves 5–9)"
          >
            <Save /> Save Draft
          </button>
          <button
            type="button"
            className="sav-btn solid"
            disabled
            title="Coming with inventory and tax (Waves 5–9)"
          >
            <Check /> Save &amp; Post
          </button>
          <button type="button" className="sav-btn" onClick={() => window.print()}>
            <Printer /> Print
          </button>
          <button type="button" className="sav-btn">
            <FileText /> Estimate
          </button>
          <button type="button" className="sav-btn">
            <Ellipsis /> More <ChevronDown />
          </button>
        </div>
      </header>
      <p className="sav-hint plain">
        <Info /> Save Draft and Save &amp; Post are coming with inventory and tax (Waves 5–9).
      </p>
      {toast && (
        <div className="sav-toast" role="status">
          <Check />
          {toast}
          <button aria-label="Dismiss" onClick={() => setToast('')}>
            <X />
          </button>
        </div>
      )}

      <div className="sav-refs">
        <div className="sav-ref">
          <span>
            <FileText />
          </span>
          <div>
            <small>Sale No</small>
            <b>{saleNo}</b>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <CalendarDays />
          </span>
          <div>
            <small>Sale Date</small>
            <label className="sav-date">
              <input
                type="date"
                aria-label="Sale date"
                value={saleDate}
                onChange={(e) => setSaleDate(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <FileText />
          </span>
          <div>
            <small>Purchase Order No</small>
            <input
              className="sav-plain"
              aria-label="Purchase order no"
              value={po}
              onChange={(e) => setPo(e.target.value)}
            />
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <CalendarDays />
          </span>
          <div>
            <small>Purchase Order Date</small>
            <label className="sav-date">
              <input
                type="date"
                aria-label="Purchase order date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <FileText />
          </span>
          <div>
            <small>Invoice No</small>
            <b>{invNo}</b>
          </div>
        </div>
        <div className="sav-ref">
          <span>
            <BookOpen />
          </span>
          <div>
            <small>Bill Book No</small>
            <b>BB-01</b>
          </div>
        </div>
      </div>

      <div className="sav-grid">
        <section className="sav-card">
          <div className="sav-card-head">
            <UserRound />
            <h2>Order &amp; Customer Information</h2>
            <span className="sav-hint">
              <Info /> Select a customer to auto-fill customer details.
            </span>
          </div>
          <div className="sav-form two">
            <ProductField label="Customer / Party" required>
              <ProductPick
                aria="Customer"
                value={customer}
                onChange={pickCustomer}
                options={customers.map((c) => c.name)}
              />
            </ProductField>
            <ProductField label="Customer Name">
              <span className="sav-input ro">
                <input readOnly value={customer} />
              </span>
            </ProductField>
            <div className="sav-address span-2">
              <MapPin />
              <b>Address:</b>
              <span>
                {cust
                  ? `${cust.extra?.area ?? ''}${cust.extra?.area ? ', ' : ''}${cust.city}`
                  : '—'}
                <br />
                {cust?.contact}
              </span>
            </div>
            <ProductField label="Area">
              <ProductPick
                aria="Area"
                value={area}
                onChange={setArea}
                options={[...new Set([area, 'Gulberg', 'Johar Town', 'Shadman', 'Clifton', 'DHA'])]}
              />
            </ProductField>
            <ProductField label="City">
              <ProductPick
                aria="City"
                value={city}
                onChange={setCity}
                options={[...new Set([city, 'Lahore', 'Karachi', 'Islamabad', 'Rawalpindi'])]}
              />
            </ProductField>
          </div>
        </section>
        <section className="sav-card">
          <div className="sav-card-head">
            <Truck />
            <h2>Fulfillment &amp; Sales Team</h2>
          </div>
          <div className="sav-form three">
            <ProductField label="Booker Name">
              <ProductPick
                aria="Booker"
                value={booker}
                onChange={setBooker}
                options={['Ahmed Khan', 'Bilal Saeed', 'Kashif Ali']}
              />
            </ProductField>
            <ProductField label="Deliveryman">
              <ProductPick
                aria="Deliveryman"
                value={delivery}
                onChange={setDelivery}
                options={['Rafiq Shah', 'Naeem Butt', 'Arif Khan']}
              />
            </ProductField>
            <ProductField label="Salesman">
              <ProductPick
                aria="Salesman"
                value={salesman}
                onChange={setSalesman}
                options={['Tanvir Hasan', 'Usman Ali', 'Hamza Tariq']}
              />
            </ProductField>
            <ProductField label="Doctor">
              <ProductPick
                aria="Doctor"
                value={doctor}
                onChange={setDoctor}
                options={['Dr. Rashid Ahmed', 'Dr. Sana Iqbal', 'None']}
              />
            </ProductField>
            <ProductField label="Supervisor">
              <ProductPick
                aria="Supervisor"
                value={supervisor}
                onChange={setSupervisor}
                options={['Salma Akter', 'Fahad Mir']}
              />
            </ProductField>
            <ProductField label="Sale Type">
              <ProductPick
                aria="Sale type"
                value={saleType}
                onChange={setSaleType}
                options={['Regular', 'Retail', 'Wholesale', 'Hospital', 'Clinic']}
              />
            </ProductField>
            <ProductField label="Place / Warehouse">
              <ProductPick
                aria="Warehouse"
                value={place}
                onChange={setPlace}
                options={['Main Warehouse', 'Shop DHA', 'Shop Johar Town']}
              />
            </ProductField>
            <label className="sav-field span-2">
              <span>Remarks</span>
              <span className="sav-input">
                <input
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Add remarks (optional)"
                />
              </span>
            </label>
          </div>
        </section>
      </div>

      <section className="sav-card sav-items">
        <div className="sav-card-head">
          <span className="sav-ico">
            <Package />
          </span>
          <h2>Item Entry</h2>
          <p>Select a product to auto-fill pack, batch, rate and tax details.</p>
          <div className="sav-tools">
            <label className="sav-search">
              <Search />
              <input
                aria-label="Search product"
                placeholder="Search product by name, code or generic..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && findProduct()}
                list="sav-products"
              />
            </label>
            <datalist id="sav-products">
              {data.products.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
            <button type="button" className="sav-btn solid" onClick={findProduct}>
              <Search /> Find Product
            </button>
            <button type="button" className="sav-btn green" onClick={() => addRow()}>
              <Plus /> Add Product
            </button>
            <button type="button" className="sav-btn green">
              <RefreshCw /> Product Change
            </button>
            <button type="button" className="sav-btn green" onClick={() => navigate('/products')}>
              <Plus /> New Product
            </button>
          </div>
        </div>
        <div className="sav-table-wrap">
          <table className="sav-table">
            <thead>
              <tr>
                <th>#</th>
                <th>
                  Product Name <i>*</i>
                </th>
                <th>Pack</th>
                <th>Batch / Expiry</th>
                <th>Qty</th>
                <th>Bonus</th>
                <th>Sale Rate</th>
                <th>Gross Amount</th>
                <th>Disc %</th>
                <th>GST %</th>
                <th>Net Rate</th>
                <th>Net Amount</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="sav-idx">{i + 1}</td>
                  <td>
                    <span className="sav-input">
                      <select
                        aria-label={`Product ${i + 1}`}
                        value={l.name}
                        onChange={(e) => setProduct(l.key, e.target.value)}
                      >
                        <option value="">Select product</option>
                        {data.products.map((p) => (
                          <option key={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <ChevronDown />
                    </span>
                  </td>
                  <td>
                    <ProductPick
                      aria={`Pack ${i + 1}`}
                      value={l.pack}
                      onChange={(v) => patch(l.key, { pack: v })}
                      options={productPacks}
                    />
                  </td>
                  <td>
                    <span className="sav-input">
                      <select
                        aria-label={`Batch ${i + 1}`}
                        value={l.batch}
                        onChange={(e) => patch(l.key, { batch: e.target.value })}
                      >
                        {(l.product?.batches ?? []).map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.id} | {b.expiry.slice(5, 7)}/{b.expiry.slice(0, 4)}
                          </option>
                        ))}
                        {!l.product && <option value="">—</option>}
                      </select>
                      <ChevronDown />
                    </span>
                  </td>
                  <td>{num(l, 'qty')}</td>
                  <td>{num(l, 'bonus')}</td>
                  <td>{num(l, 'rate', 'money')}</td>
                  <td>
                    <output className="sav-num ro">{productFmt(productGross(l))}</output>
                  </td>
                  <td>{num(l, 'disc')}</td>
                  <td>
                    <span className="sav-input sm">
                      <select
                        aria-label={`GST ${i + 1}`}
                        value={l.gst}
                        onChange={(e) => patch(l.key, { gst: Number(e.target.value) })}
                      >
                        {[0, 5, 7, 17, 18].map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                      <ChevronDown />
                    </span>
                  </td>
                  <td className="sav-money">{productFmt(productNetRate(l))}</td>
                  <td>
                    <output className="sav-num ro money">{productFmt(productNet(l))}</output>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="sav-del"
                      aria-label={`Remove row ${i + 1}`}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sav-table-foot">
          <button type="button" className="sav-btn green" onClick={() => addRow()}>
            <Plus /> Add Row
          </button>
          <button type="button" className="sav-link" onClick={() => setLines([])}>
            <Trash2 /> Clear All Items
          </button>
          <span className="sav-hint plain">
            <Info /> Selecting a product will auto-populate pack, batch, rate and tax details.
          </span>
        </div>
      </section>

      <footer className="sav-foot">
        <div>
          <span>
            <Package />
          </span>
          <div>
            <small>Total Items</small>
            <b>{totals.items}</b>
          </div>
        </div>
        <div>
          <span>
            <FileText />
          </span>
          <div>
            <small>Total Qty</small>
            <b>{totals.qty}</b>
          </div>
        </div>
        <div>
          <span>
            <Calculator />
          </span>
          <div>
            <small>Gross Amount</small>
            <b>{productFmt(totals.gross)}</b>
          </div>
        </div>
        <div>
          <span>
            <Tag />
          </span>
          <div>
            <small>Discount</small>
            <b>{productFmt(totals.disc)}</b>
          </div>
        </div>
        <div>
          <span>
            <Coins />
          </span>
          <div>
            <small>GST Amount</small>
            <b>{productFmt(totals.gst)}</b>
          </div>
        </div>
        <div className="net">
          <span>
            <Wallet />
          </span>
          <div>
            <small>Net Amount</small>
            <b>{productFmt(totals.net)}</b>
          </div>
        </div>
      </footer>
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
