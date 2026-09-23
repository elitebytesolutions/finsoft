'use client'
import { useMemo, useState, type FormEvent } from 'react'
import {
  Barcode,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Link2,
  Mail,
  MapPin,
  Package,
  PauseCircle,
  Phone,
  Plus,
  Save,
  Search,
  Tag,
  X,
} from 'lucide-react'

type Company = {
  code: string
  name: string
  short: string
  color: string
  products: number
  city: string
  status: 'Active' | 'Inactive'
  updated: string
  address?: string
  country?: string
  phone?: string
  email?: string
  website?: string
  notes?: string
}

const seed: Company[] = [
  {
    code: 'SU07',
    name: 'GlaxoSmithKline Pakistan',
    short: 'GSK',
    color: '#E8572A',
    products: 128,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '2 days ago',
  },
  {
    code: 'SU08',
    name: 'Abbott Laboratories',
    short: 'Abbott',
    color: '#0E8A46',
    products: 96,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '5 days ago',
  },
  {
    code: 'SU09',
    name: 'Pfizer Pakistan',
    short: 'Pfizer',
    color: '#1D5FB5',
    products: 74,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '1 week ago',
  },
  {
    code: 'SU10',
    name: 'Sanofi Aventis',
    short: 'Sanofi',
    color: '#5A2D82',
    products: 52,
    city: 'Karachi, Pakistan',
    status: 'Inactive',
    updated: '1 month ago',
  },
  {
    code: 'SU11',
    name: 'Novo Nordisk',
    short: 'novo',
    color: '#1B4E9B',
    products: 34,
    city: 'Islamabad, Pakistan',
    status: 'Active',
    updated: '3 days ago',
  },
  {
    code: 'SU12',
    name: 'Getz Pharma',
    short: 'Getz',
    color: '#1F7FC4',
    products: 88,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '6 days ago',
  },
  {
    code: 'SU13',
    name: 'Hilton Pharma',
    short: 'Hilton',
    color: '#C81E1E',
    products: 41,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '2 weeks ago',
  },
  {
    code: 'SU14',
    name: 'Martin Dow',
    short: 'MD',
    color: '#1E3A8A',
    products: 27,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '1 week ago',
  },
  {
    code: 'SU15',
    name: 'Ferozsons Laboratories',
    short: 'Feroz',
    color: '#0B4F9C',
    products: 19,
    city: 'Lahore, Pakistan',
    status: 'Inactive',
    updated: '1 month ago',
  },
  {
    code: 'SU16',
    name: 'The Searle Company',
    short: 'Searle',
    color: '#0E8A46',
    products: 63,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '4 days ago',
  },
  {
    code: 'SU17',
    name: 'Sami Pharmaceuticals',
    short: 'Sami',
    color: '#0F766E',
    products: 58,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '1 day ago',
  },
  {
    code: 'SU18',
    name: 'Highnoon Laboratories',
    short: 'Highnoon',
    color: '#B45309',
    products: 45,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '3 days ago',
  },
  {
    code: 'SU19',
    name: 'CCL Pharmaceuticals',
    short: 'CCL',
    color: '#7C3AED',
    products: 39,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '2 weeks ago',
  },
  {
    code: 'SU20',
    name: 'Bosch Pharmaceuticals',
    short: 'Bosch',
    color: '#DC2626',
    products: 31,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '5 days ago',
  },
  {
    code: 'SU21',
    name: 'Barrett Hodgson',
    short: 'Barrett',
    color: '#0369A1',
    products: 36,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '1 week ago',
  },
  {
    code: 'SU22',
    name: 'Atco Laboratories',
    short: 'ATCO',
    color: '#15803D',
    products: 29,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '6 days ago',
  },
  {
    code: 'SU23',
    name: 'Hansel Pharma',
    short: 'Hansel',
    color: '#9333EA',
    products: 12,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '3 weeks ago',
  },
  {
    code: 'SU24',
    name: 'PharmEvo',
    short: 'PharmEvo',
    color: '#0891B2',
    products: 47,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '2 days ago',
  },
  {
    code: 'SU25',
    name: 'Nabiqasim Industries',
    short: 'Nabiqasim',
    color: '#166534',
    products: 22,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '1 week ago',
  },
  {
    code: 'SU26',
    name: 'Wilshire Laboratories',
    short: 'Wilshire',
    color: '#1D4ED8',
    products: 18,
    city: 'Lahore, Pakistan',
    status: 'Active',
    updated: '2 weeks ago',
  },
  {
    code: 'SU27',
    name: 'Macter International',
    short: 'Macter',
    color: '#BE123C',
    products: 33,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '4 days ago',
  },
  {
    code: 'SU28',
    name: 'Zafa Pharmaceuticals',
    short: 'Zafa',
    color: '#0D9488',
    products: 26,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '1 month ago',
  },
  {
    code: 'SU29',
    name: 'Genix Pharma',
    short: 'Genix',
    color: '#4F46E5',
    products: 21,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '3 days ago',
  },
  {
    code: 'SU30',
    name: 'Medisure Laboratories',
    short: 'Medisure',
    color: '#EA580C',
    products: 15,
    city: 'Karachi, Pakistan',
    status: 'Active',
    updated: '2 weeks ago',
  },
]
const PAGE = 9
const emptyForm = {
  code: '',
  name: '',
  status: 'Active' as Company['status'],
  address: '',
  country: 'Pakistan',
  phone: '',
  email: '',
  website: '',
  notes: '',
}

