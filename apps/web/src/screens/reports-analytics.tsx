'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowRight,
  Bell,
  Bookmark,
  BookOpen,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Clock3,
  Coins,
  Filter,
  Grid2x2,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  Rows3,
  Search,
  Settings2,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  TrendingUp,
  Layers,
  type LucideIcon,
} from 'lucide-react'
import type { AppData } from '@/mocks/api'

type Cat =
  | 'All Reports'
  | 'Inventory'
  | 'Movement'
  | 'Valuation'
  | 'Purchase'
  | 'Sales'
  | 'Analysis'
  | 'Products'
  | 'Operational'
type Report = {
  slug: string
  name: string
  desc: string
  icon: LucideIcon
  tone: string
  cat: Cat
  tags: string[]
  popular: number
}

const cats: { key: Cat; icon: LucideIcon }[] = [
  { key: 'All Reports', icon: LayoutGrid },
  { key: 'Inventory', icon: Boxes },
  { key: 'Movement', icon: RefreshCw },
  { key: 'Valuation', icon: Coins },
  { key: 'Purchase', icon: ShoppingCart },
  { key: 'Sales', icon: TrendingUp },
  { key: 'Analysis', icon: Clock3 },
  { key: 'Products', icon: Tag },
  { key: 'Operational', icon: Settings2 },
]
const featured: {
  eyebrow: string
  name: string
  desc: string
  icon: LucideIcon
  tone: string
  tags: string[]
  to: string
}[] = [
  {
    eyebrow: 'INVENTORY',
    name: 'Current Stock Report',
    desc: 'Get a complete view of current stock position across all products, warehouses and locations.',
    icon: Boxes,
    tone: 'green',
    tags: ['Inventory', 'Stock', 'Location'],
    to: '/inventory-reports',
  },
  {
    eyebrow: 'PURCHASE',
    name: 'Purchase History',
    desc: 'Analyze your purchase transactions and supplier-wise history.',
    icon: ShoppingCart,
    tone: 'grey',
    tags: ['Purchase', 'History', 'Supplier'],
    to: '/reports/purchases-register',
  },
  {
    eyebrow: 'SALES',
    name: 'Sales History',
    desc: 'Complete sales history with product, customer and performance insights.',
    icon: ChartNoAxesCombined,
    tone: 'blue',
    tags: ['Sales', 'History', 'Performance'],
    to: '/reports/sales-register',
  },
]
const reports: Report[] = [
  {
    slug: 'product-reports',
    name: 'Product List',
    desc: 'Complete product master list with details and classifications.',
    icon: Tag,
    tone: 'green',
    cat: 'Products',
    tags: ['Master Data', 'Products'],
    popular: 96,
  },
  {
    slug: 'ledgers',
    name: 'Product Ledger',
    desc: 'Detailed ledger for individual products.',
    icon: BookOpen,
    tone: 'green',
    cat: 'Products',
    tags: ['Ledger', 'Product'],
    popular: 84,
  },
  {
    slug: 'inventory/movements',
    name: 'Stock Movements',
    desc: 'Track all stock movements with filters.',
    icon: RefreshCw,
    tone: 'green',
    cat: 'Movement',
    tags: ['Movement', 'Audit'],
    popular: 91,
  },
  {
    slug: 'reports/stock-valuation',
    name: 'Inventory Valuation',
    desc: 'Stock valuation by cost method (average, FIFO, etc.).',
    icon: Coins,
    tone: 'amber',
    cat: 'Valuation',
    tags: ['Valuation', 'Financial'],
    popular: 88,
  },
  {
    slug: 'inventory/as-of',
    name: 'Stock Aging',
    desc: 'Analyze stock aging by product and category.',
    icon: Clock3,
    tone: 'blue',
    cat: 'Analysis',
    tags: ['Analysis', 'Aging'],
    popular: 72,
  },
  {
    slug: 'reports/expiry-exposure',
    name: 'Expiry Report',
    desc: 'Products nearing expiry with alerts.',
    icon: CalendarDays,
    tone: 'red',
    cat: 'Inventory',
    tags: ['Inventory', 'Expiry'],
    popular: 79,
  },
  {
    slug: 'procurement',
    name: 'Reorder Report',
    desc: 'Items below reorder level.',
    icon: Bell,
    tone: 'red',
    cat: 'Operational',
    tags: ['Inventory', 'Planning'],
    popular: 81,
  },
  {
    slug: 'product-reports',
    name: 'Dead Stock Report',
    desc: 'Identify non-moving products.',
    icon: CircleX,
    tone: 'red',
    cat: 'Analysis',
    tags: ['Analysis', 'Dead Stock'],
    popular: 64,
  },
  {
    slug: 'reports/purchases-register',
    name: 'Purchase Register',
    desc: 'Supplier invoices received with value and posting status.',
    icon: ShoppingCart,
    tone: 'grey',
    cat: 'Purchase',
    tags: ['Purchase', 'Register'],
    popular: 87,
  },
  {
    slug: 'reports/sales-register',
    name: 'Sales Register',
    desc: 'Every posted sale — mode, product, value and status.',
    icon: TrendingUp,
    tone: 'blue',
    cat: 'Sales',
    tags: ['Sales', 'Register'],
    popular: 94,
  },
  {
    slug: 'inventory-reports',
    name: 'Warehouse Stock',
    desc: 'Stock split by warehouse and shop location.',
    icon: Layers,
    tone: 'green',
    cat: 'Inventory',
    tags: ['Inventory', 'Warehouse'],
    popular: 70,
  },
  {
    slug: 'reports',
    name: 'Financial Statements',
    desc: 'Income statement, balance sheet and trial balance.',
    icon: ChartNoAxesCombined,
    tone: 'green',
    cat: 'Valuation',
    tags: ['Finance', 'Statements'],
    popular: 90,
  },
]

