'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  Leaf,
  PackageCheck,
  Printer,
  RotateCcw,
  Scissors,
  Search,
  Truck,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AppData } from '@/mocks/api'

type DocType = 'Purchase Invoice' | 'Purchase Orders' | 'Goods Receipts (GRN)'
type Doc = {
  id: string
  date: string
  party: string
  total: number
  lines: { product: string; pack: string; qty: number; price: number }[]
  status: string
}
const fmt = (n: number) => n.toLocaleString('en-PK')
const templates = ['Standard', 'Modern', 'Compact', 'Simple'] as const
const toIsoDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

export function PrintDocuments({ data }: { data: AppData }) {
  const navigate = useNavigate()
  const [type, setType] = useState<DocType>('Purchase Invoice')
  const [party, setParty] = useState('')
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [dateFrom, setDateFrom] = useState(''),
    [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState('All')
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState({
    party: '',
    from: '',
    to: '',
    dateFrom: '',
    dateTo: '',
    status: 'All',
  })
  const [selected, setSelected] = useState<string[]>([])
  const [layout, setLayout] = useState<'Full Page' | 'Half Page'>('Full Page')
  const [template, setTemplate] = useState<(typeof templates)[number]>('Standard')
  const [opts, setOpts] = useState({
    logo: true,
    terms: true,
    signature: true,
    images: false,
    vat: true,
    group: false,
  })
  const [view, setView] = useState('Single Page')
  const [zoom, setZoom] = useState(100)
  const [page, setPage] = useState(1)
  const [printed, setPrinted] = useState('')

  const docs = useMemo<Doc[]>(() => {
    if (type === 'Purchase Orders')
      return data.pos.map((p) => ({
        id: p.id,
        date: p.date,
        party: p.supplier,
        total: p.amount,
        status: p.status,
        lines: p.lines.map((l) => ({
          product: l.product,
          pack: "10's",
          qty: l.qty,
          price: l.cost,
        })),
      }))
    const src =
      type === 'Goods Receipts (GRN)'
        ? data.purchases.filter((p) => p.status === 'Posted')
        : data.purchases
    return src.map((p) => ({
      id: type === 'Goods Receipts (GRN)' ? p.id.replace('PUR', 'GRN') : p.id,
      date: p.date,
      party: p.supplier,
      total: p.amount,
      status: p.status,
      lines: [{ product: p.product, pack: "10's", qty: p.qty, price: p.unitCost }],
    }))
  }, [data, type])
  const parties = [...new Set(docs.map((d) => d.party))]
  const rows = docs.filter((d) => {
    const date = toIsoDate(d.date)
    return (
      (!applied.party || d.party === applied.party) &&
      (applied.status === 'All' || d.status === applied.status) &&
      (!applied.from || d.id >= applied.from) &&
      (!applied.to || d.id <= applied.to) &&
      (!applied.dateFrom || date >= applied.dateFrom) &&
      (!applied.dateTo || date <= applied.dateTo) &&
      `${d.id} ${d.party}`.toLowerCase().includes(query.toLowerCase())
    )
  })
  const pageSize = 10,
    pages = Math.max(1, Math.ceil(rows.length / pageSize)),
    cur = Math.min(page, pages),
    slice = rows.slice((cur - 1) * pageSize, cur * pageSize)
  const allChecked = slice.length > 0 && slice.every((d) => selected.includes(d.id))
  const toggleAll = () =>
    setSelected(
      allChecked
        ? selected.filter((id) => !slice.some((d) => d.id === id))
        : [...new Set([...selected, ...slice.map((d) => d.id)])],
    )
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const chosen = docs.filter((d) => selected.includes(d.id))
  const preview = chosen.length ? chosen : slice.slice(0, 1)
  const previewPages =
    layout === 'Half Page'
      ? Math.max(1, Math.ceil(preview.length / 2))
      : Math.max(1, preview.length)
  const [pp, setPp] = useState(1)
  const ppCur = Math.min(pp, previewPages)
  const onPage =
    layout === 'Half Page'
      ? preview.slice((ppCur - 1) * 2, ppCur * 2)
      : preview.slice(ppCur - 1, ppCur)
  const reset = () => {
    setParty('')
    setFrom('')
    setTo('')
    setDateFrom('')
    setDateTo('')
    setStatus('All')
    setApplied({ party: '', from: '', to: '', dateFrom: '', dateTo: '', status: 'All' })
    setQuery('')
    setPage(1)
  }
  const changeType = (next: DocType) => {
    setType(next)
    setSelected([])
    setParty('')
    setFrom('')
    setTo('')
    setDateFrom('')
    setDateTo('')
    setStatus('All')
    setApplied({ party: '', from: '', to: '', dateFrom: '', dateTo: '', status: 'All' })
    setQuery('')
    setPage(1)
    setPp(1)
  }
  const print = () => {
    setPrinted(
      `${chosen.length || preview.length} document(s) sent to printer as ${layout.toLowerCase()} · ${template}.`,
    )
    window.print?.()
  }
  const cards: [DocType, string, typeof FileText][] = [
    ['Purchase Invoice', 'Print supplier invoices', FileText],
    ['Purchase Orders', 'Print purchase orders', PackageCheck],
    ['Goods Receipts (GRN)', 'Print goods received notes', Truck],
  ]
  const title =
    type === 'Purchase Orders'
      ? 'PURCHASE ORDER'
      : type === 'Goods Receipts (GRN)'
        ? 'GOODS RECEIPT NOTE'
        : 'PURCHASE INVOICE'

  return (
    <div className="pd">
      <div className="pd-head">
        <div className="pd-title">
          <span className="pd-title-icon">
            <Printer />
          </span>
          <div>
            <h1>Print Documents</h1>
            <p>Purchase Invoices, Purchase Orders and Goods Receipts</p>
          </div>
        </div>
        <div className="pd-head-right">
          <span className="pd-crumbs">
            <button onClick={() => navigate('/purchasing')}>Purchases</button>
            <ChevronRight />
            Print Documents
          </span>
          <button className="pd-btn">
            <CircleHelp /> Help
          </button>
        </div>
      </div>

      <div className="pd-types">
        {cards.map(([t, sub, Icon]) => (
          <button
            type="button"
            key={t}
            aria-pressed={type === t}
            className={type === t ? 'active' : ''}
            onClick={() => changeType(t)}
          >
            <span>
              <Icon />
            </span>
            <div>
              <b>{t}</b>
              <small>{sub}</small>
            </div>
          </button>
        ))}
      </div>

      <div className="pd-grid">
        <div className="pd-col">
          <section className="pd-card">
            <h3>
              <em>1.</em> Select Documents
            </h3>
            <label>
              Supplier
              <select value={party} onChange={(e) => setParty(e.target.value)}>
                <option value="">Select supplier...</option>
                {parties.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Document No. Range
              <span className="pd-range">
                <input placeholder="From" value={from} onChange={(e) => setFrom(e.target.value)} />
                <i>–</i>
                <input placeholder="To" value={to} onChange={(e) => setTo(e.target.value)} />
              </span>
            </label>
            <label>
              Date Range
              <span className="pd-range">
                <input
                  aria-label="Date from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
                <i>–</i>
                <input
                  aria-label="Date to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </span>
            </label>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option>All</option>
                {type === 'Purchase Orders'
                  ? ['Draft', 'Sent', 'Received', 'Cancelled'].map((s) => (
                      <option key={s}>{s}</option>
                    ))
                  : ['Posted', 'Draft'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <div className="pd-actions">
              <button
                className="pd-btn solid wide"
                onClick={() => {
                  setApplied({ party, from, to, dateFrom, dateTo, status })
                  setPage(1)
                }}
              >
                <Search /> Search Documents
              </button>
              <button className="pd-btn" onClick={reset}>
                <RotateCcw /> Reset
              </button>
            </div>
          </section>
          <section className="pd-card">
            <h3>
              <em>2.</em> Select Layout &amp; Options
            </h3>
            <span className="pd-label">Paper Layout</span>
            <div className="pd-layouts">
              {(['Full Page', 'Half Page'] as const).map((l) => (
                <button
                  key={l}
                  className={layout === l ? 'active' : ''}
                  onClick={() => {
                    setLayout(l)
                    setPp(1)
                  }}
                >
                  <i className={l === 'Half Page' ? 'half' : ''} />
                  {l}
                </button>
              ))}
            </div>
            <span className="pd-label">Template Style</span>
            <div className="pd-templates">
              {templates.map((t) => (
                <button
                  key={t}
                  className={template === t ? 'active' : ''}
                  onClick={() => setTemplate(t)}
                >
                  <span className={`pd-thumb ${t.toLowerCase()}`}>
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  {t}
                </button>
              ))}
            </div>
            <div className="pd-toggles">
              {(
                [
                  ['logo', 'Show Company Logo'],
                  ['images', 'Show Item Images'],
                  ['terms', 'Show Terms & Conditions'],
                  ['vat', 'Show VAT / Tax'],
                  ['signature', 'Show Signature'],
                  ['group', 'Group by Product'],
                ] as const
              ).map(([k, l]) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={opts[k]}
                    onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })}
                  />
                  <i />
                  <span>{l}</span>
                </label>
              ))}
            </div>
            <div className="pd-actions">
              <button className="pd-btn solid wide" onClick={print}>
                <Printer /> Print Selected
              </button>
              <button className="pd-btn">
                <Download /> Download PDF <ChevronDown />
              </button>
            </div>
            {printed && (
              <p className="pd-notice" role="status">
                {printed}
              </p>
            )}
          </section>
        </div>

        <section className="pd-card pd-list">
          <h3>
            <em>3.</em> Select{' '}
            {type === 'Purchase Orders'
              ? 'Orders'
              : type === 'Goods Receipts (GRN)'
                ? 'Receipts'
                : 'Invoices'}
          </h3>
          <span className="pd-search">
            <Search />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="Search document no, supplier..."
            />
          </span>
          <div className="table-wrap pd-table">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allChecked}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>
                    {type === 'Purchase Orders'
                      ? 'PO No.'
                      : type === 'Goods Receipts (GRN)'
                        ? 'GRN No.'
                        : 'Invoice No.'}
                  </th>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th className="num">Total (Rs.)</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((d) => (
                  <tr key={d.id} className={selected.includes(d.id) ? 'on' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${d.id}`}
                        checked={selected.includes(d.id)}
                        onChange={() => toggle(d.id)}
                      />
                    </td>
                    <td>
                      <b>{d.id}</b>
                    </td>
                    <td>{d.date}</td>
                    <td>{d.party}</td>
                    <td className="num">{fmt(d.total)}</td>
                  </tr>
                ))}
                {!slice.length && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">No documents match these filters.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pd-paging">
            <span>
              Showing {rows.length ? (cur - 1) * pageSize + 1 : 0} to{' '}
              {Math.min(cur * pageSize, rows.length)} of {rows.length}{' '}
              {type === 'Purchase Orders' ? 'orders' : 'invoices'}
            </span>
            <div className="pd-pager">
              <button aria-label="Previous" disabled={cur === 1} onClick={() => setPage(cur - 1)}>
                <ChevronLeft />
              </button>
              {Array.from({ length: Math.min(pages, 5) }, (_, i) => i + 1).map((n) => (
                <button key={n} className={n === cur ? 'active' : ''} onClick={() => setPage(n)}>
                  {n}
                </button>
              ))}
              {pages > 5 && (
                <>
                  <span>…</span>
                  <button onClick={() => setPage(pages)}>{pages}</button>
                </>
              )}
              <button aria-label="Next" disabled={cur === pages} onClick={() => setPage(cur + 1)}>
                <ChevronRight />
              </button>
            </div>
          </div>
        </section>

        <section className="pd-card pd-preview">
          <div className="pd-preview-head">
            <h3>
              <em>4.</em> Print Preview
            </h3>
            <label>
              View:{' '}
              <select value={view} onChange={(e) => setView(e.target.value)}>
                <option>Single Page</option>
                <option>Continuous</option>
              </select>
            </label>
          </div>
          <div className="pd-paper-wrap">
            <div
              className={`pd-paper ${template.toLowerCase()} ${layout === 'Half Page' ? 'half' : ''}`}
              style={{ zoom: zoom / 100 }}
            >
              {onPage.map((d, i) => (
                <div key={d.id} className="pd-sheet">
                  {i > 0 && (
                    <div className="pd-cut">
                      <Scissors />
                      <i />
                    </div>
                  )}
                  <div className="pd-doc-head">
                    <div className="pd-brand">
                      {opts.logo && <Leaf />}
                      <div>
                        <b>
                          Med<span>Trade</span>
                        </b>
                        <small>Trading for a Healthier Tomorrow</small>
                      </div>
                    </div>
                    <div className="pd-doc-meta">
                      <h4>{title}</h4>
                      <div>
                        <span>{type === 'Purchase Orders' ? 'PO No.' : 'Invoice No.'}</span>
                        <i>:</i>
                        <b>{d.id}</b>
                      </div>
                      <div>
                        <span>Date</span>
                        <i>:</i>
                        <b>{d.date}</b>
                      </div>
                      <div>
                        <span>Supplier ID</span>
                        <i>:</i>
                        <b>{data.masters.find((m) => m.name === d.party)?.code ?? 'SUP-0000'}</b>
                      </div>
                    </div>
                  </div>
                  <div className="pd-bill">
                    <b>{type === 'Purchase Orders' ? 'Order To:' : 'Supplier:'}</b>
                    <strong>{d.party}</strong>
                    <span>
                      {data.masters.find((m) => m.name === d.party)?.city ?? 'Karachi'}, Pakistan
                    </span>
                    <span>
                      Contact: {data.masters.find((m) => m.name === d.party)?.contact ?? '—'}
                    </span>
                  </div>
                  <table className="pd-doc-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Product</th>
                        <th>Pack</th>
                        <th className="num">Qty</th>
                        <th className="num">Unit Price</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.lines.map((l, j) => (
                        <tr key={j}>
                          <td>{j + 1}</td>
                          <td>{l.product}</td>
                          <td>{l.pack}</td>
                          <td className="num">{l.qty}</td>
                          <td className="num">{l.price.toFixed(2)}</td>
                          <td className="num">{fmt(l.qty * l.price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="pd-doc-foot">
                    {opts.terms && i === 0 ? (
                      <div className="pd-terms">
                        <b>Terms &amp; Conditions</b>
                        <ol>
                          <li>Goods once received will be checked against this document.</li>
                          <li>Payment within 30 days.</li>
                          <li>Subject to Lahore jurisdiction.</li>
                        </ol>
                      </div>
                    ) : (
                      <div />
                    )}
                    <div className="pd-totals">
                      <div>
                        <span>Sub Total</span>
                        <b>{fmt(d.total)}</b>
                      </div>
                      {opts.vat && (
                        <div>
                          <span>Sales Tax (17%)</span>
                          <b>{fmt(Math.round(d.total * 0.17))}</b>
                        </div>
                      )}
                      <div>
                        <span>Discount</span>
                        <b>0</b>
                      </div>
                      <div className="grand">
                        <span>Total (Rs.)</span>
                        <b>{fmt(opts.vat ? Math.round(d.total * 1.17) : d.total)}</b>
                      </div>
                    </div>
                  </div>
                  <div className="pd-doc-sign">
                    <em>Thank you for your business!</em>
                    {opts.signature && <span>Authorized Signature</span>}
                  </div>
                </div>
              ))}
              {!onPage.length && <div className="empty-state">Select a document to preview.</div>}
            </div>
          </div>
          <div className="pd-preview-foot">
            <div className="pd-pager">
              <button
                aria-label="Previous page"
                disabled={ppCur === 1}
                onClick={() => setPp(ppCur - 1)}
              >
                <ChevronLeft />
              </button>
              <span className="pd-pageno">
                Page {ppCur} of {previewPages}
              </span>
              <button
                aria-label="Next page"
                disabled={ppCur === previewPages}
                onClick={() => setPp(ppCur + 1)}
              >
                <ChevronRight />
              </button>
            </div>
            <div className="pd-zoom">
              <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(150, z + 10))}>
                <ZoomIn />
              </button>
              <span>{zoom}%</span>
              <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}>
                <ZoomOut />
              </button>
            </div>
            <select
              aria-label="Pages per sheet"
              value={layout}
              onChange={(e) => {
                setLayout(e.target.value as 'Full Page' | 'Half Page')
                setPp(1)
              }}
            >
              <option value="Full Page">Full Page (1 per page)</option>
              <option value="Half Page">Half Page (2 per page)</option>
            </select>
          </div>
        </section>
      </div>
    </div>
  )
}
