'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Boxes,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  Eye,
  FileText,
  FlaskConical,
  FolderOpen,
  Info,
  MapPin,
  Package,
  Pill,
  Plus,
  RefreshCw,
  Save,
  ScanBarcode,
  Search,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  Upload,
  User,
  Utensils,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import type { Product, StockMovement } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Mode = 'in' | 'out'
type Line = {
  key: number
  product: Product
  batch: string
  expiry: string
  qty: number
  cost: number
}
type Props = { data: AppData; onPost: (movement: StockMovement) => void }

const reasons: [string, LucideIcon][] = [
  ['Opening Stock', Package],
  ['Adjustment', SlidersHorizontal],
  ['Damaged Return', RefreshCw],
  ['Production', Settings],
  ['Consumption', Utensils],
  ['Sample Issue', FlaskConical],
  ['Internal Use', Archive],
]
const warehouses = ['Main Warehouse', 'Lahore Main', 'Rawalpindi', 'Karachi Warehouse']
const locations = ['A-01-01', 'A-01-02', 'B-02-01', 'C-01-04']
const users = ['Ali Raza', 'Sara Khan', 'Fatima Noor', 'Ahmed Bhatti']
const appToday = '2026-09-14'
const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
const fmtExp = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}
const num = (v: number) =>
  v.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const barcode = (id: string) => '8901234' + id.replace(/\D/g, '').padStart(6, '0').slice(-6)

const recentSeed = [
  {
    date: '12 Sep 2026',
    no: 'MI-000125',
    mode: 'in' as Mode,
    reason: 'Opening Stock',
    ref: 'OP-2026-01',
    items: 12,
    qty: 245,
    value: 245600,
    status: 'Posted',
    by: 'Ali Raza',
  },
  {
    date: '10 Sep 2026',
    no: 'MO-000021',
    mode: 'out' as Mode,
    reason: 'Consumption',
    ref: 'CON-2026-03',
    items: 8,
    qty: 120,
    value: 98400,
    status: 'Posted',
    by: 'Sara Khan',
  },
  {
    date: '08 Sep 2026',
    no: 'MI-000124',
    mode: 'in' as Mode,
    reason: 'Adjustment',
    ref: 'ADJ-2026-02',
    items: 15,
    qty: 300,
    value: 312750,
    status: 'Draft',
    by: 'Ali Raza',
  },
  {
    date: '05 Sep 2026',
    no: 'MO-000020',
    mode: 'out' as Mode,
    reason: 'Damaged Return',
    ref: 'DMG-2026-01',
    items: 6,
    qty: 25,
    value: 18750,
    status: 'Posted',
    by: 'Fatima Noor',
  },
]