export function ReportsAnalytics({ data }: { data: AppData }) {
  const navigate = useNavigate()
  const [cat, setCat] = useState<Cat>('All Reports')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('Most Popular')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [saved, setSaved] = useState<string[]>([])
  const [slide, setSlide] = useState(0)
  const [from, setFrom] = useState('2026-09-01'),
    [to, setTo] = useState('2026-09-15')

  const list = useMemo(() => {
    const rows = reports.filter(
      (r) =>
        (cat === 'All Reports' || r.cat === cat) &&
        `${r.name} ${r.desc} ${r.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
    )
    return sort === 'Most Popular'
      ? [...rows].sort((a, b) => b.popular - a.popular)
      : sort === 'Name (A–Z)'
        ? [...rows].sort((a, b) => a.name.localeCompare(b.name))
        : rows
  }, [cat, query, sort])
  const cards = featured
    .slice(slide, slide + 3)
    .concat(featured.slice(0, Math.max(0, slide + 3 - featured.length)))
    .slice(0, 3)
  const toggle = (name: string) =>
    setSaved((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
  const go = (slug: string) => navigate(`/${slug}`.replace('//', '/'))

  return (
    <div className="ra-page">
      <section className="ra-hero">
        <div className="ra-hero-copy">
          <span className="ra-eyebrow">Reports Center</span>
          <h1>
            Turn Your Inventory Data
            <br />
            Into Smarter Decisions.
          </h1>
          <p>
            Create, view and export reports to get complete insights into your trading business.
          </p>
        </div>
        <em className="ra-script">
          Data
          <br />
          Drives
          <br />
          Better
          <br />
          Trading
        </em>
        <svg className="ra-art" viewBox="0 0 260 150" aria-hidden="true">
          <rect
            x="96"
            y="18"
            width="78"
            height="104"
            rx="4"
            fill="#fff"
            stroke="#dde7e0"
            transform="rotate(-6 135 70)"
          />
          <rect x="132" y="26" width="80" height="106" rx="4" fill="#fff" stroke="#dde7e0" />
          <rect x="142" y="40" width="46" height="5" rx="2" fill="#dbe6df" />
          <rect x="142" y="52" width="60" height="4" rx="2" fill="#eaf1ec" />
          <rect x="146" y="70" width="9" height="34" fill="#cfe6d7" />
          <rect x="159" y="82" width="9" height="22" fill="#9ed2b3" />
          <rect x="172" y="62" width="9" height="42" fill="#1f8a4c" />
          <rect x="185" y="76" width="9" height="28" fill="#cfe6d7" />
          <path
            d="M104 92 L118 72 L130 84 L146 56"
            fill="none"
            stroke="#1f8a4c"
            strokeWidth="2.5"
            transform="rotate(-6 135 70)"
          />
          <circle cx="228" cy="96" r="22" fill="#eaf4ee" />
          <path d="M228 96 L228 74 A22 22 0 0 1 247 107 Z" fill="#1f8a4c" />
          <ellipse cx="62" cy="128" rx="34" ry="8" fill="#dcece2" />
          <path d="M62 126 C40 112 34 88 46 72 C60 84 66 104 62 126Z" fill="#4faa73" />
          <path d="M62 126 C82 110 90 86 78 68 C62 82 58 104 62 126Z" fill="#2f8b52" />
          <rect x="52" y="120" width="20" height="16" rx="3" fill="#cfe0d5" />
        </svg>
        <aside className="ra-badge">
          <ChartNoAxesCombined />
          <b>
            Accurate
            <br />
            Insights
          </b>
          <b>
            Profitable
            <br />
            Growth
          </b>
        </aside>
      </section>

      <section className="ra-finder">
        <div className="ra-finder-top">
          <span className="ra-finder-ico">
            <Filter />
          </span>
          <div className="ra-finder-title">
            <b>Find the right report</b>
            <small>Set your filters and search to get exactly the data you need.</small>
          </div>
          <label className="ra-fld">
            <span>Date Range</span>
            <div className="ra-range">
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
            </div>
          </label>
          <label className="ra-fld">
            <span>Warehouse</span>
            <div className="ra-sel">
              <Boxes />
              <select aria-label="Warehouse">
                <option>All Warehouses</option>
                <option>Main Warehouse</option>
                <option>Shop DHA</option>
              </select>
            </div>
          </label>
          <label className="ra-fld">
            <span>Product / SKU</span>
            <div className="ra-sel">
              <Layers />
              <select aria-label="Product">
                <option>All Products</option>
                {data.products.slice(0, 8).map((p) => (
                  <option key={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </label>
          <label className="ra-fld">
            <span>Company / Principal</span>
            <div className="ra-sel">
              <ChartNoAxesCombined />
              <select aria-label="Company">
                <option>All Companies</option>
                {[...new Set(data.products.map((p) => p.supplier))].slice(0, 8).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          </label>
        </div>
        <div className="ra-finder-row">
          <label className="ra-search">
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reports, products, SKU or keywords..."
            />
          </label>
          <div className="ra-sel sm">
            <select aria-label="Location">
              <option>All Locations</option>
              <option>Lahore</option>
              <option>Karachi</option>
            </select>
          </div>
          <div className="ra-sel sm">
            <select aria-label="Class">
              <option>All Classes</option>
              <option>Medicines</option>
              <option>Personal Care</option>
            </select>
          </div>
          <div className="ra-sel sm">
            <select aria-label="Stock status">
              <option>All Stock Status</option>
              <option>In stock</option>
              <option>Low stock</option>
            </select>
          </div>
          <button className="ra-btn solid">
            <Search /> Search Reports
          </button>
          <button
            className="ra-btn ghost"
            onClick={() => {
              setQuery('')
              setCat('All Reports')
            }}
          >
            <RefreshCw /> Clear All
          </button>
        </div>
      </section>

      <section className="ra-cats">
        <div className="ra-cats-title">
          <Star />
          <div>
            <b>Report Categories</b>
            <small>Browse reports by category to quickly find what you need.</small>
          </div>
        </div>
        <div className="ra-cat-pills">
          {cats.map((c) => {
            const I = c.icon
            return (
              <button
                key={c.key}
                className={cat === c.key ? 'on' : ''}
                onClick={() => setCat(c.key)}
              >
                <I />
                {c.key}
              </button>
            )
          })}
        </div>
      </section>

      <section className="ra-featured">
        <header>
          <Star className="ra-star" />
          <div>
            <b>Featured Reports</b>
            <small>Most used reports to keep your business on track.</small>
          </div>
          <button
            className="ra-round"
            aria-label="Previous featured"
            onClick={() => setSlide((s) => (s + featured.length - 1) % featured.length)}
          >
            <ChevronLeft />
          </button>
          <button
            className="ra-round"
            aria-label="Next featured"
            onClick={() => setSlide((s) => (s + 1) % featured.length)}
          >
            <ChevronRight />
          </button>
          <button className="ra-btn" onClick={() => setCat('All Reports')}>
            View All Reports <ArrowRight />
          </button>
        </header>
        <div className="ra-feat-grid">
          {cards.map((f) => {
            const I = f.icon
            return (
              <article key={f.name} className={`ra-feat ${f.tone}`} onClick={() => navigate(f.to)}>
                <span className="ra-feat-ico">
                  <I />
                </span>
                <small>{f.eyebrow}</small>
                <h3>{f.name}</h3>
                <p>{f.desc}</p>
                <div className="ra-tags">
                  {f.tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
                <button className="ra-round go" aria-label={`Open ${f.name}`}>
                  <ArrowRight />
                </button>
              </article>
            )
          })}
        </div>
      </section>

      <section className="ra-all">
        <header>
          <Grid2x2 />
          <div>
            <b>All Reports</b>
            <small>
              Explore all available reports. Click on a report to generate and view detailed
              insights.
            </small>
          </div>
          <span className="ra-sort">
            Sort by{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
              <option>Most Popular</option>
              <option>Name (A–Z)</option>
              <option>Default</option>
            </select>
          </span>
          <button
            className={`ra-view ${view === 'grid' ? 'on' : ''}`}
            aria-label="Grid view"
            onClick={() => setView('grid')}
          >
            <Grid2x2 />
          </button>
          <button
            className={`ra-view ${view === 'list' ? 'on' : ''}`}
            aria-label="List view"
            onClick={() => setView('list')}
          >
            <Rows3 />
          </button>
        </header>
        <div className={`ra-grid ${view}`}>
          {list.map((r, i) => {
            const I = r.icon
            return (
              <article key={`${r.name}-${i}`} className="ra-card" onClick={() => go(r.slug)}>
                <span className={`ra-card-ico ${r.tone}`}>
                  <I />
                </span>
                <div className="ra-card-main">
                  <h4>{r.name}</h4>
                  <p>{r.desc}</p>
                  <div className="ra-tags">
                    {r.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </div>
                <button
                  className={`ra-save ${saved.includes(r.name) ? 'on' : ''}`}
                  aria-label={`${saved.includes(r.name) ? 'Remove' : 'Save'} ${r.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(r.name)
                  }}
                >
                  <Bookmark />
                </button>
                <button className="ra-round go" aria-label={`Open ${r.name}`}>
                  <ArrowRight />
                </button>
              </article>
            )
          })}
          {!list.length && (
            <div className="ra-empty">
              <Sparkles /> No reports match your filters.
            </div>
          )}
        </div>
      </section>

      <p className="ra-foot">
        <ListChecks /> {list.length} of {reports.length} reports shown
        {cat !== 'All Reports' ? ` in ${cat}` : ''}
        {saved.length ? ` · ${saved.length} saved` : ''}
      </p>
    </div>
  )
}
