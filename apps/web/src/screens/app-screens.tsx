'use client'
/* Dashboard and the seven compact module screens that lived inside
 * ui-prototype/src/App.tsx. Bodies are verbatim; only imports were rewritten. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from '@/lib/router'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  Boxes,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardPlus,
  Download,
  Eye,
  FileChartColumn,
  FilePlus2,
  FileText,
  Filter,
  Landmark,
  Pill,
  Plus,
  Printer,
  ReceiptText,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Users,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  chartData,
  masters as seedMasters,
  roles,
  users,
  type Master,
  type Product,
  type Purchase,
  type Sale,
} from '@/mocks/api'
import { usePersistentData } from '@/mocks/api'
import { MasterModal, ProductFormModal } from './master-form'
import { EmployeeFormModal } from './employee-form'
import {
  Button,
  Badge,
  PageHead,
  Kpi,
  Panel,
  SearchField,
  Modal,
  Table,
  Field,
  TextInput,
} from '@finsoft/ui'
import { money } from '@finsoft/ui'
import { useAuth } from '@/lib/api/auth-context'
import { useApiQuery } from '@/lib/api/use-api-query'
import { listAuditEvents } from '@/lib/api/audit-client'
import type { AuditEvent, AuditPage } from '@/lib/api/audit-types'
import { humanizeAction, actorLabel, entityLabel } from '@/lib/adapters/audit'
import { todayIso, nextLocalDayIso } from '@/lib/date/local-date'

export function Dashboard({
  go,
  data,
}: {
  go: (p: string) => void
  data: ReturnType<typeof usePersistentData>['data']
}) {
  const revenue = data.sales.reduce((a, s) => a + s.amount, 0),
    cogs = data.sales.reduce((a, s) => a + s.qty * s.unitCost, 0),
    stockValue = data.products.reduce(
      (a, p) => a + p.batches.reduce((x, b) => x + b.stock * b.cost, 0),
      0,
    )
  const quickActions: [string, string, string, LucideIcon][] = [
    ['Create voucher', 'Post a journal or cash entry', '/vouchers/new', ReceiptText],
    ['Sales invoice', 'Create a customer invoice', '/sales?new=1', FilePlus2],
    ['Purchase invoice', 'Record a supplier bill', '/purchasing?new=1', ShoppingBag],
    ['Record payment', 'Receive or pay funds', '/payments', WalletCards],
    ['Purchase order', 'Raise a new stock order', '/po', ClipboardPlus],
    ['Reports centre', 'Run financial reports', '/reports', FileChartColumn],
  ]
  return (
    <>
      <div className="hero-band">
        <div>
          <span className="hero-eyebrow">Sunday, 30 August 2026</span>
          <h1>Good morning, Ahmed</h1>
          <p>Here’s what is happening across Bhatti Traders today.</p>
        </div>
        <div className="hero-actions">
          <Button kind="secondary" onClick={() => go('/reports')}>
            <FileChartColumn /> View reports
          </Button>
          <Button kind="primary" onClick={() => go('/sales')}>
            <Plus /> New sale
          </Button>
        </div>
      </div>
      <div className="kpi-grid">
        <Kpi
          label="Net sales today"
          value={money(revenue)}
          change={`${data.sales.length} posted invoices`}
          icon={CircleDollarSign}
        />
        <Kpi
          label="Gross profit"
          value={money(revenue - cogs)}
          change={`${revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0}% margin`}
          icon={TrendingUp}
          tone="teal"
        />
        <Kpi
          label="Receivables"
          value={money(
            data.sales.filter((s) => s.status === 'Credit').reduce((a, s) => a + s.amount, 0),
          )}
          change="From live credit sales"
          icon={WalletCards}
          tone="blue"
        />
        <Kpi
          label="Stock value"
          value={money(stockValue)}
          change={`${data.products.reduce((a, p) => a + p.stock, 0)} packs on hand`}
          icon={Boxes}
          tone="yellow"
        />
      </div>
      <section className="quick-actions" aria-labelledby="quick-actions-title">
        <div className="quick-actions-head">
          <div>
            <h2 id="quick-actions-title">Quick actions</h2>
            <p>Start your most-used workflows</p>
          </div>
          <span>6 shortcuts</span>
        </div>
        <div className="quick-actions-grid">
          {quickActions.map(([label, description, path, Icon], index) => (
            <button
              type="button"
              onClick={() => go(path)}
              key={label}
              className={`quick-action tone-${index + 1}`}
            >
              <span className="quick-action-icon">
                <Icon />
              </span>
              <span className="quick-action-copy">
                <b>{label}</b>
                <small>{description}</small>
              </span>
              <ChevronRight />
            </button>
          ))}
        </div>
      </section>
      <div className="dashboard-grid">
        <Panel
          title="Sales pulse"
          sub="Daily sales and purchase value · this week"
          action={
            <select className="compact">
              <option>This week</option>
              <option>This month</option>
            </select>
          }
        >
          <div className="chart-lg">
            <ResponsiveContainer>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="sales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1d9c52" stopOpacity=".3" />
                    <stop offset="100%" stopColor="#1d9c52" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#e7ecf2" />
                <XAxis dataKey="day" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} tickFormatter={(v) => `${v / 1000}k`} />
                <Tooltip formatter={(v) => money(Number(v))} />
                <Area
                  type="monotone"
                  dataKey="sales"
                  stroke="#1a8f4c"
                  strokeWidth={3}
                  fill="url(#sales)"
                />
                <Area
                  type="monotone"
                  dataKey="purchases"
                  stroke="#2f7585"
                  strokeWidth={2}
                  fill="transparent"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span>
              <i className="dot green" />
              Sales Rs 1.18m
            </span>
            <span>
              <i className="dot teal" />
              Purchases Rs 644k
            </span>
          </div>
        </Panel>
        <Panel title="Inventory health" sub="Value distributed by status">
          <div className="donut-row">
            <div className="donut">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={[{ v: 72 }, { v: 17 }, { v: 11 }]}
                    dataKey="v"
                    innerRadius={58}
                    outerRadius={80}
                    startAngle={90}
                    endAngle={-270}
                    paddingAngle={4}
                  >
                    {['#1d9c52', '#f0be65', '#dd6d72'].map((c) => (
                      <Cell key={c} fill={c} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div>
                <b>1,248</b>
                <small>SKUs</small>
              </div>
            </div>
            <div className="health-list">
              <p>
                <i className="dot green" />
                <span>Healthy stock</span>
                <b>899</b>
              </p>
              <p>
                <i className="dot yellow" />
                <span>Low stock</span>
                <b>214</b>
              </p>
              <p>
                <i className="dot red" />
                <span>Near expiry</span>
                <b>135</b>
              </p>
            </div>
          </div>
          <Button kind="secondary" onClick={() => go('/inventory')}>
            Review inventory <ArrowRight />
          </Button>
        </Panel>
      </div>
      <div className="lower-grid">
        <Panel title="Needs attention" sub="Priority tasks for your team">
          <div className="attention">
            <button onClick={() => go('/procurement')}>
              <span className="alert-icon amber">
                <AlertTriangle />
              </span>
              <div>
                <b>8 products below reorder level</b>
                <small>Create a demand list before stock-out</small>
              </div>
              <ChevronRight />
            </button>
            <button onClick={() => go('/bank-book')}>
              <span className="alert-icon blue">
                <Landmark />
              </span>
              <div>
                <b>5 cheques awaiting clearance</b>
                <small>Total value Rs 214,000</small>
              </div>
              <ChevronRight />
            </button>
            <button onClick={() => go('/receivables')}>
              <span className="alert-icon red">
                <ArrowDownRight />
              </span>
              <div>
                <b>12 batches expire within 90 days</b>
                <small>Potential exposure Rs 86,400</small>
              </div>
              <ChevronRight />
            </button>
          </div>
        </Panel>
        <Panel title="Top products" sub="By sales value this month">
          <Table
            headers={['Product', 'Units', 'Revenue', 'Trend']}
            rows={[
              [<b>Panadol 500mg</b>, '864', 'Rs 311k', <Badge tone="good">↑ 12%</Badge>],
              [<b>Augmentin 625mg</b>, '218', 'Rs 227k', <Badge tone="good">↑ 8%</Badge>],
              [<b>Risek 20mg</b>, '310', 'Rs 189k', <Badge tone="warn">↓ 2%</Badge>],
            ]}
          />
        </Panel>
      </div>
    </>
  )
}

export function Products({
  products,
  onAddProduct,
  canCreate,
}: {
  products: ReturnType<typeof usePersistentData>['data']['products']
  onAddProduct: (p: Product) => void
  canCreate: boolean
}) {
  const loc = useLocation(),
    navigate = useNavigate()
  const [search, setSearch] = useState(new URLSearchParams(loc.search).get('q') || ''),
    [category, setCategory] = useState('All'),
    [open, setOpen] = useState(false)
  const filtered = products.filter(
    (p) =>
      (category === 'All' || p.category === category) &&
      `${p.name} ${p.generic} ${p.id}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <>
      <PageHead
        eyebrow="Products / Product catalogue"
        title="Product catalogue"
        description="Manage medicines, pricing, batches and reorder controls."
        actions={
          <>
            <Button kind="secondary">
              <Download /> Export
            </Button>
            <Button disabled={!canCreate} onClick={() => setOpen(true)}>
              <Plus /> Add product
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search product, generic or code..."
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option>All</option>
          {[...new Set(products.map((p) => p.category))].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <Button kind="secondary">
          <Filter /> More filters
        </Button>
        <span className="record-count">{filtered.length} products</span>
      </div>
      <Panel title="All products" sub="Live stock and pricing across every batch">
        <Table
          headers={[
            'Product',
            'Category',
            'Batches / next expiry',
            'Stock',
            'Avg. cost',
            'Retail price',
            'Status',
            '',
          ]}
          rows={filtered.map((p) => [
            <button className="product-cell" onClick={() => navigate(`/products/${p.id}`)}>
              <span>
                <Pill />
              </span>
              <div>
                <b>{p.name}</b>
                <small>
                  {p.id} · {p.generic}
                </small>
              </div>
            </button>,
            p.category,
            <div>
              <b>{p.batches.length} batches</b>
              <small>
                {[...p.batches].sort((a, b) => a.expiry.localeCompare(b.expiry))[0]?.expiry}
              </small>
            </div>,
            <b>{p.stock}</b>,
            money(
              Math.round(
                p.batches.reduce((a, b) => a + b.cost * b.stock, 0) / Math.max(1, p.stock),
              ),
            ),
            <b>{money(p.price)}</b>,
            p.stock <= p.reorder ? (
              <Badge tone="warn">Low stock</Badge>
            ) : (
              <Badge tone="good">In stock</Badge>
            ),
            <button
              aria-label={`View ${p.name}`}
              className="table-action"
              onClick={() => navigate(`/products/${p.id}`)}
            >
              <Eye /> View
            </button>,
          ])}
        />
      </Panel>
      {open && (
        <ProductFormModal
          open={open}
          list={products}
          onClose={() => setOpen(false)}
          onSave={onAddProduct}
        />
      )}
    </>
  )
}
export function Purchasing({
  products,
  purchases,
  onAdd,
  canCreate,
}: {
  products: ReturnType<typeof usePersistentData>['data']['products']
  purchases: Purchase[]
  onAdd: (p: Purchase) => void
  canCreate: boolean
}) {
  const location = useLocation(),
    [open, setOpen] = useState(() => new URLSearchParams(location.search).get('new') === '1'),
    [search, setSearch] = useState(''),
    navigate = useNavigate()
  const [form, setForm] = useState({
    supplier: 'Getz Pharma',
    product: products[0].name,
    qty: 10,
    status: 'Posted',
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const product = products.find((p) => p.name === form.product)!
    onAdd({
      id: `PUR-2026-${String(185 + purchases.length).padStart(4, '0')}`,
      date: '30 Aug 2026',
      supplier: form.supplier,
      product: form.product,
      qty: Number(form.qty),
      amount: Number(form.qty) * product.cost,
      status: form.status as Purchase['status'],
      batch: product.batch,
      expiry: product.expiry,
      unitCost: product.cost,
    })
    setOpen(false)
  }
  const rows = purchases.filter((x) =>
    Object.values(x).join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <>
      <PageHead
        eyebrow="Trading & Inventory / Purchasing"
        title="Purchases"
        description="Receive supplier invoices and post stock in one controlled workflow."
        actions={
          <Button disabled={!canCreate} onClick={() => setOpen(true)}>
            <Plus /> New purchase
          </Button>
        }
      />
      <div className="kpi-grid mini">
        <Kpi
          label="Purchases this month"
          value="Rs 2.46m"
          change="8.2% vs July"
          icon={ShoppingBag}
        />
        <Kpi
          label="Open payables"
          value="Rs 784k"
          change="14 suppliers"
          icon={ReceiptText}
          tone="teal"
        />
        <Kpi
          label="Draft invoices"
          value="6"
          change="Rs 114k pending"
          icon={FileText}
          tone="yellow"
        />
      </div>
      <div className="toolbar">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search purchase or supplier..."
        />
        <Button kind="secondary">
          <Filter /> Filter
        </Button>
      </div>
      <Panel title="Purchase register" sub="Newest supplier invoices first">
        <Table
          headers={[
            'Purchase no.',
            'Date',
            'Supplier',
            'Product',
            'Quantity',
            'Amount',
            'Status',
            '',
          ]}
          rows={rows.map((p) => [
            <button className="linkable" onClick={() => navigate(`/purchases/${p.id}`)}>
              {p.id}
            </button>,
            p.date,
            p.supplier,
            p.product,
            p.qty,
            <b>{money(p.amount)}</b>,
            <Badge tone={p.status === 'Posted' ? 'good' : 'warn'}>{p.status}</Badge>,
            <button
              aria-label={`View ${p.id}`}
              className="table-action"
              onClick={() => navigate(`/purchases/${p.id}`)}
            >
              <Eye /> View
            </button>,
          ])}
        />
      </Panel>
      {open && (
        <Modal title="Create purchase invoice" onClose={() => setOpen(false)} wide>
          <form onSubmit={submit}>
            <div className="steps">
              <span className="current">
                <i>1</i>Invoice details
              </span>
              <span>
                <i>2</i>Review
              </span>
              <span>
                <i>3</i>Post stock
              </span>
            </div>
            <div className="form-grid">
              <label>
                Supplier
                <select
                  value={form.supplier}
                  onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                >
                  <option>Getz Pharma</option>
                  <option>GlaxoSmithKline</option>
                  <option>Abbott Laboratories</option>
                  <option>The Searle Company</option>
                </select>
              </label>
              <label>
                Invoice date
                <input type="date" defaultValue="2026-08-30" />
              </label>
              <label className="span-2">
                Product
                <select
                  value={form.product}
                  onChange={(e) => setForm({ ...form, product: e.target.value })}
                >
                  {products.map((p) => (
                    <option key={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Quantity
                <input
                  min="1"
                  type="number"
                  value={form.qty}
                  onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
                />
              </label>
              <label>
                Posting status
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option>Posted</option>
                  <option>Draft</option>
                </select>
              </label>
            </div>
            <div className="summary-strip">
              <span>
                Selected item<b>{form.product}</b>
              </span>
              <span>
                Stock impact<b>+{form.qty} packs</b>
              </span>
              <span>
                Estimated total
                <b>
                  {money(form.qty * (products.find((p) => p.name === form.product)?.cost || 0))}
                </b>
              </span>
            </div>
            <div className="modal-foot">
              <Button kind="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <Check /> Save purchase
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

// ─── Sales: helpers, invoice document, print modal ───────────────────────────

/** Amount in words — display only, purely presentational, no financial logic */
function amountInWords(amount: number): string {
  const n = Math.round(amount)
  if (n === 0) return 'Zero Rupees Only'
  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ]
  const tens_ = [
    '',
    '',
    'Twenty',
    'Thirty',
    'Forty',
    'Fifty',
    'Sixty',
    'Seventy',
    'Eighty',
    'Ninety',
  ]
  function w(x: number): string {
    if (x <= 0) return ''
    if (x < 20) return ones[x] + ' '
    if (x < 100) return tens_[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '') + ' '
    return ones[Math.floor(x / 100)] + ' Hundred ' + w(x % 100)
  }
  function conv(x: number): string {
    if (x >= 10000000) return w(Math.floor(x / 10000000)) + 'Crore ' + conv(x % 10000000)
    if (x >= 100000) return w(Math.floor(x / 100000)) + 'Lakh ' + conv(x % 100000)
    if (x >= 1000) return w(Math.floor(x / 1000)) + 'Thousand ' + conv(x % 1000)
    return w(x)
  }
  return conv(n).trim() + ' Rupees Only'
}

