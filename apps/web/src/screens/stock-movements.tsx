'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ClipboardList,
  Download,
  FileText,
  Filter,
  Package,
  RefreshCw,
  Scale,
  Search,
  Warehouse,
} from 'lucide-react'
import type { StockMovement } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { money } from '@finsoft/ui'

const inTypes = new Set(['Purchase', 'Stock In', 'Gift'])
const outTypes = new Set(['Sale', 'Issue', 'Breakage', 'Purchase Return'])
const kindOf = (m: StockMovement) =>
  inTypes.has(m.type)
    ? 'In'
    : outTypes.has(m.type)
      ? 'Out'
      : m.type === 'Transfer'
        ? 'Transfer'
        : 'Adjustment'
const toneOf = (m: StockMovement) =>
  (({ In: 'in', Out: 'out', Transfer: 'move', Adjustment: 'adj' }) as const)[kindOf(m)]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const stamp = (d: string) => {
  const [dd, mon, yy] = d.split(' ')
  const i = MONTHS.indexOf(mon ?? '')
  return i < 0 ? 0 : Date.UTC(Number(yy), i, Number(dd))
}
const value = (m: StockMovement) => Math.abs(m.qty) * (m.unitCost ?? 0)

export function StockMovements({ data }: { data: AppData }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState(''),
    [type, setType] = useState('All types'),
    [dir, setDir] = useState('All'),
    [product, setProduct] = useState('All products'),
    [loc, setLoc] = useState('All locations')
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('')

  const all = data.movements
  const types = useMemo(() => [...new Set(all.map((m) => m.type))].sort(), [all])
  const locations = useMemo(
    () => [...new Set(all.flatMap((m) => [m.from, m.to]).filter((x): x is string => !!x))].sort(),
    [all],
  )
  const products = useMemo(() => [...new Set(all.map((m) => m.product))].sort(), [all])

  const rows = useMemo(() => {
    const f = from ? Date.parse(from) : 0,
      t = to ? Date.parse(to) : 0
    return all
      .filter((m) => {
        const when = stamp(m.date)
        return (
          `${m.product} ${m.reference} ${m.batch} ${m.note ?? ''} ${m.from ?? ''} ${m.to ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (type === 'All types' || m.type === type) &&
          (dir === 'All' || kindOf(m) === dir) &&
          (product === 'All products' || m.product === product) &&
          (loc === 'All locations' || m.from === loc || m.to === loc) &&
          (!f || when >= f) &&
          (!t || when <= t)
        )
      })
      .sort((a, b) => stamp(b.date) - stamp(a.date) || a.id.localeCompare(b.id))
  }, [all, query, type, dir, product, loc, from, to])

  const k = useMemo(() => {
    const qtyIn = rows.filter((m) => m.qty > 0).reduce((a, m) => a + m.qty, 0)
    const qtyOut = Math.abs(rows.filter((m) => m.qty < 0).reduce((a, m) => a + m.qty, 0))
    return {
      count: rows.length,
      qtyIn,
      qtyOut,
      net: qtyIn - qtyOut,
      transfers: new Set(rows.filter((m) => m.type === 'Transfer').map((m) => m.reference)).size,
      valueIn: rows.filter((m) => m.qty > 0).reduce((a, m) => a + value(m), 0),
      valueOut: rows.filter((m) => m.qty < 0).reduce((a, m) => a + value(m), 0),
    }
  }, [rows])

  const byType = useMemo(() => {
    const max = Math.max(1, ...types.map((t) => rows.filter((m) => m.type === t).length))
    return types
      .map((t) => ({
        type: t,
        n: rows.filter((m) => m.type === t).length,
        pct: Math.round((rows.filter((m) => m.type === t).length / max) * 100),
      }))
      .filter((r) => r.n)
      .sort((a, b) => b.n - a.n)
  }, [types, rows])

  const reset = () => {
    setQuery('')
    setType('All types')
    setDir('All')
    setProduct('All products')
    setLoc('All locations')
    setFrom('')
    setTo('')
  }
  const exportCsv = () => {
    const head = [
      'Reference',
      'Date',
      'Product',
      'Batch',
      'Type',
      'Direction',
      'From',
      'To',
      'Qty',
      'Value',
      'Note',
    ]
    const body = rows.map((m) => [
      m.reference,
      m.date,
      m.product,
      m.batch,
      m.type,
      kindOf(m),
      m.from ?? '',
      m.to ?? '',
      String(m.qty),
      String(value(m)),
      m.note ?? '',
    ])
    const csv = [head, ...body]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'stock-movements.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="sm-page">
      <header className="sm-head">
        <span className="sm-head-ico">
          <ArrowLeftRight />
        </span>
        <div>
          <h1>Stock Movements</h1>
          <p>
            Every stock-in, stock-out, transfer and adjustment — traceable by document reference.
          </p>
        </div>
        <div className="sm-head-btns">
          <button className="sm-btn" onClick={() => navigate('/inventory/movements')}>
            <Package /> Manual entry
          </button>
          <button className="sm-btn" onClick={() => navigate('/inventory/transfer')}>
            <ArrowLeftRight /> Stock transfer
          </button>
          <button className="sm-btn solid" onClick={exportCsv}>
            <Download /> Export CSV
          </button>
        </div>
      </header>

      <section className="sm-kpis">
        <div className="sm-kpi">
          <span className="t-all">
            <ClipboardList />
          </span>
          <div>
            <small>Movements</small>
            <b>{k.count}</b>
            <em>{all.length} total entries</em>
          </div>
        </div>
        <div className="sm-kpi">
          <span className="t-in">
            <ArrowUpRight />
          </span>
          <div>
            <small>Stock in</small>
            <b>+{k.qtyIn}</b>
            <em>{money(Math.round(k.valueIn))} received</em>
          </div>
        </div>
        <div className="sm-kpi">
          <span className="t-out">
            <ArrowDownRight />
          </span>
          <div>
            <small>Stock out</small>
            <b>−{k.qtyOut}</b>
            <em>{money(Math.round(k.valueOut))} issued</em>
          </div>
        </div>
        <div className="sm-kpi">
          <span className="t-net">
            <Scale />
          </span>
          <div>
            <small>Net effect</small>
            <b className={k.net >= 0 ? 'pos' : 'neg'}>
              {k.net >= 0 ? '+' : '−'}
              {Math.abs(k.net)}
            </b>
            <em>change in on-hand packs</em>
          </div>
        </div>
        <div className="sm-kpi">
          <span className="t-move">
            <RefreshCw />
          </span>
          <div>
            <small>Transfers</small>
            <b>{k.transfers}</b>
            <em>between locations</em>
          </div>
        </div>
      </section>

      <section className="sm-filters">
        <label className="sm-search">
          <Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search product, batch, reference or note..."
          />
        </label>
        <div className="sm-dirs">
          {['All', 'In', 'Out', 'Transfer', 'Adjustment'].map((d) => (
            <button key={d} className={dir === d ? 'on' : ''} onClick={() => setDir(d)}>
              {d}
            </button>
          ))}
        </div>
        <label className="sm-sel">
          <Filter />
          <select aria-label="Movement type" value={type} onChange={(e) => setType(e.target.value)}>
            <option>All types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="sm-sel">
          <Package />
          <select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)}>
            <option>All products</option>
            {products.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="sm-sel">
          <Warehouse />
          <select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option>All locations</option>
            {locations.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="sm-range">
          <CalendarDays />
          <input
            type="date"
            aria-label="From date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <i>→</i>
          <input
            type="date"
            aria-label="To date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="sm-btn ghost" onClick={reset}>
          <RefreshCw /> Reset
        </button>
      </section>

      <div className="sm-body">
        <section className="sm-card">
          <div className="sm-card-head">
            <h2>Movement ledger</h2>
            <span className="sm-count">
              {rows.length} of {all.length} entries · newest first
            </span>
          </div>
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>Product</th>
                  <th>Batch</th>
                  <th>Type</th>
                  <th>Route</th>
                  <th className="num">Qty</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.reference}</b>
                      {m.note && <small>{m.note}</small>}
                    </td>
                    <td className="nowrap">{m.date}</td>
                    <td>{m.product}</td>
                    <td className="mono">{m.batch}</td>
                    <td>
                      <span className={`sm-tag ${toneOf(m)}`}>{m.type}</span>
                    </td>
                    <td className="sm-route">
                      {m.from || m.to ? (
                        <>
                          <span>{m.from ?? '—'}</span>
                          <ArrowRight />
                          <span>{m.to ?? '—'}</span>
                        </>
                      ) : (
                        <i>—</i>
                      )}
                    </td>
                    <td className={`num ${m.qty > 0 ? 'pos' : 'neg'}`}>
                      {m.qty > 0 ? `+${m.qty}` : m.qty}
                    </td>
                    <td className="num">{value(m) ? money(Math.round(value(m))) : '—'}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={8}>
                      <div className="sm-empty">
                        <FileText /> No movements match these filters.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6}>Totals for {rows.length} movements</td>
                    <td className={`num ${k.net >= 0 ? 'pos' : 'neg'}`}>
                      {k.net >= 0 ? '+' : '−'}
                      {Math.abs(k.net)}
                    </td>
                    <td className="num">{money(Math.round(k.valueIn + k.valueOut))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

        <aside className="sm-side">
          <section className="sm-card">
            <div className="sm-card-head">
              <h3>
                <Boxes /> Movement mix
              </h3>
            </div>
            {byType.map((r) => (
              <div className="sm-bar" key={r.type}>
                <p>
                  <span>{r.type}</span>
                  <b>{r.n}</b>
                </p>
                <i>
                  <em
                    style={{ width: `${r.pct}%` }}
                    className={`t-${r.type.toLowerCase().replace(/ /g, '-')}`}
                  />
                </i>
              </div>
            ))}
            {!byType.length && <p className="sm-muted">No movements in range.</p>}
          </section>
          <section className="sm-card">
            <div className="sm-card-head">
              <h3>
                <Warehouse /> Locations touched
              </h3>
            </div>
            {locations.length ? (
              locations.map((l) => (
                <div className="sm-loc" key={l}>
                  <span>
                    <Warehouse />
                  </span>
                  <b>{l}</b>
                  <small>{rows.filter((m) => m.from === l || m.to === l).length} movements</small>
                </div>
              ))
            ) : (
              <p className="sm-muted">No location-tagged movements.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