export function ProductCompanies() {
  const [list, setList] = useState<Company[]>(seed)
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('All Statuses'),
    [scope, setScope] = useState<'All' | 'Active' | 'Inactive'>('All'),
    [sort, setSort] = useState('Code'),
    [page, setPage] = useState(1)
  const [open, setOpen] = useState(true)
  const [f, setF] = useState({ ...emptyForm })
  const [err, setErr] = useState('')

  const filtered = useMemo(() => {
    let r = list.filter((c) =>
      `${c.code} ${c.name} ${c.city}`.toLowerCase().includes(q.toLowerCase()),
    )
    if (status !== 'All Statuses') r = r.filter((c) => c.status === status)
    if (scope !== 'All') r = r.filter((c) => c.status === scope)
    r = [...r].sort((a, b) =>
      sort === 'Company Name'
        ? a.name.localeCompare(b.name)
        : sort === 'Code'
          ? a.code.localeCompare(b.code)
          : b.products - a.products,
    )
    return r
  }, [list, q, status, scope, sort])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const cur = Math.min(page, pages)
  const slice = filtered.slice((cur - 1) * PAGE, cur * PAGE)
  const active = list.filter((c) => c.status === 'Active').length
  const mostUsed = [...list].sort((a, b) => b.products - a.products)[0]
  const nextCode = `SU${String(Math.max(...list.map((c) => parseInt(c.code.slice(2), 10))) + 1).padStart(2, '0')}`

  const save = (e: FormEvent) => {
    e.preventDefault()
    const code = (f.code || nextCode).toUpperCase().trim()
    if (!f.name.trim()) {
      setErr('Company name is required.')
      return
    }
    if (list.some((c) => c.code === code)) {
      setErr(`Code ${code} already exists.`)
      return
    }
    const short = f.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
    setList((l) => [
      {
        ...f,
        code,
        name: f.name.trim(),
        short,
        color: '#0E8A46',
        products: 0,
        city: f.address ? `${f.address}, ${f.country}` : f.country,
        updated: 'Just now',
      },
      ...l,
    ])
    setF({ ...emptyForm })
    setErr('')
    setPage(1)
  }

  return (
    <div className={`pco-page ${open ? 'with-panel' : ''}`}>
      <div className="pco-main">
        <div className="pco-head">
          <span className="pco-head-icon">
            <Building2 />
          </span>
          <div>
            <h1>Product Companies</h1>
            <p>Manage product manufacturing companies used in your business.</p>
          </div>
        </div>

        <div className="pco-kpis">
          <article>
            <span className="g">
              <Building2 />
            </span>
            <div>
              <small>Total Companies</small>
              <b>{list.length}</b>
              <em>Across all products</em>
            </div>
          </article>
          <article>
            <span className="g">
              <CheckCircle2 />
            </span>
            <div>
              <small>Active Companies</small>
              <b>{active}</b>
              <em>Currently in use</em>
            </div>
          </article>
          <article>
            <span className="n">
              <PauseCircle />
            </span>
            <div>
              <small>Inactive Companies</small>
              <b>{list.length - active}</b>
              <em>Not in use</em>
            </div>
          </article>
          <article>
            <span className="g">
              <Tag />
            </span>
            <div>
              <small>Most Used Company</small>
              <b>{mostUsed.code}</b>
              <em>{mostUsed.name.split(' ')[0]} Company</em>
            </div>
          </article>
        </div>

        <div className="pco-toolbar">
          <label className="pco-search">
            <Search />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(1)
              }}
              placeholder="Search companies..."
            />
          </label>
          <button className="pco-btn ghost">
            <Download /> Import Companies
          </button>
          <button className="pco-btn primary" onClick={() => setOpen(true)}>
            <Plus /> New Company
          </button>
        </div>
        <div className="pco-filters">
          <label className="pco-sel">
            <select>
              <option>All Companies</option>
              <option>Local</option>
              <option>Multinational</option>
            </select>
            <ChevronDown />
          </label>
          <label className="pco-sel">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              <option>All Statuses</option>
              <option>Active</option>
              <option>Inactive</option>
            </select>
            <ChevronDown />
          </label>
          <label className="pco-sel sort">
            <i>Sort by:</i>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option>Company Name</option>
              <option>Code</option>
              <option>Products</option>
            </select>
            <ChevronDown />
          </label>
          <div className="pco-seg">
            {(['All', 'Active', 'Inactive'] as const).map((s) => (
              <button
                key={s}
                className={scope === s ? 'active' : ''}
                onClick={() => {
                  setScope(s)
                  setPage(1)
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="pco-grid">
          {slice.map((c) => (
            <article className="pco-card" key={c.code}>
              <div className="pco-card-top">
                <span className="pco-logo" style={{ color: c.color }}>
                  {c.short}
                </span>
                <div className="pco-card-title">
                  <b>{c.code}</b>
                  <span>{c.name}</span>
                  <small>
                    <Package />
                    {c.products} Products
                  </small>
                </div>
                <span className={`pco-badge ${c.status === 'Active' ? 'on' : 'off'}`}>
                  {c.status}
                </span>
              </div>
              <div className="pco-meta">
                <span>
                  <MapPin />
                  {c.city}
                </span>
                <span>
                  <Clock3 />
                  Updated: {c.updated}
                </span>
              </div>
            </article>
          ))}
          {slice.length === 0 && <div className="pco-empty">No companies match your filters.</div>}
        </div>

        <div className="pco-foot">
          <span>
            Showing {filtered.length ? (cur - 1) * PAGE + 1 : 0}–
            {Math.min(cur * PAGE, filtered.length)} of {filtered.length} companies
          </span>
          <div className="pco-pager">
            <button
              aria-label="Previous page"
              disabled={cur === 1}
              onClick={() => setPage(cur - 1)}
            >
              <ChevronLeft />
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <button key={n} className={n === cur ? 'active' : ''} onClick={() => setPage(n)}>
                {n}
              </button>
            ))}
            <button
              aria-label="Next page"
              disabled={cur === pages}
              onClick={() => setPage(cur + 1)}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
      </div>

      {open && (
        <aside className="pco-panel">
          <div className="pco-panel-head">
            <div>
              <h2>Create New Company</h2>
              <p>Add a new product company to your system.</p>
            </div>
            <button className="pco-x" aria-label="Close" onClick={() => setOpen(false)}>
              <X />
            </button>
          </div>
          <form onSubmit={save} className="pco-form">
            <label>
              <span>
                Company Code <em>*</em>
              </span>
              <span className="pco-in">
                <input
                  value={f.code}
                  onChange={(e) => setF({ ...f, code: e.target.value })}
                  placeholder={`e.g. ${nextCode}`}
                />
                <i>
                  <Barcode />
                </i>
              </span>
            </label>
            <label>
              <span>
                Company Name <em>*</em>
              </span>
              <span className="pco-in">
                <input
                  value={f.name}
                  onChange={(e) => setF({ ...f, name: e.target.value })}
                  placeholder="Enter company name"
                />
              </span>
            </label>
            <div className="pco-status">
              <span>Status</span>
              <div>
                <button
                  type="button"
                  className={f.status === 'Active' ? 'on' : ''}
                  onClick={() => setF({ ...f, status: 'Active' })}
                >
                  <i />
                  Active
                </button>
                <button
                  type="button"
                  className={f.status === 'Inactive' ? 'on' : ''}
                  onClick={() => setF({ ...f, status: 'Inactive' })}
                >
                  <i />
                  Inactive
                </button>
              </div>
            </div>
            <label>
              <span>
                Address <small>(Optional)</small>
              </span>
              <span className="pco-in">
                <input
                  value={f.address}
                  onChange={(e) => setF({ ...f, address: e.target.value })}
                  placeholder="e.g. Gulberg, Lahore"
                />
              </span>
            </label>
            <label>
              <span>
                Country <small>(Optional)</small>
              </span>
              <span className="pco-in lead sel">
                <i className="flag">🇵🇰</i>
                <select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
                  <option>Pakistan</option>
                  <option>United Kingdom</option>
                  <option>United States</option>
                  <option>Switzerland</option>
                  <option>Denmark</option>
                </select>
                <ChevronDown className="chev" />
              </span>
            </label>
            <label>
              <span>
                Phone <small>(Optional)</small>
              </span>
              <span className="pco-in lead">
                <i>
                  <Phone />
                </i>
                <input
                  value={f.phone}
                  onChange={(e) => setF({ ...f, phone: e.target.value })}
                  placeholder="e.g. 021-1234567"
                />
              </span>
            </label>
            <label>
              <span>
                Email <small>(Optional)</small>
              </span>
              <span className="pco-in lead">
                <i>
                  <Mail />
                </i>
                <input
                  type="email"
                  value={f.email}
                  onChange={(e) => setF({ ...f, email: e.target.value })}
                  placeholder="e.g. info@company.com"
                />
              </span>
            </label>
            <label>
              <span>
                Website <small>(Optional)</small>
              </span>
              <span className="pco-in lead">
                <i>
                  <Link2 />
                </i>
                <input
                  value={f.website}
                  onChange={(e) => setF({ ...f, website: e.target.value })}
                  placeholder="e.g. www.company.com"
                />
              </span>
            </label>
            <label>
              <span>
                Notes <small>(Optional)</small>
              </span>
              <span className="pco-in">
                <textarea
                  value={f.notes}
                  onChange={(e) => setF({ ...f, notes: e.target.value })}
                  placeholder="Add any additional notes..."
                />
              </span>
            </label>
            {err && <div className="pco-err">{err}</div>}
            <div className="pco-panel-foot">
              <button
                type="button"
                className="pco-btn ghost plain"
                onClick={() => {
                  setF({ ...emptyForm })
                  setErr('')
                }}
              >
                Cancel
              </button>
              <button type="submit" className="pco-btn primary">
                <Save /> Save Company
              </button>
            </div>
          </form>
        </aside>
      )}
    </div>
  )
}
