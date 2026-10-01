'use client'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from '@/lib/router'
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ClipboardList,
  Download,
  FileText,
  Landmark,
  Pill,
  Printer,
  ReceiptText,
  ShieldCheck,
  TrendingUp,
  WalletCards,
} from 'lucide-react'
import { users } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Banner, Button, Field, Kpi, Modal, PageHead, Panel, Table, TextInput } from '@finsoft/ui'
import { AccountSelect, LedgerBook, LedgerKpis } from './ledger'
import { exportLedgerCsv, netOf } from './ledger-data'
import { money, moneyFromString, movementTone } from '@finsoft/ui'
import { useAuth } from '@/lib/api/auth-context'
import { useApiQuery } from '@/lib/api/use-api-query'
import { useIdempotencyKey } from '@/lib/api/idempotency-key'
import { getInvoice, reverseInvoice } from '@/lib/api/invoices-client'
import { getReceipt, reverseReceipt } from '@/lib/api/receipts-client'
import { receivablesErrorMessage } from '@/lib/adapters/receivables-errors'

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  )
}
function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}
function MissingRecord({ label }: { label: string }) {
  const navigate = useNavigate()
  return (
    <div className="state-page">
      <span>
        <FileText />
      </span>
      <h1>Record not found</h1>
      <p>No {label} matches that reference.</p>
      <Button kind="secondary" onClick={() => navigate(-1)}>
        <ArrowLeft /> Go back
      </Button>
    </div>
  )
}
function DocHeader({
  eyebrow,
  title,
  sub,
  back,
  actions,
  meta,
}: {
  eyebrow: string
  title: string
  sub?: string
  back: string
  actions?: ReactNode
  meta?: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <>
      <PageHead
        eyebrow={eyebrow}
        title={title}
        description={sub ?? ''}
        actions={
          <Button kind="ghost" onClick={() => navigate(back)}>
            <ArrowLeft /> Back
          </Button>
        }
      />
      {meta && <div className="detail-meta">{meta}</div>}
      {actions && <div className="detail-actions">{actions}</div>}
    </>
  )
}

