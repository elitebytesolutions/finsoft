'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  Barcode,
  Boxes,
  CalendarDays,
  CircleCheck,
  ClipboardPen,
  Eye,
  Gift,
  History,
  Lightbulb,
  Package,
  Paperclip,
  Plus,
  RotateCcw,
  Save,
  ShoppingCart,
  Trash2,
} from 'lucide-react'
import type { StockMovement } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Button, SearchField } from '@finsoft/ui'

type Kind = 'Breakage' | 'Gift'
type Line = {
  key: number
  product: string
  batch: string
  expiry: string
  uom: string
  qty: number
  rate: number
  remark: string
  selected: boolean
}

const reasons = [
  'Damaged in transit',
  'Expired stock',
  'Broken / leaked',
  'Storage damage',
  'Theft / shortage',
  'Manufacturing defect',
]
const blank = (key: number): Line => ({
  key,
  product: '',
  batch: '',
  expiry: '',
  uom: 'PCS',
  qty: 0,
  rate: 0,
  remark: '',
  selected: false,
})
const today = '11 Sep 2026'
const fmt = (n: number) =>
  n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nextNo = (kind: Kind, movements: StockMovement[]) => {
  const prefix = kind === 'Breakage' ? 'BRK' : 'GFT'
  const n = movements.filter((m) => m.reference.startsWith(prefix)).length + 1
  return `${prefix}-2026-${String(n).padStart(4, '0')}`
}

