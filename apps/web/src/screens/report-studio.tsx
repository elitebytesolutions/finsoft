'use client'
import { useMemo, useState, type ReactNode } from 'react'
import {
  Bookmark,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  FileCheck2,
  FileOutput,
  Filter,
  Home,
  Layers,
  Maximize2,
  Minus,
  Plus,
  Printer,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Square,
  Star,
  X,
  type LucideIcon,
} from 'lucide-react'

/* ---------- shared types ---------- */
export type StudioTab = { key: string; label: string; icon: LucideIcon }
export type StudioColumn = { key: string; label: string; num?: boolean }
export type StudioRow = Record<string, string | number>
export type StudioStat = { label: string; value: string; icon: LucideIcon }
export type StudioPreset = { name: string; sub: string; starred?: boolean }
export type FilterField =
  | { kind: 'select'; label: string; icon: LucideIcon; options: string[] }
  | { kind: 'date'; label: string; icon: LucideIcon; options: string[]; date: string }
  | { kind: 'radio'; label: string; icon: LucideIcon; options: string[] }
  | { kind: 'toggle'; label: string; icon: LucideIcon; text: string }
  | { kind: 'search'; label: string; icon: LucideIcon; placeholder: string }
  | { kind: 'sort'; label: string; icon: LucideIcon; options: string[] }
export type StudioConfig = {
  module: string
  crumb: string
  title: string
  description: string
  tagline: ReactNode
  tabs: StudioTab[]
  filters: FilterField[]
  footToggle?: string
  stats: StudioStat[]
  columns: StudioColumn[]
  rows: StudioRow[]
  reportName: string
  summary: [string, string][]
  criteria: [string, string][]
  presets: StudioPreset[]
}

const fmt = (v: string | number) =>
  typeof v === 'number'
    ? v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })
    : v

