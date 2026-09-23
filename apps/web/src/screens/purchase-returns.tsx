'use client'
import { useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Barcode,
  Box,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Download,
  Ellipsis,
  Eye,
  FileText,
  PackageOpen,
  Plus,
  Printer,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react'
import type { PurchaseReturn, PurchaseReturnLine } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type EditLine = PurchaseReturnLine & { key: number }
const blank = (key: number): EditLine => ({
  key,
  product: '',
  pack: '',
  batch: '',
  expiry: '',
  rate: 0,
  qty: 0,
  bonus: 0,
  discount: 0,
  gst: 0,
})
const fmt = (n: number) =>
  n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isoToday = () => new Date().toISOString().slice(0, 10)
const showDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
const dateKey = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
const lineAmount = (line: PurchaseReturnLine) =>
  Math.max(0, line.rate * line.qty * (1 - line.discount / 100) * (1 + line.gst / 100))

export function PurchaseReturns({
  data,
  onAdd,
}: {
  data: AppData
  onAdd: (entry: PurchaseReturn) => void
}) {
  const editor = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(''),
    [supplierFilter, setSupplierFilter] = useState('All'),
    [paymentFilter, setPaymentFilter] = useState('All'),
    [statusFilter, setStatusFilter] = useState('All'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [page, setPage] = useState(1),
    [expanded, setExpanded] = useState<string | null>(data.purchaseReturns[0]?.id ?? null)
  const [supplier, setSupplier] = useState(''),
    [returnDate, setReturnDate] = useState(isoToday()),
    [bill, setBill] = useState(''),
    [reference, setReference] = useState(''),
    [remarks, setRemarks] = useState(''),
    [paymentType, setPaymentType] = useState<'Cash' | 'Credit'>('Cash')
  const [lines, setLines] = useState<EditLine[]>([blank(1)]),
    [notice, setNotice] = useState(''),
    [tab, setTab] = useState('Return Items')
  const suppliers = [
    ...new Set([
      ...data.purchases.map((p) => p.supplier),
      ...data.masters.filter((m) => m.type === 'Supplier').map((m) => m.name),
    ]),
  ]
  const counts = (status: string) =>
    status === 'All'
      ? data.purchaseReturns.length
      : data.purchaseReturns.filter((r) => r.status === status).length
  const filtered = useMemo(
    () =>
      data.purchaseReturns.filter(
        (r) =>
          (statusFilter === 'All' || r.status === statusFilter) &&
          (supplierFilter === 'All' || r.supplier === supplierFilter) &&
          (paymentFilter === 'All' || r.paymentType === paymentFilter) &&
          (!from || dateKey(r.date) >= from) &&
          (!to || dateKey(r.date) <= to) &&
          `${r.id} ${r.supplier} ${r.reference} ${r.supplierBill}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data.purchaseReturns, statusFilter, supplierFilter, paymentFilter, from, to, query],
  )
  const pageSize = 5,
    pages = Math.max(1, Math.ceil(filtered.length / pageSize)),
    current = Math.min(page, pages),
    rows = filtered.slice((current - 1) * pageSize, current * pageSize)
  const totals = useMemo(() => {
    const sub = lines.reduce((sum, line) => sum + line.rate * line.qty, 0),
      discount = lines.reduce((sum, line) => sum + (line.rate * line.qty * line.discount) / 100, 0),
      gst = lines.reduce(
        (sum, line) =>
          sum +
          ((line.rate * line.qty - (line.rate * line.qty * line.discount) / 100) * line.gst) / 100,
        0,
      )
    return {
      items: lines.filter((l) => l.product && l.qty > 0).length,
      sub,
      discount,
      gst,
      net: sub - discount + gst,
    }
  }, [lines])
  const nextNo = () =>
    `PR-${String(Math.max(12, ...data.purchaseReturns.map((r) => parseInt(r.id.replace(/\D/g, ''), 10) || 0)) + 1).padStart(6, '0')}`
  const patch = (key: number, value: Partial<EditLine>) =>
    setLines((old) => old.map((line) => (line.key === key ? { ...line, ...value } : line)))
  const chooseProduct = (key: number, name: string) => {
    const product = data.products.find((p) => p.name === name)
    patch(
      key,
      product
        ? {
            product: name,
            pack: "10's",
            batch: product.batches[0]?.id ?? product.batch,
            expiry: product.batches[0]?.expiry ?? product.expiry,
            rate: product.batches[0]?.cost ?? product.cost,
          }
        : { product: name },
    )
  }
  const resetForm = () => {
    setSupplier('')
    setReturnDate(isoToday())
    setBill('')
    setReference('')
    setRemarks('')
    setPaymentType('Cash')
    setLines([blank(Date.now())])
    setTab('Return Items')
  }
  const save = (status: 'Draft' | 'Posted', print = false) => {
    const valid = lines.filter((line) => line.product && line.qty > 0)
    if (!supplier) {
      setNotice('Select a supplier before saving.')
      return
    }
    if (!valid.length) {
      setNotice('Add at least one product and returned quantity.')
      return
    }
    const entry: PurchaseReturn = {
      id: nextNo(),
      date: showDate(returnDate),
      supplier,
      reference: reference || '—',
      supplierBill: bill || '—',
      paymentType,
      status,
      remarks: remarks || 'No remarks entered.',
      lines: valid.map(({ key: _, ...line }) => line),
      amount: valid.reduce((sum, line) => sum + lineAmount(line), 0),
    }
    onAdd(entry)
    setNotice(
      `${entry.id} saved as ${status.toLowerCase()}${status === 'Posted' ? ' — stock and supplier ledger updated' : ''}.`,
    )
    resetForm()
    if (print) setTimeout(() => window.print(), 50)
  }
  const clearFilters = () => {
    setQuery('')
    setSupplierFilter('All')
    setPaymentFilter('All')
    setStatusFilter('All')
    setFrom('')
    setTo('')
    setPage(1)
  }
  const focusNew = () => editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const purchaseRefs = data.purchases.filter((p) => !supplier || p.supplier === supplier)

  return (
    <div className="pr-page">
      <header className="pr-head">
        <span className="pr-head-icon">
          <PackageOpen />
        </span>
        <div>
          <h1>Purchase Returns</h1>
          <p>View and manage all purchase returns</p>
        </div>
        <nav>
          Purchases <ChevronRight /> <b>Purchase Returns</b>
        </nav>
        <button className="pr-btn solid" onClick={focusNew}>
          <Plus /> New Purchase Return
        </button>
      </header>

      <section className="pr-card pr-register">
        <div className="pr-filters">
          <label className="pr-search">
            <Search />
            <input
              aria-label="Search purchase returns"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="Search by return #, supplier, reference #, bill #..."
            />
          </label>
          <label>
            <span>From Date</span>
            <i>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <CalendarDays />
            </i>
          </label>
          <label>
            <span>To Date</span>
            <i>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              <CalendarDays />
            </i>
          </label>
          <label>
            <span>Supplier</span>
            <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option>All</option>
              {suppliers.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Payment Type</span>
            <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
              <option>All</option>
              <option>Cash</option>
              <option>Credit</option>
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option>All</option>
              <option>Draft</option>
              <option>Posted</option>
              <option>Referenced</option>
              <option>Cancelled</option>
            </select>
          </label>
          <button className="pr-btn solid">
            <Search /> Search
          </button>
          <button className="pr-btn" onClick={clearFilters}>
            Clear
          </button>
        </div>
        <div className="pr-register-tools">
          <div>
            {['All', 'Draft', 'Posted', 'Referenced', 'Cancelled'].map((s) => (
              <button
                key={s}
                className={statusFilter === s ? 'active' : ''}
                onClick={() => {
                  setStatusFilter(s)
                  setPage(1)
                }}
              >
                {s} <span>{counts(s)}</span>
              </button>
            ))}
          </div>
          <aside>
            <button className="pr-btn">
              <Download /> Export <ChevronDown />
            </button>
            <button className="pr-btn">
              <Settings2 /> Columns <ChevronDown />
            </button>
          </aside>
        </div>
        <div className="pr-table-wrap">
          <table className="pr-table">
            <thead>
              <tr>
                <th />
                <th>#</th>
                <th>Return #</th>
                <th>Date</th>
                <th>Supplier</th>
                <th>Reference #</th>
                <th>Supplier Bill #</th>
                <th>Items</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Payment Type</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, index) => (
                <ReturnRow
                  key={r.id}
                  row={r}
                  number={(current - 1) * pageSize + index + 1}
                  open={expanded === r.id}
                  onOpen={() => setExpanded(expanded === r.id ? null : r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="pr-paging">
          <span>
            Showing {filtered.length ? (current - 1) * pageSize + 1 : 0} to{' '}
            {Math.min(current * pageSize, filtered.length)} of {filtered.length} entries
          </span>
          <div>
            <button disabled={current === 1} onClick={() => setPage(current - 1)}>
              <ChevronLeft />
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1)
              .slice(0, 5)
              .map((n) => (
                <button
                  key={n}
                  className={current === n ? 'active' : ''}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              ))}
            <button disabled={current === pages} onClick={() => setPage(current + 1)}>
              <ChevronRight />
            </button>
          </div>
        </div>
      </section>

      <div className="pr-editor" ref={editor}>
        <header>
          <button
            className="pr-back"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <ArrowLeft />
          </button>
          <div>
            <h2>New Purchase Return</h2>
            <p>Create a new purchase return entry</p>
          </div>
          <aside>
            <button className="pr-btn" onClick={() => save('Draft')}>
              <Save /> Save as Draft
            </button>
            <button className="pr-btn" onClick={() => save('Draft', true)}>
              <Printer /> Save &amp; Print
            </button>
            <button className="pr-btn solid" onClick={() => save('Posted')}>
              <Check /> Save &amp; Post
            </button>
          </aside>
        </header>
        {notice && (
          <div className="pr-notice" role="status">
            <Check />
            {notice}
          </div>
        )}
        <section className="pr-entry-head">
          <div className="pr-form">
            <label>
              Supplier <em>*</em>
              <span>
                <UserRound />
                <select
                  aria-label="Supplier"
                  value={supplier}
                  onChange={(e) => {
                    setSupplier(e.target.value)
                    setReference('')
                  }}
                >
                  <option value="">Search and select supplier</option>
                  {suppliers.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </span>
            </label>
            <label>
              Return Date <em>*</em>
              <span>
                <CalendarDays />
                <input
                  type="date"
                  value={returnDate}
                  onChange={(e) => setReturnDate(e.target.value)}
                />
              </span>
            </label>
            <label>
              Supplier Bill #
              <input
                value={bill}
                onChange={(e) => setBill(e.target.value)}
                placeholder="Enter supplier bill number"
              />
            </label>
            <label>
              Reference #
              <select value={reference} onChange={(e) => setReference(e.target.value)}>
                <option value="">Enter reference number</option>
                {purchaseRefs.map((p) => (
                  <option key={p.id}>{p.id}</option>
                ))}
              </select>
            </label>
            <label>
              Remarks
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Enter remarks..."
              />
            </label>
            <div className="pr-pay">
              <span>Payment Type</span>
              <label>
                <input
                  type="radio"
                  checked={paymentType === 'Cash'}
                  onChange={() => setPaymentType('Cash')}
                />{' '}
                Cash
              </label>
              <label>
                <input
                  type="radio"
                  checked={paymentType === 'Credit'}
                  onChange={() => setPaymentType('Credit')}
                />{' '}
                Credit
              </label>
            </div>
          </div>
          <aside className="pr-entry-summary">
            <div className="pr-number">
              <PackageOpen />
              <label>
                Purchase Return #
                <span>
                  <b>{nextNo()}</b>
                  <button onClick={() => setNotice('A new return number is ready.')}>
                    Generate
                  </button>
                </span>
              </label>
            </div>
            <div className="pr-summary-cards">
              <article>
                <Box />
                <span>
                  <small>Total Items</small>
                  <b>{totals.items}</b>
                </span>
              </article>
              <article>
                <CircleDollarSign />
                <span>
                  <small>Total Amount</small>
                  <b>{fmt(totals.net)}</b>
                </span>
              </article>
              <article>
                <i />
                <span>
                  <small>Status</small>
                  <b>Draft</b>
                </span>
              </article>
            </div>
          </aside>
        </section>
        <section className="pr-items">
          <div className="pr-item-tabs">
            <div>
              <button
                className={tab === 'Return Items' ? 'active' : ''}
                onClick={() => setTab('Return Items')}
              >
                Return Items
              </button>
              <button
                className={tab === 'Additional Information' ? 'active' : ''}
                onClick={() => setTab('Additional Information')}
              >
                Additional Information
              </button>
            </div>
            <aside>
              <button
                className="pr-btn"
                onClick={() => setLines((old) => [...old, blank(Date.now())])}
              >
                <Plus /> Add Item
              </button>
              <button className="pr-btn">
                <Barcode /> Scan Barcode
              </button>
              <button className="pr-btn">
                <Upload /> Import Items
              </button>
            </aside>
          </div>
          {tab === 'Return Items' ? (
            <>
              <div className="pr-table-wrap">
                <table className="pr-table pr-lines">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>
                        Product Name <em>*</em>
                      </th>
                      <th>Pack</th>
                      <th>Batch No.</th>
                      <th>Rate</th>
                      <th>L.S-Qty</th>
                      <th>Bonus</th>
                      <th>Disc %</th>
                      <th>Disc.</th>
                      <th>% GST</th>
                      <th>GST</th>
                      <th>Amount</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const discount = (line.rate * line.qty * line.discount) / 100,
                        gst = ((line.rate * line.qty - discount) * line.gst) / 100
                      return (
                        <tr key={line.key}>
                          <td>{index + 1}</td>
                          <td>
                            <select
                              aria-label={`Product ${index + 1}`}
                              value={line.product}
                              onChange={(e) => chooseProduct(line.key, e.target.value)}
                            >
                              <option value="">Search product...</option>
                              {data.products.map((p) => (
                                <option key={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              value={line.pack}
                              onChange={(e) => patch(line.key, { pack: e.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              value={line.batch}
                              onChange={(e) => {
                                const p = data.products.find((p) => p.name === line.product),
                                  batch = p?.batches.find((b) => b.id === e.target.value)
                                patch(line.key, {
                                  batch: e.target.value,
                                  expiry: batch?.expiry ?? line.expiry,
                                  rate: batch?.cost ?? line.rate,
                                })
                              }}
                            >
                              <option value="">—</option>
                              {data.products
                                .find((p) => p.name === line.product)
                                ?.batches.map((b) => (
                                  <option key={b.id}>{b.id}</option>
                                ))}
                            </select>
                          </td>
                          <td>
                            <Num value={line.rate} onChange={(rate) => patch(line.key, { rate })} />
                          </td>
                          <td>
                            <Num value={line.qty} onChange={(qty) => patch(line.key, { qty })} />
                          </td>
                          <td>
                            <Num
                              value={line.bonus}
                              onChange={(bonus) => patch(line.key, { bonus })}
                            />
                          </td>
                          <td>
                            <Num
                              value={line.discount}
                              onChange={(discount) => patch(line.key, { discount })}
                            />
                          </td>
                          <td>
                            <output>{fmt(discount)}</output>
                          </td>
                          <td>
                            <Num value={line.gst} onChange={(gst) => patch(line.key, { gst })} />
                          </td>
                          <td>
                            <output>{fmt(gst)}</output>
                          </td>
                          <td>
                            <output>{fmt(lineAmount(line))}</output>
                          </td>
                          <td>
                            <button
                              className="pr-delete"
                              aria-label={`Remove row ${index + 1}`}
                              onClick={() =>
                                setLines((old) =>
                                  old.length === 1
                                    ? [blank(Date.now())]
                                    : old.filter((x) => x.key !== line.key),
                                )
                              }
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
              <div className="pr-totals">
                <span>
                  <small>Total Items</small>
                  <b>{totals.items}</b>
                </span>
                <span>
                  <small>Sub Total</small>
                  <b>{fmt(totals.sub)}</b>
                </span>
                <span>
                  <small>Total Discount</small>
                  <b>{fmt(totals.discount)}</b>
                </span>
                <span>
                  <small>Total GST</small>
                  <b>{fmt(totals.gst)}</b>
                </span>
                <span className="net">
                  <small>Net Amount</small>
                  <b>{fmt(totals.net)}</b>
                </span>
              </div>
            </>
          ) : (
            <div className="pr-additional">
              <FileText />
              <div>
                <b>Return notes and audit information</b>
                <p>
                  Use the remarks field above for supplier instructions. Posting records the stock
                  and accounting effect automatically.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Num({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      className="pr-num"
      type="number"
      min={0}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

function ReturnRow({
  row,
  number,
  open,
  onOpen,
}: {
  row: PurchaseReturn
  number: number
  open: boolean
  onOpen: () => void
}) {
  return (
    <>
      <tr className={open ? 'expanded' : ''}>
        <td>
          <button
            className="pr-expand"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${row.id}`}
            onClick={onOpen}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        </td>
        <td>{number}</td>
        <td>
          <b>{row.id}</b>
        </td>
        <td>{row.date}</td>
        <td>{row.supplier}</td>
        <td>{row.reference}</td>
        <td>{row.supplierBill}</td>
        <td>{row.lines.length}</td>
        <td className="num">{fmt(row.amount)}</td>
        <td>
          <span className={`pr-status ${row.status.toLowerCase()}`}>{row.status}</span>
        </td>
        <td>{row.paymentType}</td>
        <td>
          <div className="pr-actions">
            <button aria-label={`View ${row.id}`} onClick={onOpen}>
              <Eye />
            </button>
            <button aria-label={`Print ${row.id}`} onClick={() => window.print()}>
              <Printer />
            </button>
            <button aria-label={`Copy ${row.id}`}>
              <Copy />
            </button>
            <button aria-label={`More ${row.id}`}>
              <Ellipsis />
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="pr-detail-row">
          <td colSpan={12}>
            <div className="pr-detail">
              <div className="pr-detail-meta">
                <dl>
                  <dt>Supplier</dt>
                  <dd>{row.supplier}</dd>
                  <dt>Reference #</dt>
                  <dd>{row.reference}</dd>
                  <dt>Supplier Bill #</dt>
                  <dd>{row.supplierBill}</dd>
                </dl>
                <dl>
                  <dt>Return Date</dt>
                  <dd>{row.date}</dd>
                  <dt>Payment Type</dt>
                  <dd>{row.paymentType}</dd>
                  <dt>Remarks</dt>
                  <dd>{row.remarks}</dd>
                </dl>
                <article>
                  <span>
                    <Box />
                  </span>
                  <div>
                    <small>Total Items</small>
                    <b>{row.lines.length}</b>
                  </div>
                </article>
                <article>
                  <span>
                    <CircleDollarSign />
                  </span>
                  <div>
                    <small>Total Amount</small>
                    <b>{fmt(row.amount)}</b>
                  </div>
                </article>
              </div>
              <h4>Return Items ({row.lines.length})</h4>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Product Name</th>
                    <th>Pack</th>
                    <th>Batch No.</th>
                    <th>Expiry Date</th>
                    <th>Rate</th>
                    <th>Returned Qty</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {row.lines.slice(0, 3).map((line, index) => (
                    <tr key={`${line.product}-${line.batch}`}>
                      <td>{index + 1}</td>
                      <td>{line.product}</td>
                      <td>{line.pack}</td>
                      <td>{line.batch}</td>
                      <td>{line.expiry}</td>
                      <td>{fmt(line.rate)}</td>
                      <td>{line.qty}</td>
                      <td>{fmt(lineAmount(line))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {row.lines.length > 3 && <p>+{row.lines.length - 3} more items...</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