export function ManualStockEntry({ data, onPost }: Props) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('in')
  const [reason, setReason] = useState('Opening Stock'),
    [warehouse, setWarehouse] = useState(warehouses[0]),
    [location, setLocation] = useState(locations[0]),
    [requested, setRequested] = useState(''),
    [entered] = useState(users[0]),
    [ref, setRef] = useState(''),
    [notes, setNotes] = useState(''),
    [date, setDate] = useState(appToday)
  const [query, setQuery] = useState(''),
    [pick, setPick] = useState(data.products[0]?.id ?? '')
  const [lines, setLines] = useState<Line[]>(() =>
    data.products.slice(0, 3).map((p, i) => ({
      key: i + 1,
      product: p,
      batch: p.batches[0]?.id ?? p.batch,
      expiry: p.batches[0]?.expiry ?? p.expiry,
      qty: [100, 50, 30][i] ?? 10,
      cost: p.cost,
    })),
  )
  const [posted, setPosted] = useState(''),
    [draft, setDraft] = useState(false)
  const entryNo = mode === 'in' ? 'MI-000126' : 'MO-000022'
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.products.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        barcode(p.id).includes(q),
    )
  }, [data.products, query])
  const totals = useMemo(
    () => ({
      items: lines.length,
      qty: lines.reduce((a, l) => a + l.qty, 0),
      value: lines.reduce((a, l) => a + l.qty * l.cost, 0),
    }),
    [lines],
  )
  const overdraw =
    mode === 'out'
      ? lines.filter((l) => l.qty > (l.product.batches.find((b) => b.id === l.batch)?.stock ?? 0))
      : []
  const problems: string[] = []
  if (!lines.length) problems.push('Add at least one product line.')
  if (lines.some((l) => l.qty < 1)) problems.push('Every line needs a quantity of 1 or more.')
  if (overdraw.length)
    problems.push(
      `${overdraw.map((l) => l.product.name).join(', ')} exceed${overdraw.length === 1 ? 's' : ''} available batch stock.`,
    )
  const ready = problems.length === 0
  const addItem = () => {
    const p = matches.find((x) => x.id === pick) ?? matches[0]
    if (!p) return
    setLines((prev) => [
      ...prev,
      {
        key: Date.now(),
        product: p,
        batch: p.batches[0]?.id ?? p.batch,
        expiry: p.batches[0]?.expiry ?? p.expiry,
        qty: 10,
        cost: p.cost,
      },
    ])
    setQuery('')
  }
  const patch = (key: number, p: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)))
  const post = () => {
    if (!ready) return
    const reference = ref.trim() || entryNo
    for (const l of lines)
      onPost({
        id: `MOV-${Date.now()}-${l.key}`,
        date: fmtDate(date),
        product: l.product.name,
        batch: l.batch,
        type: mode === 'in' ? 'Stock In' : 'Issue',
        qty: mode === 'in' ? l.qty : -l.qty,
        reference,
        to: mode === 'in' ? warehouse : undefined,
        from: mode === 'out' ? warehouse : undefined,
        note: `${reason}${notes.trim() ? ' — ' + notes.trim() : ''}`,
        expiry: l.expiry,
        unitCost: l.cost,
      })
    setPosted(reference)
  }
  const reset = () => {
    setPosted('')
    setDraft(false)
    setLines([])
    setRef('')
    setNotes('')
  }
  const recent = [
    ...data.movements
      .filter((m) => m.type === 'Stock In' || m.type === 'Issue')
      .slice(0, 4)
      .map((m) => ({
        date: m.date,
        no: m.reference,
        mode: (m.qty >= 0 ? 'in' : 'out') as Mode,
        reason: (m.note ?? '').split(' — ')[0] || 'Manual entry',
        ref: m.reference,
        items: 1,
        qty: Math.abs(m.qty),
        value: Math.abs(m.qty) * (m.unitCost ?? 0),
        status: 'Posted',
        by: entered,
      })),
    ...recentSeed,
  ].slice(0, 6)

  return (
    <div className="ms-page">
      <div className="ms-head">
        <button
          type="button"
          className="ms-back"
          aria-label="Back to inventory"
          onClick={() => navigate('/inventory')}
        >
          <ArrowLeft />
        </button>
        <div>
          <h1>Manual Stock In / Stock Out</h1>
          <p>
            Create manual inventory movement entries to adjust stock quantities in your warehouse.
          </p>
        </div>
        <div className="ms-head-btns">
          <button type="button" className="ms-btn soft" onClick={() => setDraft(true)}>
            <Save /> Save as Draft
          </button>
          <button
            type="button"
            className="ms-btn solid"
            disabled={!ready || !!posted}
            onClick={post}
          >
            <Check /> Save &amp; Post
          </button>
        </div>
      </div>
      <div className="ms-modes" role="tablist" aria-label="Movement type">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'in'}
          className={mode === 'in' ? 'active' : ''}
          onClick={() => {
            setMode('in')
            setPosted('')
          }}
        >
          <Upload />
          <span>
            <b>Manual Stock In</b>
            <small>Add stock to increase inventory</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'out'}
          className={mode === 'out' ? 'active' : ''}
          onClick={() => {
            setMode('out')
            setPosted('')
          }}
        >
          <Download />
          <span>
            <b>Manual Stock Out</b>
            <small>Remove stock from inventory</small>
          </span>
        </button>
      </div>
      {posted && (
        <div className="ms-toast ok" role="status">
          <CheckCircle2 />
          <div>
            <b>Stock operation posted</b>
            <p>{posted} is now reflected in live inventory and the movement ledger.</p>
          </div>
          <button type="button" className="ms-btn soft" onClick={reset}>
            Create another
          </button>
        </div>
      )}
      {draft && !posted && (
        <div className="ms-toast" role="status">
          <Save />
          <div>
            <b>Draft saved</b>
            <p>{entryNo} is saved as a draft. You can continue editing and post it later.</p>
          </div>
        </div>
      )}
      <div className="ms-grid">
        <section className="ms-card ms-entry">
          <h2>
            <FileText /> Entry Information
          </h2>
          <div className="ms-fields">
            <label>
              <span className="ms-lbl">Entry No.</span>
              <span className="ms-input ro">
                <input readOnly value={entryNo} />
                <Settings2 />
              </span>
            </label>
            <label>
              <span className="ms-lbl">Entry Date</span>
              <span className="ms-input">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                <CalendarDays />
              </span>
            </label>
            <label>
              <span className="ms-lbl">Manual Reference No.</span>
              <span className="ms-input">
                <input
                  placeholder="e.g. ADJ-2026-001"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </span>
            </label>
            <label>
              <span className="ms-lbl">
                Movement Reason <i>*</i>
              </span>
              <span className="ms-input">
                <Package />
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {reasons.map(([r]) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <ChevronDown />
              </span>
            </label>
            <label>
              <span className="ms-lbl">
                Warehouse <i>*</i>
              </span>
              <span className="ms-input">
                <Warehouse />
                <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                  {warehouses.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </select>
                <ChevronDown />
              </span>
            </label>
            <label>
              <span className="ms-lbl">Location / Shelf / Rack</span>
              <span className="ms-input">
                <MapPin />
                <select value={location} onChange={(e) => setLocation(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
                <ChevronDown />
              </span>
            </label>
            <label className="span-3-2">
              <span className="ms-lbl">Requested By</span>
              <span className="ms-input">
                <User />
                <select value={requested} onChange={(e) => setRequested(e.target.value)}>
                  <option value="">Select user</option>
                  {users.map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
                <ChevronDown />
              </span>
            </label>
            <label className="span-3-2">
              <span className="ms-lbl">
                Entered By <i>*</i>
              </span>
              <span className="ms-input ro">
                <User />
                <input readOnly value={entered} />
              </span>
            </label>
            <label className="span-3">
              <span className="ms-lbl">Notes</span>
              <span className="ms-input area">
                <StickyNote />
                <textarea
                  rows={2}
                  placeholder="Add notes about this manual stock movement (optional)..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </span>
            </label>
          </div>
        </section>
        <section className="ms-card ms-reasons">
          <h2>
            <FolderOpen /> Movement Reasons
          </h2>
          <div className="ms-reason-grid">
            {reasons.map(([r, I]) => (
              <button
                type="button"
                key={r}
                className={reason === r ? 'active' : ''}
                onClick={() => setReason(r)}
                aria-pressed={reason === r}
              >
                <span>
                  <I />
                </span>
                {r}
              </button>
            ))}
          </div>
          <div className="ms-hint">
            <Info />
            <span>Select a reason that best describes this stock movement.</span>
          </div>
        </section>
        <div className="ms-side">
          <section className="ms-card ms-summary">
            <h2>
              <BarChart3 /> Entry Summary
            </h2>
            <dl>
              <div>
                <dt>Total Items</dt>
                <dd>{totals.items}</dd>
              </div>
              <div>
                <dt>Total Quantity</dt>
                <dd>{totals.qty.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total Value (Rs.)</dt>
                <dd className="big">{num(totals.value)}</dd>
              </div>
            </dl>
            <div className={`ms-type ${mode}`}>
              <span>{mode === 'in' ? <ArrowUp /> : <ArrowDown />}</span>
              <div>
                <small>Movement Type</small>
                <b>{mode === 'in' ? 'Stock In' : 'Stock Out'}</b>
                <p>Stock will be {mode === 'in' ? 'increased' : 'decreased'} after posting.</p>
              </div>
            </div>
          </section>
          <section className="ms-card ms-valid">
            <h2>
              <ShieldCheck /> Validation
            </h2>
            {ready ? (
              <div className="ms-valid-box ok">
                <CheckCircle2 />
                <div>
                  <b>Ready to post</b>
                  <p>All information looks good. You can save as draft or post this entry.</p>
                </div>
              </div>
            ) : (
              <div className="ms-valid-box warn">
                <Info />
                <div>
                  <b>Needs attention</b>
                  {problems.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
      <section className="ms-card ms-products">
        <div className="ms-products-head">
          <h2>
            <Boxes /> Add Products
          </h2>
          <label className="ms-search">
            <Search />
            <input
              aria-label="Search product"
              placeholder="Search product by name, code or barcode..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                const m = data.products.find((p) =>
                  p.name.toLowerCase().includes(e.target.value.toLowerCase()),
                )
                if (m) setPick(m.id)
              }}
              list="ms-products-list"
            />
            <ScanBarcode />
          </label>
          <datalist id="ms-products-list">
            {matches.slice(0, 20).map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          <button type="button" className="ms-btn solid" onClick={addItem}>
            <Plus /> Add Item
          </button>
        </div>
        <div className="ms-table-wrap">
          <table className="ms-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>UPC / Barcode</th>
                <th>Batch</th>
                <th>Unit</th>
                <th>Quantity</th>
                <th>Unit Cost (Rs.)</th>
                <th>Total Value (Rs.)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lines.length ? (
                lines.map((l, i) => {
                  const b = l.product.batches.find((x) => x.id === l.batch)
                  const over = mode === 'out' && l.qty > (b?.stock ?? 0)
                  return (
                    <tr key={l.key} className={over ? 'over' : ''}>
                      <td>{i + 1}</td>
                      <td>
                        <div className="ms-prod">
                          <span>
                            <Pill />
                          </span>
                          <div>
                            <b>{l.product.name}</b>
                            <small>{l.product.id}</small>
                          </div>
                        </div>
                      </td>
                      <td>{barcode(l.product.id)}</td>
                      <td>
                        <select
                          aria-label={`Batch ${l.product.name}`}
                          className="ms-batch"
                          value={l.batch}
                          onChange={(e) => {
                            const nb = l.product.batches.find((x) => x.id === e.target.value)
                            patch(l.key, {
                              batch: e.target.value,
                              expiry: nb?.expiry ?? l.expiry,
                              cost: nb?.cost ?? l.cost,
                            })
                          }}
                        >
                          {l.product.batches.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.id}
                            </option>
                          ))}
                        </select>
                        <small>
                          EXP: {fmtExp(l.expiry)}
                          {mode === 'out' && b ? ` · ${b.stock} avail.` : ''}
                        </small>
                      </td>
                      <td>Box</td>
                      <td>
                        <input
                          aria-label={`Quantity ${l.product.name}`}
                          type="number"
                          min={1}
                          className="ms-num"
                          value={l.qty}
                          onChange={(e) => patch(l.key, { qty: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Unit cost ${l.product.name}`}
                          type="number"
                          min={0}
                          className="ms-num wide"
                          value={l.cost}
                          onChange={(e) => patch(l.key, { cost: Number(e.target.value) })}
                        />
                      </td>
                      <td className="ms-total">{num(l.qty * l.cost)}</td>
                      <td>
                        <button
                          type="button"
                          className="ms-icon danger"
                          aria-label={`Remove ${l.product.name}`}
                          onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        >
                          <Trash2 />
                        </button>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={9} className="ms-empty">
                    No products added yet. Search above and click <b>Add Item</b>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="ms-card ms-recent">
        <div className="ms-recent-head">
          <h2>
            <Clock3 /> Recent Manual Entries
          </h2>
          <button
            type="button"
            className="ms-link"
            onClick={() => navigate('/inventory/movements/history')}
          >
            View All <ArrowRight />
          </button>
        </div>
        <div className="ms-table-wrap">
          <table className="ms-table recent">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry No.</th>
                <th>Type</th>
                <th>Reason</th>
                <th>Reference No.</th>
                <th>Items</th>
                <th>Quantity</th>
                <th>Total Value (Rs.)</th>
                <th>Status</th>
                <th>Entered By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={r.no + i}>
                  <td>{r.date}</td>
                  <td>{r.no}</td>
                  <td>
                    <span className={`ms-pill ${r.mode}`}>
                      {r.mode === 'in' ? <ArrowUp /> : <ArrowDown />}
                      {r.mode === 'in' ? 'Stock In' : 'Stock Out'}
                    </span>
                  </td>
                  <td>{r.reason}</td>
                  <td>{r.ref}</td>
                  <td>{r.items}</td>
                  <td>{r.qty.toLocaleString()}</td>
                  <td>{num(r.value)}</td>
                  <td>
                    <span className={`ms-status ${r.status.toLowerCase()}`}>{r.status}</span>
                  </td>
                  <td>{r.by}</td>
                  <td>
                    <button
                      type="button"
                      className="ms-icon"
                      aria-label={`View ${r.no}`}
                      onClick={() => navigate('/inventory/movements/history')}
                    >
                      <Eye />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