const BT_COMPANY = {
  name: 'Bhatti Traders',
  address: 'Anarkali Bazar, Lahore, Pakistan',
  phone: '042-3578-2210',
  ntn: '1234567-8',
  strn: '01-23-4567-001-41',
}

/** A single A4-style invoice document for print */
function InvoiceDoc({ sale, products }: { sale: Sale; products: Product[] }) {
  const prod = products.find((p) => p.name === sale.product)
  const cust = seedMasters.find((m) => m.name === sale.customer)
  // Display rate derived from server total ÷ qty — preview only, not a kernel figure
  const dispRate = sale.qty > 0 ? Math.round(sale.amount / sale.qty) : 0
  const fmt2 = (v: number) =>
    v.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="inv-doc">
      {/* ── Company header ── */}
      <div className="inv-doc-header">
        <div>
          <div className="inv-co-name">{BT_COMPANY.name}</div>
          <div className="inv-co-detail">{BT_COMPANY.address}</div>
          <div className="inv-co-detail">
            Tel: {BT_COMPANY.phone} &nbsp;·&nbsp; NTN: {BT_COMPANY.ntn}
          </div>
          <div className="inv-co-detail">STRN: {BT_COMPANY.strn}</div>
        </div>
        <div className="inv-doc-type">
          <div className="inv-type-label">TAX INVOICE</div>
          <div className="inv-doc-no">{sale.id}</div>
        </div>
      </div>

      {/* ── Bill-to + invoice meta ── */}
      <div className="inv-bill-row">
        <div className="inv-bill-to">
          <div className="inv-bill-label">Bill To</div>
          <div className="inv-bill-name">{sale.customer}</div>
          {cust && (
            <div className="inv-bill-addr">
              {[cust.extra?.area, cust.city].filter(Boolean).join(', ')}
            </div>
          )}
          {cust?.extra?.ntn && <div className="inv-bill-ntn">NTN: {cust.extra.ntn}</div>}
          {cust?.contact && <div className="inv-bill-contact">Tel: {cust.contact}</div>}
        </div>
        <div className="inv-meta-grid">
          <div>
            <span>Invoice No</span>
            <b>{sale.id}</b>
          </div>
          <div>
            <span>Date</span>
            <b>{sale.date}</b>
          </div>
          <div>
            <span>Mode</span>
            <b>{sale.mode}</b>
          </div>
          <div>
            <span>Status</span>
            <b className={sale.status === 'Paid' ? 'inv-status-paid' : 'inv-status-credit'}>
              {sale.status}
            </b>
          </div>
        </div>
      </div>

      {/* ── Line table ── */}
      <table className="inv-lines">
        <thead>
          <tr>
            <th className="inv-col-num">#</th>
            <th>Product / Description</th>
            <th>Batch</th>
            <th className="r">Qty</th>
            <th className="r">Rate</th>
            <th className="r">Amount (Rs)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="inv-col-num">1</td>
            <td>
              <b>{sale.product}</b>
              {prod?.generic && <small>{prod.generic}</small>}
            </td>
            <td>{sale.batch}</td>
            <td className="r">{sale.qty}</td>
            <td className="r">{dispRate.toLocaleString('en-PK')}</td>
            <td className="r inv-line-total">{fmt2(sale.amount)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr className="inv-total-row">
            <td colSpan={5} className="r inv-total-label">
              Net Payable
            </td>
            <td className="r inv-total-val">{fmt2(sale.amount)}</td>
          </tr>
        </tfoot>
      </table>

      {/* ── Amount in words ── */}
      <div className="inv-words-row">
        <span className="inv-words-label">Amount in Words:</span>
        <span className="inv-words-text">{amountInWords(sale.amount)}</span>
      </div>

      {/* ── Preview disclaimer ── */}
      <div className="inv-preview-note">
        ⓘ Rates shown are indicative (preview). Authoritative fiscal figures are in the posted
        ledger.
      </div>

      {/* ── Signature block ── */}
      <div className="inv-sigs">
        <div className="inv-sig">
          <div className="inv-sig-line" />
          <div className="inv-sig-role">Authorised Signatory</div>
          <div className="inv-sig-for">{BT_COMPANY.name}</div>
        </div>
        <div className="inv-sig">
          <div className="inv-sig-line" />
          <div className="inv-sig-role">Received By</div>
          <div className="inv-sig-for">Date: _______________</div>
        </div>
      </div>

      {/* ── Doc footer ── */}
      <div className="inv-doc-footer">
        <span>
          Generated ·{' '}
          {new Date().toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
        <span>{BT_COMPANY.name} — Computer-generated document</span>
      </div>
    </div>
  )
}

/** Full-screen print preview modal */
function SalesPrintModal({
  targets,
  products,
  onClose,
}: {
  targets: Sale[]
  products: Product[]
  onClose: () => void
}) {
  return (
    <div className="sr-print-overlay" role="dialog" aria-modal aria-label="Print invoice preview">
      {/* Chrome — hidden by @media print */}
      <div className="sr-print-chrome">
        <div className="sr-print-chrome-inner">
          <div>
            <div className="sr-print-title">
              {targets.length === 1
                ? `Invoice Preview — ${targets[0].id}`
                : `Preview — ${targets.length} invoices`}
            </div>
            <div className="sr-print-sub">
              Review before printing. Navigation is hidden in the printed output.
            </div>
          </div>
          <div className="sr-print-actions">
            <button type="button" className="btn secondary" onClick={onClose}>
              <X /> Close
            </button>
            <button type="button" className="btn primary" onClick={() => window.print()}>
              <Printer /> Print
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable preview — becomes print body */}
      <div className="sr-print-body">
        <div className="inv-print-content">
          {targets.map((sale) => (
            <InvoiceDoc key={sale.id} sale={sale} products={products} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Sales register ──────────────────────────────────────────────────────────

export function Sales({
  products,
  sales,
  onAdd,
  canCreate,
}: {
  products: ReturnType<typeof usePersistentData>['data']['products']
  sales: Sale[]
  onAdd: (p: Sale) => void
  canCreate: boolean
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('new') === '1')
  const [tab, setTab] = useState('All sales')
  const [form, setForm] = useState({
    mode: 'Retail',
    customer: 'Walk-in Customer',
    product: products[0].name,
    qty: 1,
    status: 'Paid',
  })

  // ── selection & print state ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [printTargets, setPrintTargets] = useState<Sale[]>([])
  const [printOpen, setPrintOpen] = useState(false)

  const visible = sales.filter((s) => tab === 'All sales' || s.status === tab)
  const allSelected = visible.length > 0 && visible.every((s) => selected.has(s.id))
  const someSelected = visible.some((s) => selected.has(s.id)) && !allSelected
  const selectedInView = visible.filter((s) => selected.has(s.id))

  const allCheckRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (allCheckRef.current) allCheckRef.current.indeterminate = someSelected
  }, [someSelected])

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((x) => x.id)))
  const openPrint = (targets: Sale[]) => {
    setPrintTargets(targets)
    setPrintOpen(true)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const product = products.find((p) => p.name === form.product)!
    if (form.qty > product.stock) return
    const fefo = [...product.batches]
      .filter((b) => b.stock > 0)
      .sort((a, b) => a.expiry.localeCompare(b.expiry))[0]
    onAdd({
      id: `INV-${26815 + sales.length}`,
      date: '30 Aug 2026',
      customer: form.customer,
      product: form.product,
      qty: Number(form.qty),
      amount: Number(form.qty) * product.price,
      mode: form.mode,
      status: form.status as Sale['status'],
      batch: fefo?.id ?? product.batch,
      unitCost: fefo?.cost ?? product.cost,
    })
    setOpen(false)
  }

  return (
    <div className={printOpen ? 'sr-page sr-has-print' : 'sr-page'}>
      {/* ── Page header ── */}
      <PageHead
        eyebrow="Trading & Inventory / Sales & POS"
        title="Sales & point of sale"
        description="Process retail, wholesale, hospital and clinic sales with FEFO allocation."
        actions={
          <>
            <Button kind="secondary" onClick={() => navigate('/sales/voucher')}>
              <FileText /> Sales voucher
            </Button>
            <Button disabled={!canCreate} onClick={() => setOpen(true)}>
              <Plus /> New sale
            </Button>
          </>
        }
      />

      {/* ── KPIs ── */}
      <div className="kpi-grid mini">
        <Kpi label="Sales today" value="Rs 192,480" change="84 invoices" icon={CircleDollarSign} />
        <Kpi
          label="Cash received"
          value="Rs 128,200"
          change="66.6% of sales"
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Credit sales"
          value="Rs 64,280"
          change="18 invoices"
          icon={ReceiptText}
          tone="yellow"
        />
      </div>

      {/* ── Tabs ── */}
      <div className="tabs">
        {['All sales', 'Paid', 'Credit'].map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => {
              setTab(t)
              setSelected(new Set())
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Bulk action bar (visible when rows are selected) ── */}
      {selectedInView.length > 0 && (
        <div className="sr-bulk-bar" role="toolbar" aria-label="Bulk actions for selected invoices">
          <span className="sr-bulk-count">
            {selectedInView.length} invoice{selectedInView.length !== 1 ? 's' : ''} selected
          </span>
          <button
            type="button"
            className="sr-bulk-print-btn"
            onClick={() => openPrint(selectedInView)}
          >
            <Printer /> Print invoice{selectedInView.length !== 1 ? 's' : ''}
          </button>
          <button
            type="button"
            className="sr-bulk-clear-btn"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
          >
            <X /> Clear
          </button>
        </div>
      )}

      {/* ── Sales register table ── */}
      <Panel
        title="Sales register"
        sub={`${visible.length} matching invoice${visible.length !== 1 ? 's' : ''}`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sr-cb-col" aria-label="Select">
                  <input
                    ref={allCheckRef}
                    type="checkbox"
                    className="sr-cb"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={
                      allSelected ? 'Deselect all visible invoices' : 'Select all visible invoices'
                    }
                  />
                </th>
                <th>Invoice</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Mode</th>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Quantity</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id} className={selected.has(s.id) ? 'sr-row-sel' : ''}>
                  <td className="sr-cb-col">
                    <input
                      type="checkbox"
                      className="sr-cb"
                      checked={selected.has(s.id)}
                      onChange={() => toggleOne(s.id)}
                      aria-label={`Select invoice ${s.id}`}
                    />
                  </td>
                  <td>
                    <button className="linkable" onClick={() => navigate(`/sales/${s.id}`)}>
                      {s.id}
                    </button>
                  </td>
                  <td>{s.date}</td>
                  <td>{s.customer}</td>
                  <td>
                    <Badge tone="info">{s.mode}</Badge>
                  </td>
                  <td>{s.product}</td>
                  <td style={{ textAlign: 'right' }}>{s.qty}</td>
                  <td style={{ textAlign: 'right' }}>
                    <b>{money(s.amount)}</b>
                  </td>
                  <td>
                    <Badge tone={s.status === 'Paid' ? 'good' : 'warn'}>{s.status}</Badge>
                  </td>
                  <td>
                    <div className="sr-row-actions">
                      <button
                        type="button"
                        className="sr-icon-print-btn"
                        aria-label={`Print invoice ${s.id}`}
                        title="Print invoice"
                        onClick={() => openPrint([s])}
                      >
                        <Printer />
                      </button>
                      <button
                        type="button"
                        aria-label={`View ${s.id}`}
                        className="table-action"
                        onClick={() => navigate(`/sales/${s.id}`)}
                      >
                        <Eye /> View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── New sale modal ── */}
      {open && (
        <Modal title="New sales invoice" onClose={() => setOpen(false)} wide>
          <form onSubmit={submit}>
            <div className="mode-picker">
              {['Retail', 'Wholesale'].map((m) => (
                <button
                  type="button"
                  key={m}
                  className={form.mode === m ? 'active' : ''}
                  onClick={() =>
                    setForm({
                      ...form,
                      mode: m,
                      customer: m === 'Retail' ? 'Walk-in Customer' : form.customer,
                    })
                  }
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="form-grid">
              <label>
                Customer
                <input
                  value={form.customer}
                  onChange={(e) => setForm({ ...form, customer: e.target.value })}
                />
              </label>
              <label>
                Payment
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option>Paid</option>
                  <option>Credit</option>
                </select>
              </label>
              <label className="span-2">
                Product / FEFO batch
                <select
                  value={form.product}
                  onChange={(e) => setForm({ ...form, product: e.target.value })}
                >
                  {products
                    .filter((p) => p.stock > 0)
                    .map((p) => (
                      <option key={p.id}>
                        {p.name} — {p.batch} — {p.stock} available
                      </option>
                    ))}
                </select>
                <small className="field-note">
                  <Sparkles /> Earliest valid expiry is automatically selected
                </small>
              </label>
              <label>
                Quantity
                <input
                  type="number"
                  min="1"
                  max={products.find((p) => p.name === form.product)?.stock}
                  value={form.qty}
                  onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
                />
              </label>
              <label>
                Unit price
                <input
                  readOnly
                  value={money(products.find((p) => p.name === form.product)?.price || 0)}
                />
              </label>
            </div>
            <div className="invoice-total">
              <span>Invoice total</span>
              <b>{money(form.qty * (products.find((p) => p.name === form.product)?.price || 0))}</b>
            </div>
            <div className="modal-foot">
              <Button kind="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <Check /> Post sale
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Print preview overlay ── */}
      {printOpen && (
        <SalesPrintModal
          targets={printTargets}
          products={products}
          onClose={() => setPrintOpen(false)}
        />
      )}
    </div>
  )
}

export function Masters({
  masters,
  onAddMaster,
  canCreate,
}: {
  masters: Master[]
  onAddMaster: (m: Master) => void
  canCreate: boolean
}) {
  const loc = useLocation()
  const [tab, setTab] = useState('Accounts & parties'),
    [query, setQuery] = useState(''),
    navigate = useNavigate(),
    [open, setOpen] = useState(new URLSearchParams(loc.search).get('new'))
  const typeOf = (t: string) =>
    t === 'Banks'
      ? 'Bank'
      : t === 'Departments'
        ? 'Department'
        : t === 'Doctors'
          ? 'Doctor'
          : t === 'Locations'
            ? 'Account'
            : 'Account'
  const rows = masters
    .filter((m) =>
      `${m.code} ${m.name} ${m.type} ${m.balanceType}`.toLowerCase().includes(query.toLowerCase()),
    )
    .filter(
      (m) =>
        tab === 'Accounts & parties' ||
        (tab === 'Banks' && m.type === 'Bank') ||
        (tab === 'Departments' && m.type === 'Department') ||
        (tab === 'Doctors' && m.type === 'Doctor'),
    )
  return (
    <>
      <PageHead
        eyebrow="Masters / Business masters"
        title="Business masters"
        description="One reliable directory for accounts, parties, locations and classifications."
        actions={
          <Button disabled={!canCreate} onClick={() => setOpen('all')}>
            <Plus /> Add master record
          </Button>
        }
      />
      <div className="tabs">
        {['Accounts & parties', 'Locations', 'Banks', 'Departments', 'Doctors'].map((t) => (
          <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
            {t}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} />
        <Button kind="secondary">
          <Download /> Export
        </Button>
      </div>
      <Panel title={tab} sub={`${rows.length} active records`}>
        <Table
          headers={['Code', 'Name', 'Record type', 'Balance type', 'Status', '']}
          rows={rows.map((m) => [
            <b>{m.code}</b>,
            <button className="linkable" onClick={() => navigate(`/masters/${m.code}`)}>
              {m.name}
            </button>,
            m.type,
            m.balanceType,
            <Badge tone={m.status === 'Active' ? 'good' : 'warn'}>{m.status}</Badge>,
            <button
              aria-label={`Details ${m.name}`}
              className="table-action"
              onClick={() => navigate(`/masters/${m.code}`)}
            >
              <Eye /> Details
            </button>,
          ])}
        />
      </Panel>
      {open && (
        <MasterModal
          open={!!open}
          list={masters}
          presetType={
            { customer: 'Customer', vendor: 'Supplier', account: 'Account', account2: 'Account' }[
              open
            ] ?? (open === 'all' ? typeOf(tab) : 'Account')
          }
          onClose={() => {
            setOpen(null)
            navigate('/masters', { replace: true })
          }}
          onSave={onAddMaster}
        />
      )}
    </>
  )
}
export function Procurement() {
  const [checked, setChecked] = useState<string[]>([])
  const items = [
    ['Augmentin 625mg', 42, 60, 80, 'Getz Pharma'],
    ['Calpol Suspension', 18, 30, 48, 'Sami Pharmaceuticals'],
    ['Humulin 70/30', 12, 20, 30, 'The Searle Company'],
    ['Ventolin Inhaler', 31, 35, 52, 'GlaxoSmithKline'],
  ]
  return (
    <>
      <PageHead
        eyebrow="Trading & Inventory / Demand & PO"
        title="Smart procurement"
        description="Turn reorder signals into supplier-ready purchase orders."
        actions={
          <Button>
            <Plus /> Create purchase order
          </Button>
        }
      />
      <div className="procurement-callout">
        <span>
          <Sparkles />
        </span>
        <div>
          <b>Finsoft found 4 replenishment opportunities</b>
          <p>
            Suggested quantities consider reorder levels, current stock and recent sales velocity.
          </p>
        </div>
        <Button kind="secondary">Review logic</Button>
      </div>
      <Panel
        title="Reorder suggestions"
        sub={`${checked.length} selected · suggested order value Rs 128,640`}
        action={
          <Button kind="secondary">
            <ClipboardCheck /> Convert selected
          </Button>
        }
      >
        <Table
          headers={[
            '',
            'Product',
            'Current',
            'Reorder at',
            'Suggested qty',
            'Preferred supplier',
            'Priority',
          ]}
          rows={items.map((r) => [
            <input
              type="checkbox"
              checked={checked.includes(String(r[0]))}
              onChange={() =>
                setChecked((x) =>
                  x.includes(String(r[0])) ? x.filter((v) => v !== r[0]) : [...x, String(r[0])],
                )
              }
            />,
            <b>{r[0]}</b>,
            r[1],
            r[2],
            r[3],
            r[4],
            <Badge tone={Number(r[1]) < 20 ? 'danger' : 'warn'}>
              {Number(r[1]) < 20 ? 'Critical' : 'Medium'}
            </Badge>,
          ])}
        />
      </Panel>
      <div className="lower-grid">
        <Panel title="Purchase order pipeline" sub="August 2026">
          <div className="pipeline">
            <div>
              <b>8</b>
              <span>Draft</span>
            </div>
            <ArrowRight />
            <div>
              <b>5</b>
              <span>Sent</span>
            </div>
            <ArrowRight />
            <div>
              <b>3</b>
              <span>Part received</span>
            </div>
            <ArrowRight />
            <div>
              <b>21</b>
              <span>Received</span>
            </div>
          </div>
        </Panel>
        <Panel title="Supplier performance" sub="On-time delivery rate">
          <div className="supplier-bars">
            <p>
              <span>Getz Pharma</span>
              <b>96%</b>
            </p>
            <i>
              <em style={{ width: '96%' }} />
            </i>
          </div>
          <div className="supplier-bars">
            <p>
              <span>GSK Pakistan</span>
              <b>91%</b>
            </p>
            <i>
              <em style={{ width: '91%' }} />
            </i>
          </div>
          <div className="supplier-bars">
            <p>
              <span>Abbott Labs</span>
              <b>86%</b>
            </p>
            <i>
              <em style={{ width: '86%' }} />
            </i>
          </div>
        </Panel>
      </div>
    </>
  )
}

export function HR({
  employees,
  onAddEmployee,
  canCreate,
}: {
  employees: string[][]
  onAddEmployee: (e: string[]) => void
  canCreate: boolean
}) {
  const [tab, setTab] = useState('Employees'),
    navigate = useNavigate(),
    [open, setOpen] = useState(false)
  return (
    <>
      <PageHead
        eyebrow="HR & Payroll / Employees"
        title="HR & payroll"
        description="Bring attendance, compensation and sales performance into one workspace."
        actions={
          <>
            <Button kind="secondary">
              <CalendarDays /> Mark attendance
            </Button>
            <Button disabled={!canCreate} onClick={() => setOpen(true)}>
              <Plus /> Add employee
            </Button>
          </>
        }
      />
      <div className="kpi-grid">
        <Kpi
          label="Total employees"
          value={String(employees.length)}
          change="On the register"
          icon={Users}
        />
        <Kpi
          label="Payroll · August"
          value="Rs 6.24m"
          change="Processing on 31 Aug"
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Field sales team"
          value="18"
          change="84% target achieved"
          icon={TrendingUp}
          tone="blue"
        />
        <Kpi
          label="On leave"
          value={String(employees.filter((r) => r[5] === 'Leave').length)}
          change="2 approvals pending"
          icon={CalendarDays}
          tone="yellow"
        />
      </div>
      <div className="tabs">
        {[
          'Employees',
          'Attendance',
          'Payroll',
          'Sales targets',
          'Allowances',
          'Final settlement',
        ].map((t) => (
          <button
            onClick={() => (t === 'Payroll' ? navigate('/hr/payroll') : setTab(t))}
            className={tab === t ? 'active' : ''}
            key={t}
          >
            {t}
          </button>
        ))}
      </div>
      <Panel title={tab} sub="August 2026 cycle">
        <Table
          headers={['Employee ID', 'Employee', 'Designation', 'Branch', 'Gross salary', 'Today']}
          rows={employees.map((r) => [
            <button className="linkable" onClick={() => navigate(`/hr/employees/${r[0]}`)}>
              {r[0]}
            </button>,
            <button className="linkable" onClick={() => navigate(`/hr/employees/${r[0]}`)}>
              {r[1]}
            </button>,
            r[2],
            r[3],
            <b>{r[4]}</b>,
            <Badge tone={r[5] === 'Present' ? 'good' : r[5] === 'Field' ? 'info' : 'warn'}>
              {r[5]}
            </Badge>,
          ])}
        />
      </Panel>
      {open && (
        <EmployeeFormModal
          open={open}
          list={employees}
          onClose={() => setOpen(false)}
          onSave={onAddEmployee}
        />
      )}
    </>
  )
}
export function Admin({
  // Neither is read any more — the Roles & permissions tab's switcher (the only thing
  // that ever called setRole, or compared against role) was removed (Security seat
  // condition 2). Kept in the signature since every caller (admin-audit/page.tsx,
  // admin/page.tsx, admin-roles/page.tsx) still passes them from app-context.tsx's mock
  // store, which other, still-mock parts of the app continue to read.
  role: _role,
  setRole: _setRole,
  initialTab = 'Users',
}: {
  role: string
  setRole: (r: string) => void
  initialTab?: string
}) {
  const [tab, setTab] = useState(initialTab),
    navigate = useNavigate()
  const { can } = useAuth()
  return (
    <>
      <PageHead
        eyebrow="System / Administration"
        title="Admin & control"
        description="Manage people, permissions, periods and every security-sensitive action."
        actions={
          // "Invite user" has no endpoint behind it yet — shown disabled (Button's own
          // "coming later" title) to a holder of admin.user_manage, hidden for anyone else,
          // rather than offered as if it worked (M4-W course correction).
          can('admin.user_manage') ? (
            <Button disabled>
              <Plus /> Invite user
            </Button>
          ) : undefined
        }
      />
      {/* M4-W: the old banner claimed 2FA coverage and a security score neither of which
          exist (MFA is GAP-003) — removed. Its slot stays in the layout; only the Audit log
          tab has real data to say something honest with. Every other tab is still mock, so
          the slot is simply empty there rather than showing invented content. */}
      {tab === 'Audit log' && (
        <div className="admin-banner">
          <span>
            <ShieldCheck />
          </span>
          <div>
            <b>Audit trail</b>
            <p>Every security-sensitive action, in order, with a tamper-evident hash chain.</p>
          </div>
        </div>
      )}
      <div className="tabs">
        {[
          'Users',
          'Roles & permissions',
          'Fiscal periods',
          'Security',
          'Active sessions',
          'Audit log',
        ].map((t) => (
          <button onClick={() => setTab(t)} className={tab === t ? 'active' : ''} key={t}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Roles & permissions' ? (
        // Security seat condition 2: no more role switching from here — this used to
        // call the mock setRole(name) on click, letting anyone browsing Admin flip which
        // role the whole app (including still-mock screens' module gates) behaved as,
        // with nothing clearing it on sign-out. Read-only now: what each role grants,
        // not a control.
        <Panel title="Roles" sub="What each role grants">
          <div className="role-cards">
            {Object.entries(roles).map(([name, permissions]) => (
              <div className="role-card-static" key={name}>
                <span>{name.slice(0, 2).toUpperCase()}</span>
                <div>
                  <b>{name}</b>
                  <small>
                    {permissions.includes('all')
                      ? 'Full system access'
                      : `${permissions.length} modules enabled`}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : tab === 'Active sessions' ? (
        <Panel title="Active sessions" sub="All signed-in devices across branches">
          <Table
            headers={['User', 'Role', 'Device', 'Location', 'Last active', 'Status']}
            rows={users.flatMap((u) =>
              u.sessions.map((s) => [
                <button className="linkable" onClick={() => navigate(`/admin/users/${u.id}`)}>
                  {u.name}
                </button>,
                u.role,
                s.device,
                s.location,
                s.lastActive,
                <Badge tone={u.status === 'Active' ? 'good' : 'warn'}>{u.status}</Badge>,
              ]),
            )}
          />
        </Panel>
      ) : tab === 'Audit log' ? (
        <AuditLogPanel />
      ) : (
        <Panel title={tab} sub="Administration records">
          <Table
            headers={['User', 'Role', 'Branch', '2FA', 'Status']}
            rows={users.map((u) => [
              <button className="linkable" onClick={() => navigate(`/admin/users/${u.id}`)}>
                {u.name}
              </button>,
              u.role,
              u.branch,
              u.twoFactor ? <Badge tone="good">Enabled</Badge> : <Badge tone="warn">Off</Badge>,
              <Badge tone={u.status === 'Active' ? 'good' : 'warn'}>{u.status}</Badge>,
            ])}
          />
        </Panel>
      )}
    </>
  )
}

/**
 * The "Audit log" tab of `Admin`, wired to the real `GET /api/audit` (M4-W). The mock's
 * `Panel` + `Table` structure stays; only the data source, and the filters/pagination the
 * real contract needs, are new — audit-trail/README.md §2's FilterBar and cursor pager.
 * Viewers hold no `audit.view` (a privileged permission, catalog.ts), so this checks
 * `can('audit.view')` before ever calling the API and shows a Denied panel instead — never
 * a blank table that quietly 403s and redirects (docs/design-system/04-states.md §5).
 */
/** The filters `AuditLogPanel` actually queries with — set only by Apply/Reset, never live
 * on every keystroke, matching the Customers filter bar's own Apply Filters/Reset pattern. */
interface AuditFilters {
  from: string
  to: string
  action: string
  entityType: string
}
const EMPTY_AUDIT_FILTERS: AuditFilters = { from: '', to: '', action: '', entityType: '' }

function AuditLogPanel() {
  const { can, user } = useAuth()
  const allowed = can('audit.view')
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [pages, setPages] = useState<AuditPage[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)

  const query = (cursor?: string) => ({
    from: applied.from ? new Date(applied.from).toISOString() : undefined,
    // Exclusive start-of-next-local-day, not the selected day's own midnight UTC — see
    // nextLocalDayIso's own comment (Security seat condition 4: the selected day was
    // being excluded in any timezone ahead of UTC, Pakistan included).
    to: applied.to ? nextLocalDayIso(applied.to) : undefined,
    action: applied.action || undefined,
    entityType: applied.entityType || undefined,
    limit: 50,
    cursor,
  })

  const { state, reload } = useApiQuery(
    () => (allowed ? listAuditEvents(query()) : Promise.reject(new Error('denied'))),
    [allowed, applied],
  )

  useEffect(() => {
    if (state.status === 'ready') setPages([state.data])
  }, [state])

  if (!allowed) {
    return (
      <Panel title="Audit log" sub="Security-sensitive actions across the organisation">
        <div className="empty-state" role="alert">
          Your role does not have permission to view the audit trail.
        </div>
      </Panel>
    )
  }

  const lastPage = pages[pages.length - 1]
  const items = pages.flatMap((p) => p.items)
  const loadMore = () => {
    if (!lastPage?.nextCursor) return
    setLoadingMore(true)
    setLoadMoreError(null)
    listAuditEvents(query(lastPage.nextCursor)).then(
      (page) => {
        setPages((prev) => [...prev, page])
        setLoadingMore(false)
      },
      () => {
        // A fixed, plain-language message rather than the server's own — consistent with
        // the main load error above, and with not surfacing a technical message to an
        // end user.
        setLoadingMore(false)
        setLoadMoreError('Could not load more audit events. Try again.')
      },
    )
  }
  const applyFilters = () => setApplied(draft)
  const resetFilters = () => {
    setDraft(EMPTY_AUDIT_FILTERS)
    setApplied(EMPTY_AUDIT_FILTERS)
  }
  /**
   * Design-system seat: DENIED and FAIL are not the same outcome — a permission denial
   * (the user did something they are not allowed to) is a `warn`, not a `danger`; a
   * genuine failure (the action itself broke) is the `danger`. Collapsing them both into
   * "Denied" mislabelled real failures as access-control events.
   */
  const outcomeOf = (ev: AuditEvent): { tone: 'good' | 'warn' | 'danger'; label: string } => {
    const a = ev.action.toUpperCase()
    if (a.includes('DENIED')) return { tone: 'warn', label: 'Denied' }
    if (a.includes('FAIL')) return { tone: 'danger', label: 'Failed' }
    return { tone: 'good', label: 'Success' }
  }

  return (
    <Panel title="Audit log" sub="Security-sensitive actions across the organisation, newest first">
      <div className="form-grid" style={{ marginBottom: 16 }}>
        <Field label="From" htmlFor="audit-from">
          <input
            id="audit-from"
            className="text-input"
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            max={draft.to || todayIso()}
          />
        </Field>
        <Field label="To" htmlFor="audit-to">
          <input
            id="audit-to"
            className="text-input"
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            max={todayIso()}
          />
        </Field>
        <Field label="Action" htmlFor="audit-action" helper="e.g. CUSTOMER_CREATED">
          <TextInput
            id="audit-action"
            value={draft.action}
            onChange={(v) => setDraft({ ...draft, action: v })}
          />
        </Field>
        <Field label="Entity type" htmlFor="audit-entity-type" helper="e.g. customer">
          <TextInput
            id="audit-entity-type"
            value={draft.entityType}
            onChange={(v) => setDraft({ ...draft, entityType: v })}
          />
        </Field>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <Button onClick={applyFilters}>Apply filters</Button>
          <Button kind="secondary" onClick={resetFilters}>
            Reset
          </Button>
        </div>
      </div>

      {state.status === 'loading' && <div className="empty-state">Loading audit events…</div>}
      {state.status === 'error' && (
        <div className="empty-state" role="alert">
          We could not load the audit trail.{' '}
          <button className="linkable" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' && items.length === 0 && (
        <div className="empty-state">
          No audit events for {applied.from || 'the start'} to {applied.to || 'today'} with these
          filters.
        </div>
      )}
      {state.status === 'ready' && items.length > 0 && (
        <>
          <Table
            headers={['Timestamp', 'User', 'Action', 'Entity', 'Detail', 'Outcome']}
            rows={items.map((ev) => {
              const outcome = outcomeOf(ev)
              return [
                <time dateTime={ev.occurredAt}>
                  {ev.occurredAt.replace('T', ' ').slice(0, 19)}
                </time>,
                // No title/tooltip with the full actor id — Security seat condition 3: it
                // leaked the raw uuid on hover even though the cell itself shows a short
                // label.
                actorLabel(ev.actorUserId, user?.id),
                humanizeAction(ev.action),
                `${ev.entityType} · ${entityLabel(ev.entityId)}`,
                humanizeAction(ev.action),
                <Badge tone={outcome.tone}>{outcome.label}</Badge>,
              ]
            })}
          />
          {lastPage?.nextCursor && (
            <div style={{ textAlign: 'center', margin: '12px 0' }}>
              {loadMoreError && (
                <div className="empty-state" role="alert" style={{ marginBottom: 8 }}>
                  {loadMoreError}
                </div>
              )}
              <Button kind="secondary" onClick={loadMore} busy={loadingMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