export function StockVouchers({
  data,
  onPost,
}: {
  data: AppData
  onPost: (m: StockMovement) => void
}) {
  const navigate = useNavigate()
  const [kind, setKind] = useState<Kind>('Breakage')
  const [lines, setLines] = useState<Line[]>([blank(1)])
  const [head, setHead] = useState({
    reference: '',
    reason: '',
    employee: '',
    remarks: '',
    guest: '',
    code: '',
  })
  const [status, setStatus] = useState<Record<string, 'Draft' | 'Posted'>>({})
  const [notice, setNotice] = useState('')
  const [typeFilter, setTypeFilter] = useState('All Voucher Types')
  const [statusFilter, setStatusFilter] = useState('All Status')
  const [search, setSearch] = useState('')
  const voucherNo = useMemo(() => nextNo(kind, data.movements), [kind, data.movements])

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const pickProduct = (key: number, name: string) => {
    const p = data.products.find((x) => x.name === name)
    update(key, {
      product: name,
      batch: p?.batch ?? '',
      expiry: p?.expiry ?? '',
      rate: p?.cost ?? 0,
    })
  }
  const addRow = () => setLines((ls) => [...ls, blank((ls.at(-1)?.key ?? 0) + 1)])
  const removeRow = (key: number) =>
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [blank(1)]))
  const removeSelected = () =>
    setLines((ls) => {
      const kept = ls.filter((l) => !l.selected)
      return kept.length ? kept : [blank(1)]
    })
  const clearAll = () => setLines([blank(1)])
  const reset = () => {
    clearAll()
    setHead({ reference: '', reason: '', employee: '', remarks: '', guest: '', code: '' })
    setNotice('')
  }
  const totalQty = lines.reduce((a, l) => a + l.qty, 0),
    totalAmount = lines.reduce((a, l) => a + l.qty * l.rate, 0)
  const valid = lines.filter((l) => l.product && l.qty > 0)

  const save = (post: boolean) => {
    if (!valid.length) {
      setNotice('Add at least one item with a product and quantity.')
      return
    }
    if (kind === 'Breakage' && !head.reason) {
      setNotice('Select a reason before saving.')
      return
    }
    if (kind === 'Gift' && !head.guest) {
      setNotice('Enter the guest / recipient before saving.')
      return
    }
    const note =
      kind === 'Breakage'
        ? [head.reason, head.remarks].filter(Boolean).join(' · ')
        : [head.guest, head.remarks].filter(Boolean).join(' · ')
    valid.forEach((l, i) =>
      onPost({
        id: `MOV-${Date.now()}${i}`,
        date: today,
        product: l.product,
        batch: l.batch || '—',
        type: kind,
        qty: post ? -l.qty : 0,
        reference: voucherNo,
        note: [note, l.remark].filter(Boolean).join(' · '),
        from: head.employee || head.guest || undefined,
        unitCost: l.rate,
      }),
    )
    setStatus((s) => ({ ...s, [voucherNo]: post ? 'Posted' : 'Draft' }))
    setNotice(`${voucherNo} ${post ? 'posted — stock updated' : 'saved as draft'}.`)
    clearAll()
    setHead({ reference: '', reason: '', employee: '', remarks: '', guest: '', code: '' })
  }

  const previous = useMemo(() => {
    const groups = new Map<string, StockMovement[]>()
    data.movements
      .filter((m) => m.type === 'Breakage' || m.type === 'Gift')
      .forEach((m) => groups.set(m.reference, [...(groups.get(m.reference) ?? []), m]))
    return [...groups.entries()]
      .map(([ref, ms]) => ({
        ref,
        date: ms[0].date,
        type: ms[0].type as Kind,
        by: ms[0].from ?? 'Admin',
        items: ms.length,
        qty: ms.reduce((a, m) => a + Math.abs(m.qty), 0),
        amount: ms.reduce(
          (a, m) =>
            a +
            Math.abs(m.qty) *
              (m.unitCost ?? data.products.find((p) => p.name === m.product)?.cost ?? 0),
          0,
        ),
        status: status[ref] ?? (ms.every((m) => m.qty === 0) ? 'Draft' : 'Posted'),
        remarks: ms[0].note ?? '—',
        product: ms[0].product,
      }))
      .filter(
        (v) =>
          (typeFilter === 'All Voucher Types' || v.type === typeFilter.replace(' Vouchers', '')) &&
          (statusFilter === 'All Status' || v.status === statusFilter) &&
          `${v.ref} ${v.by} ${v.product} ${v.remarks}`.toLowerCase().includes(search.toLowerCase()),
      )
  }, [data, status, typeFilter, statusFilter, search])

  const isGift = kind === 'Gift'
  return (
    <div className="sv">
      <div className="sv-head">
        <div className="sv-title">
          <span className="sv-title-icon">
            <Package />
          </span>
          <div>
            <h1>Stock Vouchers</h1>
            <p>Record stock breakage and gift/outgoing vouchers</p>
          </div>
        </div>
        <div className="sv-head-right">
          <span className="sv-tip">
            <Lightbulb />
            Use this page to record damaged, expired, or gifted items. Stock and accounts are
            auto-posted when you Save &amp; Post.
          </span>
          <Button kind="primary" onClick={() => navigate('/inventory')}>
            <Boxes /> View Stock
          </Button>
        </div>
      </div>

      <div className="sv-tabs">
        <button
          className={!isGift ? 'active' : ''}
          onClick={() => {
            setKind('Breakage')
            setNotice('')
          }}
        >
          <Package /> Breakage Voucher
        </button>
        <button
          className={isGift ? 'active' : ''}
          onClick={() => {
            setKind('Gift')
            setNotice('')
          }}
        >
          <Gift /> Gift Voucher
        </button>
      </div>

      <section className="sv-card sv-form-card">
        <div className="sv-section">
          <div className="sv-section-head">
            <div className="sv-title">
              <span className="sv-title-icon">
                <ClipboardPen />
              </span>
              <div>
                <h3>Voucher Details</h3>
                <p>Enter {isGift ? 'gift' : 'breakage'} voucher information and add items.</p>
              </div>
            </div>
          </div>
          <div className="sv-form-grid">
            <div className="sv-fields">
              <label>
                Voucher No <i>*</i>
                <input value={voucherNo} readOnly className="ro" />
              </label>
              <label>
                Reference No
                <input
                  placeholder="Enter reference no"
                  value={head.reference}
                  onChange={(e) => setHead({ ...head, reference: e.target.value })}
                />
              </label>
              <label>
                Date <i>*</i>
                <span className="sv-input-icon">
                  <CalendarDays />
                  <input value={today} readOnly />
                </span>
              </label>
              {isGift ? (
                <label>
                  Guest / Recipient <i>*</i>
                  <input
                    placeholder="Search or enter guest name"
                    value={head.guest}
                    onChange={(e) => setHead({ ...head, guest: e.target.value })}
                  />
                </label>
              ) : (
                <label>
                  Reason / Type <i>*</i>
                  <select
                    value={head.reason}
                    onChange={(e) => setHead({ ...head, reason: e.target.value })}
                  >
                    <option value="">Select reason</option>
                    {reasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Employee / Person
                <select
                  value={head.employee}
                  onChange={(e) => setHead({ ...head, employee: e.target.value })}
                >
                  <option value="">Select employee</option>
                  {data.employees.map((r) => (
                    <option key={r[0]} value={r[1]}>
                      {r[1]} — {r[2]}
                    </option>
                  ))}
                </select>
              </label>
              {isGift ? (
                <label>
                  Code
                  <input
                    placeholder="Enter code"
                    value={head.code}
                    onChange={(e) => setHead({ ...head, code: e.target.value })}
                  />
                </label>
              ) : (
                <span />
              )}
              <label className="span-2">
                Remarks
                <textarea
                  rows={2}
                  placeholder="Enter remarks (optional)"
                  value={head.remarks}
                  onChange={(e) => setHead({ ...head, remarks: e.target.value })}
                />
              </label>
            </div>
            <aside className="sv-type">
              <span className="sv-type-icon">{isGift ? <Gift /> : <Package />}</span>
              <div>
                <b>{isGift ? 'Gift Voucher' : 'Breakage Voucher'}</b>
                <p>
                  {isGift
                    ? 'Use this voucher to issue items as gifts for guests, promotions or other purposes.'
                    : 'Use this voucher to record damaged, expired, or unusable stock items.'}
                </p>
              </div>
              <dl>
                <dt>Voucher No</dt>
                <dd>{voucherNo}</dd>
                <dt>Date</dt>
                <dd>{today}</dd>
                <dt>Account Code</dt>
                <dd>{isGift ? '60-01-06-0000' : '60-01-04-0000'}</dd>
                <dt>Type</dt>
                <dd>{isGift ? 'GIFTS' : 'BREAKAGE'}</dd>
              </dl>
            </aside>
          </div>
        </div>

        <div className="sv-section">
          <div className="sv-section-head">
            <div className="sv-title">
              <span className="sv-title-icon">
                <ShoppingCart />
              </span>
              <div>
                <h3>Items</h3>
                <p>Add products to this {isGift ? 'gift' : 'breakage'} voucher.</p>
              </div>
            </div>
            <div className="sv-actions">
              <button className="sv-btn outline-green" onClick={addRow}>
                <Plus /> Add Item
              </button>
              <button
                className="sv-btn"
                onClick={() => setNotice('Barcode scanning is available in the connected edition.')}
              >
                <Barcode /> Scan Barcode
              </button>
              <button className="sv-btn" onClick={clearAll}>
                <Trash2 /> Clear All
              </button>
            </div>
          </div>
          <div className="table-wrap sv-table">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>#</th>
                  <th>Product Code</th>
                  <th>Product Name</th>
                  <th>Batch/Lot</th>
                  {!isGift && (
                    <>
                      <th>Expiry Date</th>
                      <th>UOM</th>
                    </>
                  )}
                  <th>Qty *</th>
                  <th>Rate</th>
                  <th>Amount</th>
                  <th>Remark</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = data.products.find((x) => x.name === l.product)
                  return (
                    <tr key={l.key}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select row ${i + 1}`}
                          checked={l.selected}
                          onChange={(e) => update(l.key, { selected: e.target.checked })}
                        />
                      </td>
                      <td>{i + 1}</td>
                      <td>
                        <select
                          aria-label={`Product row ${i + 1}`}
                          value={l.product}
                          onChange={(e) => pickProduct(l.key, e.target.value)}
                        >
                          <option value="">Search or scan...</option>
                          {data.products.map((x) => (
                            <option key={x.id} value={x.name}>
                              {x.id} — {x.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="sv-name">{p?.name ?? '—'}</td>
                      <td>
                        <input
                          aria-label="Batch"
                          value={l.batch}
                          onChange={(e) => update(l.key, { batch: e.target.value })}
                          placeholder="Batch"
                        />
                      </td>
                      {!isGift && (
                        <>
                          <td>
                            <input
                              aria-label="Expiry"
                              value={l.expiry}
                              onChange={(e) => update(l.key, { expiry: e.target.value })}
                              placeholder="DD-MMM-YYYY"
                            />
                          </td>
                          <td>
                            <select
                              aria-label="UOM"
                              value={l.uom}
                              onChange={(e) => update(l.key, { uom: e.target.value })}
                            >
                              {['PCS', 'BOX', 'STRIP', 'BTL'].map((u) => (
                                <option key={u}>{u}</option>
                              ))}
                            </select>
                          </td>
                        </>
                      )}
                      <td>
                        <input
                          aria-label="Quantity"
                          type="number"
                          min={0}
                          max={p?.stock}
                          value={l.qty}
                          onChange={(e) => update(l.key, { qty: Math.max(0, +e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Rate"
                          type="number"
                          min={0}
                          step="0.01"
                          value={l.rate}
                          onChange={(e) => update(l.key, { rate: Math.max(0, +e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Amount"
                          readOnly
                          className="ro"
                          value={fmt(l.qty * l.rate)}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Remark"
                          value={l.remark}
                          onChange={(e) => update(l.key, { remark: e.target.value })}
                          placeholder="Optional"
                        />
                      </td>
                      <td>
                        <button
                          className="sv-del"
                          aria-label={`Remove row ${i + 1}`}
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

          <div className="sv-below">
            <div className="sv-actions">
              <button className="sv-btn solid" onClick={addRow}>
                <Plus /> Add Row
              </button>
              <button className="sv-btn danger" onClick={removeSelected}>
                <Trash2 /> Remove Selected
              </button>
            </div>
            <div className="sv-totals">
              <div>
                <span>Total Quantity</span>
                <b>{totalQty}</b>
              </div>
              <div>
                <span>Total Amount</span>
                <b>{fmt(totalAmount)}</b>
              </div>
              <div className="sv-after">
                <span>Stock After Voucher</span>
                <b>Auto Updated</b>
              </div>
            </div>
          </div>
        </div>

        <div className="sv-section sv-foot">
          <div className="sv-attach">
            <b>Attachments</b>
            <button
              className="sv-btn"
              onClick={() => setNotice('File attachments are available in the connected edition.')}
            >
              <Paperclip /> Attach File
            </button>
            <span>No file selected</span>
          </div>
          {notice && (
            <span className="sv-notice" role="status">
              {notice}
            </span>
          )}
          <div className="sv-actions">
            <button className="sv-btn" onClick={reset}>
              <RotateCcw /> Reset
            </button>
            <button className="sv-btn" onClick={() => save(false)}>
              <Save /> Save as Draft
            </button>
            <button className="sv-btn solid big" onClick={() => save(true)}>
              <CircleCheck /> Save &amp; Post
            </button>
          </div>
        </div>
      </section>

      <section className="sv-card">
        <div className="sv-prev-head">
          <div className="sv-title">
            <span className="sv-title-icon">
              <History />
            </span>
            <div>
              <h3>Previous Vouchers</h3>
              <p>View and search all breakage and gift vouchers</p>
            </div>
          </div>
          <div className="sv-filters">
            <span className="sv-range">
              <CalendarDays />
              01-Sep-2026 → 11-Sep-2026
            </span>
            <select
              aria-label="Voucher type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              {['All Voucher Types', 'Breakage Vouchers', 'Gift Vouchers'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select
              aria-label="Status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {['All Status', 'Posted', 'Draft'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search voucher no, product, reference..."
            />
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Voucher No</th>
                <th>Type</th>
                <th>Employee / Guest</th>
                <th>Product</th>
                <th>Total Items</th>
                <th>Total Qty</th>
                <th>Total Amount</th>
                <th>Status</th>
                <th>Remarks</th>
                <th>Created By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {previous.map((v) => (
                <tr key={v.ref}>
                  <td>{v.date}</td>
                  <td>
                    <b>{v.ref}</b>
                  </td>
                  <td>
                    <span className={`sv-kind ${v.type.toLowerCase()}`}>
                      {v.type === 'Gift' ? <Gift /> : <Package />}
                      {v.type}
                    </span>
                  </td>
                  <td>{v.by}</td>
                  <td>
                    {v.product}
                    {v.items > 1 ? ` +${v.items - 1}` : ''}
                  </td>
                  <td>{v.items}</td>
                  <td>{v.qty}</td>
                  <td>
                    <b>{fmt(v.amount)}</b>
                  </td>
                  <td>
                    <Badge tone={v.status === 'Posted' ? 'good' : 'warn'}>● {v.status}</Badge>
                  </td>
                  <td className="sv-remarks">{v.remarks}</td>
                  <td>Admin</td>
                  <td>
                    <button
                      className="table-action"
                      onClick={() => navigate('/inventory/movements/history')}
                    >
                      <Eye /> View
                    </button>
                  </td>
                </tr>
              ))}
              {!previous.length && (
                <tr>
                  <td colSpan={12}>
                    <div className="empty-state">No vouchers match these filters.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="sv-paging">
          Showing {previous.length} of {previous.length} vouchers
        </div>
      </section>
    </div>
  )
}
