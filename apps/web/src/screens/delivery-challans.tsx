'use client'
import { useEffect, useRef, useState } from 'react'
import {
  CalendarDays, Check, CheckSquare, Clock3, Download, Eye,
  Filter, MapPin, Printer, Truck, User, X,
} from 'lucide-react'
import { Badge, Button, Kpi, PageHead, Panel, SearchField } from '@finsoft/ui'
import type { DeliveryChallan } from '@/mocks/api'

/* ─── Company constants for the printed document ─────────────────────────── */
const CO = {
  name: 'Bhatti Traders',
  address: 'Shop 14-A, Commercial Zone, Township, Lahore — 54000',
  phone: '042-35712890 / 0300-8442211',
  ntn: '2247940-1',
  strn: '20-04-9999-004-61',
} as const

type ChallanStatus = DeliveryChallan['status']
type Tab = 'All' | ChallanStatus

/* ─── Printed challan document ───────────────────────────────────────────── */
function ChallanDoc({ challan, copy = 'Original' }: { challan: DeliveryChallan; copy?: string }) {
  const totalQty = challan.lines.reduce((a, l) => a + l.qty, 0)
  const totalBonus = challan.lines.reduce((a, l) => a + l.bonus, 0)
  return (
    <div className="dc-doc">
      {/* ── Header ── */}
      <div className="dc-doc-header">
        <div className="dc-doc-co">
          <div className="dc-doc-co-logo"><Truck size={26} /></div>
          <div className="dc-doc-co-info">
            <h1>{CO.name}</h1>
            <p>{CO.address}</p>
            <p>Tel: {CO.phone}</p>
            <p>NTN: {CO.ntn} &nbsp;·&nbsp; STRN: {CO.strn}</p>
          </div>
        </div>
        <div className="dc-doc-title-block">
          <h2>DELIVERY CHALLAN</h2>
          <span className="dc-doc-copy-badge">{copy}</span>
          <div className="dc-doc-ref-grid">
            <div><span>Challan No.</span><b>{challan.id}</b></div>
            <div><span>Date</span><b>{challan.date}</b></div>
            <div><span>Invoice Ref.</span><b>{challan.invoiceRef}</b></div>
            <div><span>Status</span><b>{challan.status}</b></div>
          </div>
        </div>
      </div>

      {/* ── Divider ── */}
      <hr className="dc-doc-rule" />

      {/* ── Parties / transport ── */}
      <div className="dc-doc-parties">
        <div className="dc-doc-party-block">
          <span className="dc-doc-party-label">Deliver To:</span>
          <strong>{challan.customer}</strong>
          <p><MapPin size={11} /> {challan.address}</p>
        </div>
        <div className="dc-doc-party-block dc-doc-transport">
          <span className="dc-doc-party-label">Transport Details:</span>
          <p><Truck size={11} /> Vehicle: <b>{challan.vehicle || '—'}</b></p>
          <p><User size={11} /> Driver: <b>{challan.driver || '—'}</b></p>
        </div>
      </div>

      {/* ── Items table ── */}
      <table className="dc-doc-table">
        <thead>
          <tr>
            <th className="n">#</th>
            <th>Product / Description</th>
            <th>Pack</th>
            <th>Batch No.</th>
            <th>Expiry</th>
            <th className="num">Qty</th>
            <th className="num">Bonus</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {challan.lines.map((l, i) => (
            <tr key={i}>
              <td className="n">{i + 1}</td>
              <td><strong>{l.product}</strong></td>
              <td>{l.pack}</td>
              <td className="mono">{l.batch}</td>
              <td className="mono">{l.expiry}</td>
              <td className="num">{l.qty}</td>
              <td className="num">{l.bonus || '—'}</td>
              <td className="num"><strong>{l.qty + l.bonus}</strong></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="dc-doc-total-row">
            <td colSpan={5}><strong>Total</strong></td>
            <td className="num"><strong>{totalQty}</strong></td>
            <td className="num"><strong>{totalBonus || '—'}</strong></td>
            <td className="num"><strong>{totalQty + totalBonus}</strong></td>
          </tr>
        </tfoot>
      </table>

      {/* ── Notes ── */}
      {challan.notes && (
        <div className="dc-doc-notes">
          <strong>Notes: </strong>{challan.notes}
        </div>
      )}

      {/* ── Signature strip ── */}
      <div className="dc-doc-signs">
        <div className="dc-doc-sign">
          <div className="dc-sign-area" />
          <div className="dc-sign-label">Prepared By</div>
          <div className="dc-sign-name">{challan.preparedBy}</div>
        </div>
        <div className="dc-doc-sign">
          <div className="dc-sign-area" />
          <div className="dc-sign-label">Checked By</div>
          <div className="dc-sign-name">&nbsp;</div>
        </div>
        <div className="dc-doc-sign dc-doc-sign-recv">
          <div className="dc-sign-area dc-sign-stamp" />
          <div className="dc-sign-label">Received By &amp; Company Stamp</div>
          <div className="dc-sign-name">
            {challan.receivedBy ? challan.receivedBy : <span className="dc-sign-blank">Signature / Stamp</span>}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="dc-doc-foot">
        <span>Generated by {CO.name} ERP · {new Date().toLocaleDateString('en-PK')}</span>
        <span>This is a computer-generated delivery document. No signature required.</span>
      </div>
    </div>
  )
}

/* ─── Status tone map ─────────────────────────────────────────────────────── */
function statusTone(s: ChallanStatus): 'good' | 'warn' | 'danger' | 'info' {
  if (s === 'Delivered') return 'good'
  if (s === 'Pending') return 'warn'
  if (s === 'Cancelled') return 'danger'
  return 'info'
}

/* ─── Main screen ─────────────────────────────────────────────────────────── */
export function DeliveryChallans({ challans }: { challans: DeliveryChallan[] }) {
  const today = '22 Sep 2026'   // matches demo date in mock data
  const [tab, setTab] = useState<Tab>('All')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [printItems, setPrintItems] = useState<DeliveryChallan[] | null>(null)
  const [viewItem, setViewItem] = useState<DeliveryChallan | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  const visible = challans.filter(c => {
    const matchesTab = tab === 'All' || c.status === tab
    const matchesSearch = !search ||
      `${c.id} ${c.customer} ${c.invoiceRef} ${c.driver ?? ''} ${c.vehicle ?? ''}`
        .toLowerCase().includes(search.toLowerCase())
    return matchesTab && matchesSearch
  })

  const countToday = challans.filter(c => c.date === today).length
  const countPending = challans.filter(c => c.status === 'Pending').length
  const countDelivered = challans.filter(c => c.status === 'Delivered').length

  const tabCount = (t: Tab) => t === 'All' ? challans.length : challans.filter(c => c.status === t).length
  const allSelected = visible.length > 0 && visible.every(c => selected.includes(c.id))
  const someSelected = !allSelected && visible.some(c => selected.includes(c.id))

  const toggleAll = () =>
    setSelected(allSelected ? selected.filter(id => !visible.some(c => c.id === id)) : [...new Set([...selected, ...visible.map(c => c.id)])])
  const toggle = (id: string) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  const doPrint = (items: DeliveryChallan[]) => {
    setPrintItems(items)
  }

  /* Trigger window.print after React has rendered the print target */
  useEffect(() => {
    if (!printItems?.length) return
    const t = setTimeout(() => { window.print?.() }, 150)
    return () => clearTimeout(t)
  }, [printItems])

  /* Close print overlay when print dialog is dismissed */
  useEffect(() => {
    const after = () => { /* keep print items visible so user can re-print */ }
    window.addEventListener('afterprint', after)
    return () => window.removeEventListener('afterprint', after)
  }, [])

  const TABS: Tab[] = ['All', 'Pending', 'Delivered', 'Cancelled']

  return (
    <>
      {/* ── Hidden print root ───────────────────────────────────────────── */}
      {printItems && (
        <div className="dc-print-root" ref={printRef} aria-hidden="true">
          {/* on-screen preview header */}
          <div className="dc-print-bar dc-no-print">
            <span><Printer size={15} /> Print preview — {printItems.length} challan{printItems.length > 1 ? 's' : ''}</span>
            <div className="dc-print-bar-actions">
              <button className="btn primary" onClick={() => window.print?.()}><Printer size={14} /> Print now</button>
              <button className="btn secondary" onClick={() => setPrintItems(null)}><X size={14} /> Close</button>
            </div>
          </div>
          {printItems.map((c, i) => (
            <div key={c.id} className={i < printItems.length - 1 ? 'dc-print-break' : ''}>
              <ChallanDoc challan={c} copy="Original" />
            </div>
          ))}
        </div>
      )}

      {/* ── Page head ───────────────────────────────────────────────────── */}
      <PageHead
        eyebrow="Trading & Inventory / Sales"
        title="Delivery Challans"
        description="Track outgoing deliveries and print challans for wholesale, retail and distribution runs."
        actions={
          <>
            <Button kind="secondary"><Download /> Export</Button>
            <Button><Truck /> New Challan</Button>
          </>
        }
      />

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="kpi-grid mini">
        <Kpi label="Today's challans" value={String(countToday)} change={today} icon={CalendarDays} />
        <Kpi label="Pending delivery" value={String(countPending)} change="Awaiting dispatch" icon={Clock3} tone="yellow" />
        <Kpi label="Delivered" value={String(countDelivered)} change="Confirmed receipt" icon={Check} tone="teal" />
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="tabs" role="tablist" aria-label="Challan status filter">
        {TABS.map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t}
            {tabCount(t) > 0 && <span className="dc-tab-count">{tabCount(t)}</span>}
          </button>
        ))}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="toolbar">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search challan no, customer, invoice ref…"
        />
        <Button kind="secondary"><Filter size={14} /> More filters</Button>
        <span className="record-count">{visible.length} challan{visible.length !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Bulk action bar ──────────────────────────────────────────────── */}
      {selected.length > 0 && (
        <div className="dc-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="dc-bulk-info">
            <CheckSquare size={15} />
            {selected.length} challan{selected.length > 1 ? 's' : ''} selected
          </span>
          <div className="dc-bulk-actions">
            <Button onClick={() => doPrint(challans.filter(c => selected.includes(c.id)))}>
              <Printer size={14} /> Print Challan{selected.length > 1 ? 's' : ''}
            </Button>
            <button
              className="dc-bulk-clear"
              onClick={() => setSelected([])}
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Data table ──────────────────────────────────────────────────── */}
      <Panel
        title="Challan register"
        sub={`${visible.length} matching challan${visible.length !== 1 ? 's' : ''}`}
      >
        {visible.length === 0 ? (
          <div className="dc-empty">
            <Truck size={36} />
            <h3>No challans found</h3>
            <p>
              {search || tab !== 'All'
                ? 'No challans match the current filters. Try adjusting the search or tab.'
                : 'No delivery challans have been created yet.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table aria-label="Delivery challans">
              <thead>
                <tr>
                  <th style={{ width: 38 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all visible challans"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Challan No.</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Vehicle / Driver</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(c => {
                  const firstLine = c.lines[0]
                  const extra = c.lines.length - 1
                  const totalUnits = c.lines.reduce((a, l) => a + l.qty + l.bonus, 0)
                  return (
                    <tr key={c.id} className={selected.includes(c.id) ? 'dc-row-sel' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.id}`}
                          checked={selected.includes(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      <td>
                        <button className="linkable dc-challan-no" onClick={() => setViewItem(c)}>
                          {c.id}
                        </button>
                      </td>
                      <td>{c.date}</td>
                      <td>
                        <div>
                          <b>{c.customer}</b>
                          <small className="dc-address"><MapPin size={10} /> {c.address}</small>
                        </div>
                      </td>
                      <td>
                        <div>
                          <b>
                            {firstLine.product}
                            {extra > 0 && <span className="dc-more">+{extra} more</span>}
                          </b>
                          <small>{totalUnits} unit{totalUnits !== 1 ? 's' : ''} total</small>
                        </div>
                      </td>
                      <td>
                        {c.vehicle ? (
                          <div>
                            <b>{c.vehicle}</b>
                            <small><User size={10} /> {c.driver}</small>
                          </div>
                        ) : (
                          <span className="dc-na">—</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      </td>
                      <td>
                        <div className="dc-row-actions">
                          <button
                            className="table-action"
                            onClick={() => setViewItem(c)}
                            aria-label={`View ${c.id}`}
                          >
                            <Eye size={13} /> View
                          </button>
                          <button
                            className="table-action"
                            onClick={() => doPrint([c])}
                            aria-label={`Print ${c.id}`}
                          >
                            <Printer size={13} /> Print
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── View detail modal ───────────────────────────────────────────── */}
      {viewItem && (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={e => { if (e.target === e.currentTarget) setViewItem(null) }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dc-view-title"
            className="modal wide dc-view-modal"
          >
            {/* Modal head */}
            <div className="modal-head">
              <div>
                <Badge tone={statusTone(viewItem.status)}>{viewItem.status}</Badge>
                <h2 id="dc-view-title" style={{ marginTop: 6 }}>{viewItem.id}</h2>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                  {viewItem.customer} · {viewItem.date}
                </p>
              </div>
              <button className="icon-btn" aria-label="Close" onClick={() => setViewItem(null)}>
                <X size={16} />
              </button>
            </div>

            {/* Meta grid */}
            <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }}>
              <div><small>Invoice Ref.</small><b>{viewItem.invoiceRef}</b></div>
              <div><small>Prepared by</small><b>{viewItem.preparedBy}</b></div>
              <div><small>Vehicle</small><b>{viewItem.vehicle || '—'}</b></div>
              <div><small>Driver</small><b>{viewItem.driver || '—'}</b></div>
            </div>

            {/* Lines table */}
            <div className="table-wrap" style={{ margin: '0 0 14px' }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Product</th>
                    <th>Pack</th>
                    <th>Batch</th>
                    <th>Expiry</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Bonus</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {viewItem.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td><b>{l.product}</b></td>
                      <td>{l.pack}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{l.batch}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{l.expiry}</td>
                      <td style={{ textAlign: 'right' }}><b>{l.qty}</b></td>
                      <td style={{ textAlign: 'right' }}>{l.bonus || '—'}</td>
                      <td style={{ textAlign: 'right' }}><b>{l.qty + l.bonus}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Address / notes / received-by */}
            <div className="dc-view-footer">
              <div className="dc-view-info">
                <MapPin size={13} />
                <span><b>Deliver to:</b> {viewItem.customer}, {viewItem.address}</span>
              </div>
              {viewItem.receivedBy && (
                <div className="dc-view-info dc-view-received">
                  <Check size={13} />
                  <span><b>Received by:</b> {viewItem.receivedBy}</span>
                </div>
              )}
              {viewItem.notes && (
                <div className="dc-view-info">
                  <span><b>Notes:</b> {viewItem.notes}</span>
                </div>
              )}
            </div>

            <div className="modal-foot">
              <Button kind="secondary" onClick={() => setViewItem(null)}>Close</Button>
              <Button onClick={() => { doPrint([viewItem]); setViewItem(null) }}>
                <Printer size={14} /> Print Challan
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