/* ---------- filter field renderers ---------- */
function Field({
  f,
  value,
  onChange,
}: {
  f: FilterField
  value: string
  onChange: (v: string) => void
}) {
  const Icon = f.icon
  return (
    <div className="rst-fld">
      <div className="rst-fld-head">
        <Icon />
        <b>{f.label}</b>
      </div>
      {f.kind === 'select' && (
        <label className="rst-select">
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            {f.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <ChevronDown />
        </label>
      )}
      {f.kind === 'date' && (
        <>
          <label className="rst-select">
            <select value={value} onChange={(e) => onChange(e.target.value)}>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="rst-select">
            <input defaultValue={f.date} aria-label={`${f.label} value`} />
            <Calendar />
          </label>
        </>
      )}
      {f.kind === 'radio' && (
        <div className="rst-radios">
          {f.options.map((o) => (
            <label key={o} className={value === o ? 'on' : ''}>
              <input
                type="radio"
                name={f.label}
                checked={value === o}
                onChange={() => onChange(o)}
              />
              <i />
              {o}
            </label>
          ))}
        </div>
      )}
      {f.kind === 'toggle' && (
        <label className="rst-switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={value === 'on'}
            className={`rst-switch ${value === 'on' ? 'on' : ''}`}
            onClick={() => onChange(value === 'on' ? 'off' : 'on')}
          />
          <span>{f.text}</span>
        </label>
      )}
      {f.kind === 'search' && (
        <label className="rst-select rst-search">
          <Search />
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={f.placeholder}
          />
        </label>
      )}
      {f.kind === 'sort' && (
        <div className="rst-sort">
          <label className="rst-select">
            <select value={value} onChange={(e) => onChange(e.target.value)}>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          <label className="rst-select">
            <select defaultValue="Ascending" aria-label="Sort direction">
              <option>Ascending</option>
              <option>Descending</option>
            </select>
            <ChevronDown />
          </label>
        </div>
      )}
    </div>
  )
}

/* ---------- studio page ---------- */
export function ReportStudioPage({ config: c }: { config: StudioConfig }) {
  const [tab, setTab] = useState(c.tabs[0].key)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      c.filters.map((f) => [
        f.label,
        f.kind === 'radio' || f.kind === 'select' || f.kind === 'date' || f.kind === 'sort'
          ? f.options[0]
          : f.kind === 'toggle'
            ? 'off'
            : '',
      ]),
    ),
  )
  const [view, setView] = useState<'Detail' | 'Summary'>('Detail')
  const [opts, setOpts] = useState({ value: true, zero: false, group: true, desc: true })
  const [format, setFormat] = useState('PDF')
  const [zoom, setZoom] = useState(100)
  const [page, setPage] = useState(1)
  const [foot, setFoot] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const active = c.tabs.find((t) => t.key === tab)!
  const set = (k: string) => (v: string) => setValues((s) => ({ ...s, [k]: v }))
  const rows = useMemo(() => {
    const q = (
      Object.entries(values).find(
        ([k]) => c.filters.find((f) => f.label === k)?.kind === 'search',
      )?.[1] ?? ''
    ).toLowerCase()
    return q
      ? c.rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)))
      : c.rows
  }, [values, c])
  const cols = opts.value ? c.columns : c.columns.filter((col) => !/value|cost/i.test(col.label))
  const stamp = '14 Sep 2026  10:24 AM'
  const pages = 5

  return (
    <div className="rst-page">
      <div className="rst-hero">
        <div className="rst-hero-top">
          <span className="rst-module">
            <span className="rst-cube">
              <Layers />
            </span>
            {c.module}
          </span>
          <span className="rst-crumb">
            <Home /> Reports <ChevronRight /> <b>{c.crumb}</b>
          </span>
        </div>
        <div className="rst-hero-row">
          <div>
            <h1>{c.title}</h1>
            <p>{c.description}</p>
          </div>
          <em className="rst-tagline">{c.tagline}</em>
        </div>
      </div>

      <div className="rst-tabs" role="tablist">
        {c.tabs.map((t) => {
          const I = t.icon
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? 'active' : ''}
              onClick={() => {
                setTab(t.key)
                setPage(1)
              }}
            >
              <I />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      <div className={`rst-grid ${filtersOpen ? '' : 'no-filters'}`}>
        {filtersOpen && (
          <aside className="rst-panel rst-filters">
            <div className="rst-panel-head">
              <SlidersHorizontal />
              <b>Filters</b>
              <button aria-label="Close filters" onClick={() => setFiltersOpen(false)}>
                <X />
              </button>
            </div>
            {c.filters.map((f) => (
              <Field key={f.label} f={f} value={values[f.label] ?? ''} onChange={set(f.label)} />
            ))}
            {c.footToggle && (
              <label className="rst-switch-row rst-foot-toggle">
                <FileCheck2 />
                <span>{c.footToggle}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={foot}
                  className={`rst-switch ${foot ? 'on' : ''}`}
                  onClick={() => setFoot(!foot)}
                />
              </label>
            )}
            <button className="rst-primary rst-apply">
              <Filter /> Apply Filters
            </button>
          </aside>
        )}

        <section className="rst-panel rst-viewer">
          <div className="rst-toolbar">
            {!filtersOpen && (
              <button
                className="rst-tool"
                onClick={() => setFiltersOpen(true)}
                aria-label="Show filters"
              >
                <SlidersHorizontal />
              </button>
            )}
            <button
              className="rst-tool"
              aria-label="Previous page"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft />
            </button>
            <span className="rst-pageno">
              {page} / {pages}
            </span>
            <button
              className="rst-tool"
              aria-label="Next page"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              <ChevronRight />
            </button>
            <span className="rst-zoom">
              <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}>
                <Minus />
              </button>
              <b>{zoom}%</b>
              <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}>
                <Plus />
              </button>
            </span>
            <button className="rst-tool wide" onClick={() => setZoom(100)}>
              <Square /> Fit Width
            </button>
            <button className="rst-tool wide">
              <Columns2 /> Two Pages
            </button>
            <span className="rst-tool-gap" />
            <button className="rst-tool tall">
              <Download />
              <small>Download</small>
            </button>
            <button className="rst-tool tall" onClick={() => window.print()}>
              <Printer />
              <small>Print</small>
            </button>
            <button className="rst-tool tall">
              <Maximize2 />
              <small>Fullscreen</small>
            </button>
          </div>
          <div className="rst-canvas">
            <div className="rst-thumbs">
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={page === n ? 'on' : ''}
                  onClick={() => setPage(n)}
                  aria-label={`Page ${n}`}
                >
                  <span className="rst-thumb">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <small>{n}</small>
                </button>
              ))}
            </div>
            <div className="rst-sheet-wrap">
              <article className="rst-sheet" style={{ transform: `scale(${zoom / 100})` }}>
                <header className="rst-sheet-head">
                  <div className="rst-co">
                    <span className="rst-cube big">
                      <Layers />
                    </span>
                    <div>
                      <b>Bhatti Traders (Pvt) Ltd.</b>
                      <small>Main Road, Lahore, Pakistan</small>
                    </div>
                  </div>
                  <div className="rst-sheet-title">
                    <b>{c.reportName}</b>
                    <span>{active.label}</span>
                    <small>Generated On: {stamp}</small>
                    <small>
                      Page {page} of {pages}
                    </small>
                  </div>
                </header>
                <div className="rst-stats">
                  {c.stats.map((s) => {
                    const I = s.icon
                    return (
                      <div key={s.label}>
                        <span>
                          <I />
                        </span>
                        <div>
                          <small>{s.label}</small>
                          <b>{s.value}</b>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {view === 'Detail' && (
                  <table className="rst-table">
                    <thead>
                      <tr>
                        {cols.map((col) => (
                          <th key={col.key} className={col.num ? 'num' : ''}>
                            {col.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          {cols.map((col) => (
                            <td key={col.key} className={col.num ? 'num' : ''}>
                              {fmt(r[col.key] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="rst-sheet-foot-grid">
                  <div>
                    <h4>Summary</h4>
                    <table className="rst-kv">
                      {c.summary.map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </table>
                  </div>
                  <div>
                    <h4>Report Criteria</h4>
                    <table className="rst-kv plain">
                      {c.criteria.map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </table>
                  </div>
                </div>
                <footer className="rst-sheet-footer">
                  <span>Bhatti Traders (Pvt) Ltd.</span>
                  <span>
                    {c.reportName} - {active.label}
                  </span>
                  <span>
                    Page {page} of {pages}
                  </span>
                </footer>
              </article>
            </div>
          </div>
        </section>

        <aside className="rst-side">
          <div className="rst-panel rst-options">
            <div className="rst-panel-head">
              <Settings2 />
              <b>Report Options</b>
            </div>
            <div className="rst-fld">
              <div className="rst-fld-head plain">
                <b>Report Type</b>
              </div>
              <label className="rst-select">
                <select value={tab} onChange={(e) => setTab(e.target.value)}>
                  {c.tabs.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <ChevronDown />
              </label>
            </div>
            <div className="rst-fld">
              <div className="rst-fld-head plain">
                <b>View Mode</b>
              </div>
              <div className="rst-seg">
                {(['Detail', 'Summary'] as const).map((v) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="rst-checks">
              {(
                [
                  ['value', 'Show value columns'],
                  ['zero', 'Include zero stock items'],
                  ['group', 'Group by product class'],
                  ['desc', 'Show item description'],
                ] as const
              ).map(([k, l]) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={opts[k]}
                    onChange={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}
                  />
                  <span>{l}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={opts[k]}
                    className={`rst-switch ${opts[k] ? 'on' : ''}`}
                    onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}
                  />
                </label>
              ))}
            </div>
            <div className="rst-panel-head sub">
              <FileOutput />
              <b>Output Format</b>
            </div>
            <div className="rst-seg three">
              {['PDF', 'Excel', 'Print'].map((f) => (
                <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {f}
                </button>
              ))}
            </div>
            <button className="rst-primary">
              <FileCheck2 /> Generate Report
            </button>
          </div>
          <div className="rst-panel rst-presets">
            <div className="rst-panel-head">
              <Bookmark />
              <b>Saved Presets</b>
              <button className="rst-link">Manage</button>
            </div>
            {c.presets.map((p) => (
              <button key={p.name} className="rst-preset">
                {p.starred ? <Star className="star" /> : <span className="rst-box" />}
                <div>
                  <b>{p.name}</b>
                  <small>{p.sub}</small>
                </div>
                <ChevronRight />
              </button>
            ))}
            <button className="rst-secondary">
              <Save /> Save Current Settings
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}