function ProductDetail({ data }: { data: AppData }) {
  const { id } = useParams()
  const product = data.products.find((p) => p.id === id)
  if (!product) return <MissingRecord label="product" />
  const movements = data.movements.filter((m) => m.product === product.name)
  const related = [
    ...data.purchases
      .filter((p) => p.product === product.name)
      .map((p) => ({
        id: p.id,
        date: p.date,
        type: 'Purchase',
        party: p.supplier,
        qty: p.qty,
        amount: p.amount,
      })),
    ...data.sales
      .filter((s) => s.product === product.name)
      .map((s) => ({
        id: s.id,
        date: s.date,
        type: 'Sale',
        party: s.customer,
        qty: s.qty,
        amount: s.amount,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  const nextExpiry = [...product.batches].sort((a, b) => a.expiry.localeCompare(b.expiry))[0]
  const margin = Math.round(((product.price - product.cost) / product.price) * 100)
  return (
    <>
      <DocHeader
        eyebrow="Trading / Products"
        title={product.name}
        sub={`${product.id} · ${product.generic} · ${product.category}`}
        back="/products"
        meta={<span>Supplier {product.supplier} · FY 2026–27</span>}
        actions={
          <>
            <Button kind="secondary">
              <Printer /> Print label
            </Button>
            <Button>
              <Pill /> Edit product
            </Button>
          </>
        }
      />
      <div className="kpi-grid">
        <Kpi
          label="Available stock"
          value={`${product.stock} packs`}
          change={`${product.batches.length} batches on hand`}
          icon={Boxes}
        />
        <Kpi
          label="Reorder at"
          value={`${product.reorder} packs`}
          change={product.stock <= product.reorder ? 'Reorder needed' : 'Healthy level'}
          icon={ClipboardList}
          tone="yellow"
        />
        <Kpi
          label="Retail price"
          value={money(product.price)}
          change={`Cost ${money(product.cost)}`}
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Gross margin"
          value={`${margin}%`}
          change="Per pack"
          icon={TrendingUp}
          tone="blue"
        />
      </div>
      <div className="detail-grid">
        <DetailField label="SKU" value={product.id} />
        <DetailField label="Generic name" value={product.generic} />
        <DetailField label="Category" value={product.category} />
        <DetailField label="Supplier" value={product.supplier} />
        <DetailField label="Next expiry" value={nextExpiry?.expiry ?? '—'} />
        <DetailField
          label="Health status"
          value={
            product.stock <= product.reorder ? (
              <Badge tone="warn">Low stock</Badge>
            ) : (
              <Badge tone="good">In stock</Badge>
            )
          }
        />
      </div>
      <div className="doc-grid">
        <Panel title="Batch ledger" sub="Stock and cost across every batch">
          <Table
            headers={['Batch', 'Expiry', 'Stock', 'Cost', 'Status']}
            rows={product.batches.map((b) => [
              b.id,
              b.expiry,
              b.stock,
              money(b.cost),
              b.expiry < '2026-08-30' ? (
                <Badge tone="danger">Expired</Badge>
              ) : b.stock ? (
                <Badge tone="good">Saleable</Badge>
              ) : (
                <Badge>Empty</Badge>
              ),
            ])}
          />
        </Panel>
        <Panel title="Related documents" sub="Purchases and sales for this product">
          <Table
            headers={['Reference', 'Date', 'Type', 'Party', 'Qty', 'Amount']}
            rows={
              related.length
                ? related.map((r) => [
                    <b>{r.id}</b>,
                    r.date,
                    <Badge tone={r.type === 'Purchase' ? 'good' : 'info'}>{r.type}</Badge>,
                    r.party,
                    r.qty,
                    <b>{money(r.amount)}</b>,
                  ])
                : [[<EmptyState key="e">No related documents yet</EmptyState>]]
            }
          />
        </Panel>
      </div>
      <Panel title="Movement history" sub="Stock ledger entries for this product">
        <Table
          headers={['Reference', 'Date', 'Type', 'Qty', 'Batch']}
          rows={
            movements.length
              ? movements.map((m) => [
                  <b>{m.reference}</b>,
                  m.date,
                  <Badge tone={movementTone(m.type)}>{m.type}</Badge>,
                  <b>{m.qty > 0 ? `+${m.qty}` : m.qty}</b>,
                  m.batch,
                ])
              : [[<EmptyState key="e">No movements recorded</EmptyState>]]
          }
        />
      </Panel>
    </>
  )
}

function PurchaseDetail({ data }: { data: AppData }) {
  const { id } = useParams()
  const purchase = data.purchases.find((p) => p.id === id)
  if (!purchase) return <MissingRecord label="purchase invoice" />
  const gst = Math.round(purchase.amount * 0.17)
  const journals = data.journals.filter((j) => j.reference === id)
  return (
    <>
      <DocHeader
        eyebrow="Trading / Purchasing"
        title={`Purchase ${purchase.id}`}
        sub={`${purchase.date} · ${purchase.supplier}`}
        back="/purchasing"
        meta={<span>Fiscal period FY 2026–27 · Branch Lahore Main</span>}
        actions={
          <>
            <Button kind="secondary">
              <Printer /> Print
            </Button>
            <Button>
              <Check /> Post stock
            </Button>
          </>
        }
      />
      <div className="kpi-grid">
        <Kpi
          label="Quantity"
          value={`${purchase.qty} packs`}
          change="Single line item"
          icon={Boxes}
        />
        <Kpi
          label="Unit cost"
          value={money(purchase.unitCost)}
          change={`Batch ${purchase.batch}`}
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Invoice amount"
          value={money(purchase.amount)}
          change={`GST 17% ${money(gst)}`}
          icon={ReceiptText}
          tone="blue"
        />
        <Kpi
          label="Stock impact"
          value={`+${purchase.qty}`}
          change={purchase.status === 'Posted' ? 'Posted to stock' : 'Draft — not yet posted'}
          icon={TrendingUp}
          tone="yellow"
        />
      </div>
      <div className="detail-grid">
        <DetailField label="Supplier" value={purchase.supplier} />
        <DetailField label="Invoice date" value={purchase.date} />
        <DetailField label="Batch" value={purchase.batch} />
        <DetailField label="Expiry" value={purchase.expiry} />
        <DetailField
          label="Status"
          value={
            purchase.status === 'Posted' ? (
              <Badge tone="good">Posted</Badge>
            ) : (
              <Badge tone="warn">Draft</Badge>
            )
          }
        />
        <DetailField label="Payment terms" value="Net 30 days" />
      </div>
      <div className="doc-grid">
        <Panel title="Line items" sub="Goods received on this invoice">
          <Table
            headers={['Product', 'Batch', 'Expiry', 'Qty', 'Unit cost', 'Amount']}
            rows={[
              [
                <b>{purchase.product}</b>,
                purchase.batch,
                purchase.expiry,
                purchase.qty,
                money(purchase.unitCost),
                <b>{money(purchase.amount)}</b>,
              ],
            ]}
          />
        </Panel>
        <Panel title="Invoice totals">
          <div className="totals-card">
            <div>
              <span>Subtotal</span>
              <b>{money(purchase.amount)}</b>
            </div>
            <div>
              <span>GST 17%</span>
              <b>{money(gst)}</b>
            </div>
            <div>
              <span>Grand total</span>
              <b>{money(purchase.amount + gst)}</b>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Ledger impact" sub="Journal entries generated when this invoice is posted">
        <Table
          headers={['Journal', 'Date', 'Description', 'Debit', 'Credit', 'Amount']}
          rows={
            journals.length
              ? journals.map((j) => [
                  <b>{j.id}</b>,
                  j.date,
                  j.description,
                  j.debit,
                  j.credit,
                  <b>{money(j.amount)}</b>,
                ])
              : [
                  [
                    <EmptyState key="e">
                      No journal entry yet — draft invoices post on approval
                    </EmptyState>,
                  ],
                ]
          }
        />
      </Panel>
    </>
  )
}

/*
 * Invoice detail — /sales/:id. Real API (I3 `GET /api/invoices/:id`), replacing the mock's
 * product/batch/GST sale record. `data` is kept in the signature only because the route table
 * still passes it uniformly to every detail page in this file; the real invoice no longer
 * needs it (M4-W2).
 */
function SaleDetail(_props: { data: AppData }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { state, reload } = useApiQuery(
    () => (id ? getInvoice(id) : Promise.reject(new Error('missing id'))),
    [id],
  )
  const [reverseOpen, setReverseOpen] = useState(false)

  if (state.status === 'loading') {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <h1>Loading invoice…</h1>
      </div>
    )
  }
  if (state.status === 'forbidden') {
    return (
      <div className="state-page" role="alert">
        <h1>Access restricted</h1>
        <p>Your role does not have permission to view invoices.</p>
      </div>
    )
  }
  if (state.status === 'error') {
    if (state.message.toLowerCase().includes('not found')) {
      return <MissingRecord label="invoice" />
    }
    return (
      <div className="state-page" role="alert">
        <h1>We could not load this invoice</h1>
        <p>{state.message}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    )
  }

  const invoice = state.data
  const statusTone =
    invoice.status === 'POSTED'
      ? 'good'
      : invoice.status === 'DRAFT'
        ? 'info'
        : invoice.status === 'REVERSED'
          ? 'danger'
          : 'neutral'
  const settlementLabel =
    invoice.settlement === 'PAID'
      ? 'Paid'
      : invoice.settlement === 'PARTIALLY_PAID'
        ? 'Partially paid'
        : invoice.settlement === 'OPEN'
          ? 'Open'
          : '—'
  // `invoice.post` + `voucher.reverse` (privileged) — matches the controller's
  // @RequirePermission on POST /invoices/:id/reverse (I8). UI affordance only; the server
  // re-checks under lock.
  const canReverse =
    invoice.status === 'POSTED' &&
    invoice.reversalBlockedBy.length === 0 &&
    can('invoice.post') &&
    can('voucher.reverse')
  const blockedByReverse = invoice.status === 'POSTED' && invoice.reversalBlockedBy.length > 0

  return (
    <>
      <DocHeader
        eyebrow="Trading / Sales"
        title={invoice.number ?? 'Draft invoice'}
        sub={`${invoice.invoiceDate} · ${invoice.customer.name}`}
        back="/sales"
        meta={
          <span>
            <Badge tone={statusTone}>{invoice.status}</Badge>{' '}
            {invoice.settlement && <Badge tone="info">{settlementLabel}</Badge>}
          </span>
        }
        actions={
          <>
            {invoice.status === 'DRAFT' && can('invoice.create') && (
              <Button onClick={() => navigate(`/sales/voucher?invoice=${invoice.id}`)}>
                Edit draft
              </Button>
            )}
            {canReverse && (
              <Button kind="danger" onClick={() => setReverseOpen(true)}>
                Reverse
              </Button>
            )}
          </>
        }
      />
      {invoice.status === 'DRAFT' && (
        <Banner tone="info">This invoice is a draft. It has not been posted to the ledger.</Banner>
      )}
      {blockedByReverse && (
        <Banner tone="warn">
          This invoice cannot be reversed while it has live receipt allocations. Reverse{' '}
          {invoice.reversalBlockedBy.map((r) => r.number).join(', ')} first.
        </Banner>
      )}
      {invoice.reversal && (
        <Banner tone="danger">
          Reversed by {invoice.reversal.entryNumber} — {invoice.reversal.reason}
        </Banner>
      )}
      <div className="kpi-grid">
        <Kpi
          label="Lines"
          value={String(invoice.lines.length)}
          change="Service lines"
          icon={Boxes}
        />
        <Kpi
          label="Net amount"
          value={moneyFromString(invoice.netAmount)}
          change={invoice.number ?? 'Not yet posted'}
          icon={ReceiptText}
          tone="blue"
        />
        <Kpi
          label="Outstanding"
          value={invoice.outstanding ? moneyFromString(invoice.outstanding) : '—'}
          change={invoice.outstanding ? 'Still to collect' : 'Not posted'}
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Settlement"
          value={settlementLabel}
          change={invoice.status}
          icon={TrendingUp}
          tone="yellow"
        />
      </div>
      <div className="detail-grid">
        <DetailField label="Customer" value={`${invoice.customer.name} (${invoice.customer.code})`} />
        <DetailField label="Status" value={<Badge tone={statusTone}>{invoice.status}</Badge>} />
        <DetailField label="Invoice date" value={invoice.invoiceDate} />
        <DetailField label="Due date" value={invoice.dueDate ?? '—'} />
        <DetailField label="Narration" value={invoice.narration ?? '—'} />
        <DetailField
          label="Journal entry"
          value={
            invoice.journalEntry ? (
              <button
                className="linkable"
                onClick={() => navigate(`/vouchers/${invoice.journalEntry!.id}`)}
              >
                {invoice.journalEntry.number}
              </button>
            ) : (
              '—'
            )
          }
        />
      </div>
      <div className="doc-grid">
        <Panel title="Line items" sub="Service lines on this invoice">
          <Table
            headers={['#', 'Description', 'Qty', 'Unit price', 'Net amount']}
            rows={
              invoice.lines.length
                ? invoice.lines.map((line) => [
                    line.lineNo,
                    line.description,
                    line.quantity,
                    moneyFromString(line.unitPrice),
                    <b key="net">{moneyFromString(line.lineNet)}</b>,
                  ])
                : [[<EmptyState key="e">No lines</EmptyState>]]
            }
          />
        </Panel>
        <Panel title="Invoice totals">
          <div className="totals-card">
            <div>
              <span>Net amount</span>
              <b>{moneyFromString(invoice.netAmount)}</b>
            </div>
            <div>
              <span>Outstanding</span>
              <b>{invoice.outstanding ? moneyFromString(invoice.outstanding) : '—'}</b>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Allocations" sub="Receipts applied against this invoice">
        <Table
          headers={['Receipt', 'Date', 'Amount', 'Status']}
          rows={
            invoice.allocations.length
              ? invoice.allocations.map((a) => [
                  <button
                    key="r"
                    className="linkable"
                    onClick={() => navigate(`/receipts/${a.receiptId}`)}
                  >
                    {a.receiptNumber}
                  </button>,
                  a.receiptDate,
                  moneyFromString(a.amount),
                  <Badge key="s" tone={a.status === 'LIVE' ? 'good' : 'neutral'}>
                    {a.status}
                  </Badge>,
                ])
              : [[<EmptyState key="e">No receipts allocated yet</EmptyState>]]
          }
        />
      </Panel>
      {reverseOpen && (
        <InvoiceReverseDialog
          invoiceId={invoice.id}
          onClose={() => setReverseOpen(false)}
          onDone={() => {
            setReverseOpen(false)
            reload()
          }}
        />
      )}
    </>
  )
}

function InvoiceReverseDialog({
  invoiceId,
  onClose,
  onDone,
}: {
  invoiceId: string
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
      await reverseInvoice(invoiceId, { reason: reason.trim() }, key)
      onDone()
    } catch (err) {
      setError(receivablesErrorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Reverse invoice" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>
          This posts a new reversing journal entry that exactly neutralises this invoice. Both
          entries remain in the ledger permanently. This cannot be undone.
        </p>
        <Field label="Reason" htmlFor="invoice-reverse-reason" required error={error ?? undefined}>
          <TextInput id="invoice-reverse-reason" value={reason} onChange={setReason} required />
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
            Reverse invoice
          </Button>
        </div>
      </form>
    </Modal>
  )
}


function MasterDetail({ data }: { data: AppData }) {
  const { code } = useParams()
  const master = data.masters.find((m) => m.code === code)
  if (!master) return <MissingRecord label="master record" />
  const linked = [
    ...data.sales
      .filter((s) => s.customer === master.name)
      .map((s) => ({ id: s.id, date: s.date, type: 'Sale', party: s.customer, amount: s.amount })),
    ...data.purchases
      .filter((p) => p.supplier === master.name)
      .map((p) => ({
        id: p.id,
        date: p.date,
        type: 'Purchase',
        party: p.supplier,
        amount: p.amount,
      })),
    ...data.journals
      .filter((j) => j.debit === master.name || j.credit === master.name)
      .map((j) => ({
        id: j.id,
        date: j.date,
        type: 'Journal',
        party: j.description,
        amount: j.amount,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  return (
    <>
      <DocHeader
        eyebrow="Trading / Masters"
        title={master.name}
        sub={`${master.code} · ${master.type} record`}
        back="/masters"
        actions={
          <>
            <Button kind="secondary">
              <Printer /> Print card
            </Button>
            <Button>
              <Pill /> Edit record
            </Button>
          </>
        }
      />
      <div className="kpi-grid mini">
        <Kpi
          label="Current balance"
          value={master.balance ? money(master.balance) : '—'}
          change={`${master.balanceType} balance type`}
          icon={WalletCards}
        />
        <Kpi
          label="Linked transactions"
          value={String(linked.length)}
          change="Sales, purchases and journals"
          icon={ClipboardList}
          tone="teal"
        />
        <Kpi
          label="Record status"
          value={master.status}
          change="Maintained centrally"
          icon={ShieldCheck}
          tone="blue"
        />
      </div>
      <div className="detail-grid">
        <DetailField label="Code" value={master.code} />
        <DetailField label="Record type" value={master.type} />
        <DetailField label="Balance type" value={master.balanceType} />
        <DetailField label="City" value={master.city} />
        <DetailField label="Contact" value={master.contact} />
        <DetailField label="Status" value={<Badge tone="good">{master.status}</Badge>} />
      </div>
      <Panel title="Linked transactions" sub="Documents touching this master record">
        <Table
          headers={['Reference', 'Date', 'Type', 'Party / description', 'Amount']}
          rows={
            linked.length
              ? linked.map((l) => [
                  <b>{l.id}</b>,
                  l.date,
                  <Badge
                    tone={l.type === 'Sale' ? 'info' : l.type === 'Purchase' ? 'good' : 'neutral'}
                  >
                    {l.type}
                  </Badge>,
                  l.party,
                  <b>{money(l.amount)}</b>,
                ])
              : [[<EmptyState key="e">No linked transactions yet</EmptyState>]]
          }
        />
      </Panel>
    </>
  )
}

function AccountDetail({ data }: { data: AppData }) {
  const navigate = useNavigate()
  const { code } = useParams()
  const master = data.masters.find((m) => m.code === code)
  if (!master) return <MissingRecord label="account" />
  const chart = data.masters.filter((m) => m.level)
  const kidsOf = (p: string) => data.masters.filter((m) => m.parent === p)
  const netAll = (rows: { name: string }[]) => {
    const n = rows.map((r) => netOf(data.journals, r.name))
    return { dr: n.reduce((a, x) => a + x.dr, 0), cr: n.reduce((a, x) => a + x.cr, 0) }
  }
  const isHeader = !!master.level && master.level !== 4
  if (isHeader) {
    const tree: typeof data.masters = []
    const walk = (p: string) => {
      kidsOf(p).forEach((k) => {
        tree.push(k)
        if ((k.level ?? 4) < 4) walk(k.code)
      })
    }
    walk(master.code)
    const ag = netAll(tree)
    const leaves = tree.filter((k) => k.level === 4)
    return (
      <>
        <PageHead
          eyebrow="Accounting / Account ledger"
          title={master.name}
          description={`${master.code} · ${master.type} · level ${master.level} header — postings live on level-4 children; this roll-up aggregates them.`}
          actions={
            <Button kind="ghost" onClick={() => navigate('/ledgers')}>
              <ArrowLeft /> Ledger list
            </Button>
          }
        />
        <div className="lg-bar">
          <div className="lg-ident">
            <span>
              <Landmark />
            </span>
            <div>
              <h2>{master.name}</h2>
              <p>
                {master.code} · {master.type} header · {tree.length} sub-accounts ({leaves.length}{' '}
                postable) roll up under this head
              </p>
            </div>
          </div>
          <AccountSelect
            masters={chart}
            value={master.code}
            onChange={(c) => navigate(`/finance/accounts/${c}`)}
          />
        </div>
        <div className="kpi-grid lg-kpis">
          <Kpi
            label="Sub-accounts"
            value={String(tree.length)}
            change={`${kidsOf(master.code).length} direct children`}
            icon={Landmark}
          />
          <Kpi
            label="Aggregated debit"
            value={money(ag.dr)}
            change="Across the sub-ledger"
            icon={ArrowDownRight}
            tone="teal"
          />
          <Kpi
            label="Aggregated credit"
            value={money(ag.cr)}
            change="Across the sub-ledger"
            icon={ArrowUpRight}
            tone="yellow"
          />
          <Kpi
            label="Net position"
            value={money(Math.abs(ag.dr - ag.cr))}
            change={ag.dr - ag.cr >= 0 ? 'Debit-natured balance' : 'Credit-natured balance'}
            icon={WalletCards}
            tone="blue"
          />
        </div>
        <Panel
          title="Sub-ledger roll-up"
          sub="Every child under this head — open any postable account to see its statement"
          action={
            <Button kind="secondary" onClick={() => exportLedgerCsv(data, master)}>
              <Download /> Export
            </Button>
          }
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th>Level</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th>Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tree.map((k) => {
                  const n = netOf(data.journals, k.name)
                  const leaf = k.level === 4
                  return (
                    <tr key={k.code}>
                      <td>
                        <b>{k.code}</b>
                      </td>
                      <td>
                        {leaf ? (
                          <button
                            className="linkable"
                            onClick={() => navigate(`/finance/accounts/${k.code}`)}
                          >
                            {k.name}
                          </button>
                        ) : (
                          <b className="hd-acc">{k.name}</b>
                        )}
                      </td>
                      <td>
                        {leaf ? (
                          <span className="badge good">Level 4 · postable</span>
                        ) : (
                          <span className="badge">Level {k.level} · header</span>
                        )}
                      </td>
                      <td>{money(n.dr)}</td>
                      <td>{money(n.cr)}</td>
                      <td>
                        <b className="tb-bal">
                          {n.dr > n.cr
                            ? `${money(n.dr - n.cr)} Dr`
                            : n.cr > n.dr
                              ? `${money(n.cr - n.dr)} Cr`
                              : money(0)}
                        </b>
                      </td>
                      <td>
                        {leaf && (
                          <button
                            className="table-action"
                            onClick={() => navigate(`/finance/accounts/${k.code}`)}
                          >
                            Ledger <ArrowRight />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </>
    )
  }
  const net = netOf(data.journals, master.name)
  return (
    <>
      <PageHead
        eyebrow="Accounting / Account ledger"
        title={master.name}
        description={`${master.code} · ${master.type}${master.level === 4 ? ' · level 4 transaction account' : ' ledger'} — full statement below.`}
        actions={
          <Button kind="ghost" onClick={() => navigate('/ledgers')}>
            <ArrowLeft /> Ledger list
          </Button>
        }
      />
      <div className="lg-bar">
        <div className="lg-ident">
          <span>
            <Landmark />
          </span>
          <div>
            <h2>{master.name}</h2>
            <p>
              {master.code} · {master.type} · {money(net.dr)} debited / {money(net.cr)} credited in
              Aug 2026
            </p>
          </div>
        </div>
        <AccountSelect
          masters={chart}
          value={master.code}
          onChange={(c) => navigate(`/finance/accounts/${c}`)}
        />
      </div>
      <LedgerKpis data={data} master={master} />
      <LedgerBook
        data={data}
        master={master}
        action={
          <Button kind="secondary" onClick={() => exportLedgerCsv(data, master)}>
            <Download /> Download CSV
          </Button>
        }
      />
    </>
  )
}
function EmployeeDetail({ data }: { data: AppData }) {
  const { id } = useParams()
  const row = data.employees.find((e) => e[0] === id)
  if (!row) return <MissingRecord label="employee" />
  const [empId, name, designation, branch, salary, today] = row
  const salaryNum = Number(salary.replace(/[^0-9]/g, ''))
  const net = Math.round(salaryNum * 0.92),
    ded = salaryNum - net
  return (
    <>
      <DocHeader
        eyebrow="People"
        title={name}
        sub={`${designation} · ${branch}`}
        back="/hr"
        actions={
          <>
            <Button kind="secondary">
              <ClipboardList /> Mark attendance
            </Button>
            <Button>
              <WalletCards /> Edit payroll
            </Button>
          </>
        }
      />
      <div className="kpi-grid mini">
        <Kpi label="Gross salary" value={salary} change="August 2026 cycle" icon={WalletCards} />
        <Kpi
          label="Attendance this month"
          value="23 days"
          change="Working days in August"
          icon={ClipboardList}
          tone="teal"
        />
        <Kpi
          label="Days present"
          value="22"
          change="1 leave · 0 absences"
          icon={TrendingUp}
          tone="blue"
        />
      </div>
      <div className="detail-grid">
        <DetailField label="Employee ID" value={empId} />
        <DetailField label="Designation" value={designation} />
        <DetailField label="Branch" value={branch} />
        <DetailField label="Joining date" value="12 Mar 2023" />
        <DetailField label="August salary" value={salary} />
        <DetailField
          label="Today"
          value={
            today === 'Present' ? (
              <Badge tone="good">Present</Badge>
            ) : today === 'Field' ? (
              <Badge tone="info">Field</Badge>
            ) : (
              <Badge tone="warn">On leave</Badge>
            )
          }
        />
      </div>
      <div className="doc-grid">
        <Panel title="Attendance — August 2026" sub="Latest punches">
          <Table
            headers={['Date', 'Day', 'Check-in', 'Check-out', 'Status']}
            rows={[
              ['29 Aug 2026', 'Saturday', '09:01', '18:12', 'Present'],
              ['28 Aug 2026', 'Friday', '08:58', '18:05', 'Present'],
              ['27 Aug 2026', 'Thursday', '09:10', '17:50', 'Present'],
              ['26 Aug 2026', 'Wednesday', '—', '—', 'Leave'],
            ]}
          />
        </Panel>
        <Panel title="Payroll history" sub="Last three cycles">
          <Table
            headers={['Month', 'Gross', 'Deductions', 'Net pay']}
            rows={[
              ['June 2026', salary, money(ded), money(net)],
              ['July 2026', salary, money(ded), money(net)],
              ['August 2026', salary, money(ded), money(net)],
            ]}
          />
        </Panel>
      </div>
      <Panel title="Allowances" sub="Fixed monthly components">
        <Table
          headers={['Allowance', 'Amount']}
          rows={[
            ['House rent', money(Math.round(salaryNum * 0.2))],
            ['Medical allowance', money(Math.round(salaryNum * 0.1))],
            ['Conveyance', money(Math.round(salaryNum * 0.06))],
          ]}
        />
      </Panel>
    </>
  )
}

function UserDetail() {
  const { id } = useParams()
  const user = users.find((u) => u.id === id)
  if (!user) return <MissingRecord label="user account" />
  return (
    <>
      <DocHeader
        eyebrow="Platform"
        title={user.name}
        sub={`${user.role} · ${user.branch}`}
        back="/admin"
        actions={
          <>
            <Button kind="secondary">
              <ShieldCheck /> Reset password
            </Button>
            <Button kind="danger">
              <ShieldCheck /> Revoke access
            </Button>
          </>
        }
      />
      <div className="detail-grid">
        <DetailField label="User ID" value={user.id} />
        <DetailField label="Role" value={<Badge tone="info">{user.role}</Badge>} />
        <DetailField label="Branch" value={user.branch} />
        <DetailField label="Email" value={user.email} />
        <DetailField
          label="Two-factor auth"
          value={
            user.twoFactor ? <Badge tone="good">Enabled</Badge> : <Badge tone="warn">Off</Badge>
          }
        />
        <DetailField label="Last active" value={user.lastActive} />
      </div>
      <div className="doc-grid">
        <Panel title="Module permissions" sub="This user can access the following modules">
          <div className="tag-list">
            {user.modules.map((m) => (
              <Badge tone="good" key={m}>
                {m}
              </Badge>
            ))}
          </div>
        </Panel>
        <Panel title="Active sessions" sub="Live sign-in devices">
          <Table
            headers={['Device', 'Location', 'Last active', 'IP']}
            rows={user.sessions.map((s) => [s.device, s.location, s.lastActive, s.ip])}
          />
        </Panel>
      </div>
      <Panel title="Audit trail" sub="Security-sensitive actions by this user">
        <div className="timeline">
          {user.audit.map((a, i) => (
            <div key={i}>
              <b>{a.action}</b>
              <p>{a.detail}</p>
              <small>{a.date}</small>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}

/*
 * Receipt detail — /receipts/:id. Real API (R4 `GET /api/receipts/:id`). Mirrors SaleDetail's
 * shape: status, the real RCT-... number, allocations (which invoices this receipt paid down),
 * the linked journal entry, and reverse gated by payment.receive + voucher.reverse (matching
 * the controller's @RequirePermission on R8). No mock predecessor — this route did not exist
 * before M4-W2.
 */
function ReceiptDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { state, reload } = useApiQuery(
    () => (id ? getReceipt(id) : Promise.reject(new Error('missing id'))),
    [id],
  )
  const [reverseOpen, setReverseOpen] = useState(false)

  if (state.status === 'loading') {
    return (
      <div className="state-page" role="status" aria-live="polite">
        <h1>Loading receipt…</h1>
      </div>
    )
  }
  if (state.status === 'forbidden') {
    return (
      <div className="state-page" role="alert">
        <h1>Access restricted</h1>
        <p>Your role does not have permission to view receipts.</p>
      </div>
    )
  }
  if (state.status === 'error') {
    if (state.message.toLowerCase().includes('not found')) {
      return <MissingRecord label="receipt" />
    }
    return (
      <div className="state-page" role="alert">
        <h1>We could not load this receipt</h1>
        <p>{state.message}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    )
  }

  const receipt = state.data
  const statusTone =
    receipt.status === 'POSTED'
      ? 'good'
      : receipt.status === 'DRAFT'
        ? 'info'
        : receipt.status === 'REVERSED'
          ? 'danger'
          : 'neutral'
  const canReverse =
    receipt.status === 'POSTED' && can('payment.receive') && can('voucher.reverse')

  return (
    <>
      <DocHeader
        eyebrow="Trading / Receipts"
        title={receipt.number ?? 'Draft receipt'}
        sub={`${receipt.receiptDate} · ${receipt.customer.name}`}
        back="/payments"
        meta={<Badge tone={statusTone}>{receipt.status}</Badge>}
        actions={
          canReverse && (
            <Button kind="danger" onClick={() => setReverseOpen(true)}>
              Reverse
            </Button>
          )
        }
      />
      {receipt.status === 'DRAFT' && (
        <Banner tone="info">This receipt is a draft. It has not been posted to the ledger.</Banner>
      )}
      {receipt.reversal && (
        <Banner tone="danger">
          Reversed by {receipt.reversal.entryNumber} — {receipt.reversal.reason}
        </Banner>
      )}
      <div className="kpi-grid">
        <Kpi
          label="Amount"
          value={receipt.amount ? moneyFromString(receipt.amount) : '—'}
          change={receipt.method ?? 'Not set'}
          icon={WalletCards}
          tone="blue"
        />
        <Kpi
          label="Allocations"
          value={String(receipt.allocations.length)}
          change="Invoices paid down"
          icon={ReceiptText}
          tone="teal"
        />
        <Kpi label="Status" value={receipt.status} change={receipt.method ?? '—'} icon={TrendingUp} tone="yellow" />
      </div>
      <div className="detail-grid">
        <DetailField label="Customer" value={`${receipt.customer.name} (${receipt.customer.code})`} />
        <DetailField label="Status" value={<Badge tone={statusTone}>{receipt.status}</Badge>} />
        <DetailField label="Receipt date" value={receipt.receiptDate} />
        <DetailField label="Method" value={receipt.method ?? '—'} />
        <DetailField label="Reference" value={receipt.reference ?? '—'} />
        <DetailField label="Narration" value={receipt.narration ?? '—'} />
        <DetailField
          label="Journal entry"
          value={
            receipt.journalEntry ? (
              <button
                className="linkable"
                onClick={() => navigate(`/vouchers/${receipt.journalEntry!.id}`)}
              >
                {receipt.journalEntry.number}
              </button>
            ) : (
              '—'
            )
          }
        />
      </div>
      <Panel title="Allocations" sub="Invoices this receipt paid down">
        <Table
          headers={['Invoice', 'Date', 'Amount', 'Status']}
          rows={
            receipt.allocations.length
              ? receipt.allocations.map((a) => [
                  <button
                    key="i"
                    className="linkable"
                    onClick={() => navigate(`/sales/${a.invoiceId}`)}
                  >
                    {a.invoiceNumber}
                  </button>,
                  a.invoiceDate,
                  moneyFromString(a.amount),
                  <Badge key="s" tone={a.status === 'LIVE' ? 'good' : 'neutral'}>
                    {a.status}
                  </Badge>,
                ])
              : [[<EmptyState key="e">No allocations</EmptyState>]]
          }
        />
      </Panel>
      {reverseOpen && (
        <ReceiptReverseDialog
          receiptId={receipt.id}
          onClose={() => setReverseOpen(false)}
          onDone={() => {
            setReverseOpen(false)
            reload()
          }}
        />
      )}
    </>
  )
}

function ReceiptReverseDialog({
  receiptId,
  onClose,
  onDone,
}: {
  receiptId: string
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
      await reverseReceipt(receiptId, { reason: reason.trim() }, key)
      onDone()
    } catch (err) {
      setError(receivablesErrorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Reverse receipt" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>
          This posts a new reversing journal entry that exactly neutralises this receipt and
          restores the outstanding balance on every invoice it was allocated to. Both entries
          remain in the ledger permanently. This cannot be undone.
        </p>
        <Field label="Reason" htmlFor="receipt-reverse-reason" required error={error ?? undefined}>
          <TextInput id="receipt-reverse-reason" value={reason} onChange={setReason} required />
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
            Reverse receipt
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export {
  ProductDetail,
  PurchaseDetail,
  SaleDetail,
  ReceiptDetail,
  MasterDetail,
  AccountDetail,
  EmployeeDetail,
  UserDetail,
}
