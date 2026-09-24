'use client'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowUpDown,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  Eye,
  FileText,
  Info,
  LayoutList,
  MoreVertical,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react'

/* ---------- model ---------- */
export type CatalogueProduct = {
  code: string
  name: string
  upc: string
  company: string
  klass: string
  pack: string
  loose: string
  distributor: string
  shelf: string
  purchase: number
  retail: number
  wprice: number
  cost: number
  high: number
  low: number
  finDisc: number
  stock: number
  short: boolean
  expiry: boolean
  narcotic: boolean
  precious: boolean
  status: 'Active' | 'Draft' | 'Inactive'
}
const companies = ['P&G', 'UNILEVER', 'HAWAYT KAYMA', 'NESTLÉ', 'RECKITT', 'COLGATE', 'J&J']
const classes = ['FEMININE', 'BEAUTY', 'OTC', 'ORAL CARE', 'HOME CARE', 'BABY CARE', 'FOOD']
const packs = ['Pack of 6', 'Pack of 10', 'Pack of 12', 'Pack of 24', 'Carton']
const looses = ['Piece', 'Sachet', 'Bottle', 'Tube']
const distributors = ['Al-Karam Traders', 'Metro Distribution', 'Sadiq Bros.', 'Premier Agencies']
const shelves = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

const base = (
  code: string,
  name: string,
  upc: string,
  company: string,
  klass: string,
  purchase: number,
  retail: number,
  wprice: number,
  stock: number,
  shelf: string,
  extra: Partial<CatalogueProduct> = {},
): CatalogueProduct => ({
  code,
  name,
  upc,
  company,
  klass,
  pack: 'Pack of 12',
  loose: 'Piece',
  distributor: 'Al-Karam Traders',
  shelf,
  purchase,
  retail,
  wprice,
  cost: Math.round(purchase / 12),
  high: 240,
  low: 24,
  finDisc: 0,
  stock,
  short: false,
  expiry: false,
  narcotic: false,
  precious: false,
  status: 'Active',
  ...extra,
})

const seedCatalogue: CatalogueProduct[] = [
  base('PR423', 'Motile Mega No.2', '423', 'HAWAYT KAYMA', 'OTC', 351.31, 348, 340, 142, 'A1', {
    expiry: true,
  }),
  base('PR412', '8 NOV BUK Uni', '412', 'UNILEVER', 'BEAUTY', 580, 567, 550, 5, 'A1', {
    precious: true,
  }),
  base('PR152', 'ALWAYS EXTRA SOFT LONG', '152', 'P&G', 'FEMININE', 701, 543, 520, 18, 'A2'),
  base('PR153', 'ALWAYS EXTRA SOFT LONG VP', '153', 'P&G', 'FEMININE', 510, 348, 335, 64, 'A2'),
  base('PR148', 'ALWAYS MAXI NIGHT', '148', 'P&G', 'FEMININE', 581, 543, 525, 120, 'A2'),
  base('PR155', 'ALWAYS MAXI NIGHT WP', '155', 'P&G', 'FEMININE', 701, 548, 530, 85, 'A2'),
  base('PR159', 'ALWAYS MAXI THICK', '147', 'P&G', 'FEMININE', 701, 687, 660, 12, 'A2', {
    short: true,
  }),
  base('PR149', 'ALWAYS MAXI THICK ALL PACK', '149', 'P&G', 'FEMININE', 600, 548, 530, 36, 'A2'),
  base('PR151', 'ALWAYS SOFT LONG', '151', 'P&G', 'FEMININE', 701, 567, 545, 9, 'A2'),
  base('PR158', 'ALWAYS TRIPLE PACK MAXI', '158', 'P&G', 'FEMININE', 701, 1118, 1080, 75, 'A2'),
  base(
    'PR161',
    'ALWAYS TRIPLE PACK MAXI NIGHT',
    '159',
    'P&G',
    'FEMININE',
    600,
    1118,
    1080,
    62,
    'A1',
  ),
  base('PR160', 'ALWAYS ULTRA LARGE', '150', 'P&G', 'FEMININE', 700, 348, 335, 3, 'A2', {
    short: true,
  }),
  base('PR157', 'ALWAYS ULTRA LARGE VIP', '157', 'P&G', 'FEMININE', 1180, 687, 660, 48, 'A2'),
  base('PR162', 'ALWAYS ULTRA NORMAL', '149', 'P&G', 'FEMININE', 1131, 348, 335, 91, 'A2'),
  base('PR156', 'ALWAYS ULTRA NORMAL VP', '156', 'P&G', 'FEMININE', 701, 343, 330, 66, 'A2'),
  base('PR201', 'PANTENE SHAMPOO 360ML', '201', 'P&G', 'BEAUTY', 890, 1020, 980, 54, 'B1'),
  base('PR202', 'HEAD & SHOULDERS 400ML', '202', 'P&G', 'BEAUTY', 920, 1090, 1040, 21, 'B1'),
  base('PR203', 'GILLETTE MACH3 CARTRIDGE', '203', 'P&G', 'BEAUTY', 1450, 1690, 1620, 14, 'B1', {
    precious: true,
  }),
  base('PR204', 'ORAL-B TOOTHBRUSH MEDIUM', '204', 'P&G', 'ORAL CARE', 180, 240, 225, 130, 'B2'),
  base('PR205', 'ARIEL POWDER 1KG', '205', 'P&G', 'HOME CARE', 560, 640, 615, 88, 'C1'),
  base('PR301', 'DOVE SOAP 100G', '301', 'UNILEVER', 'BEAUTY', 110, 145, 135, 210, 'B1'),
  base('PR302', 'SUNSILK SHAMPOO 200ML', '302', 'UNILEVER', 'BEAUTY', 320, 390, 370, 44, 'B1'),
  base('PR303', 'SURF EXCEL 1KG', '303', 'UNILEVER', 'HOME CARE', 540, 620, 600, 7, 'C1'),
  base('PR304', 'LIFEBUOY SOAP 125G', '304', 'UNILEVER', 'BEAUTY', 95, 120, 112, 175, 'B2'),
  base('PR305', 'CLOSEUP TOOTHPASTE 150G', '305', 'UNILEVER', 'ORAL CARE', 210, 265, 250, 39, 'B2'),
  base('PR401', 'NESCAFÉ CLASSIC 50G', '401', 'NESTLÉ', 'FOOD', 480, 560, 540, 26, 'C2', {
    expiry: true,
  }),
  base('PR402', 'CERELAC WHEAT 175G', '402', 'NESTLÉ', 'BABY CARE', 410, 480, 460, 16, 'C2', {
    expiry: true,
  }),
  base('PR403', 'MILKPAK 1L', '403', 'NESTLÉ', 'FOOD', 230, 260, 250, 240, 'C2', { expiry: true }),
  base('PR501', 'DETTOL ANTISEPTIC 250ML', '501', 'RECKITT', 'OTC', 420, 495, 475, 58, 'A1', {
    expiry: true,
  }),
  base('PR502', 'HARPIC 500ML', '502', 'RECKITT', 'HOME CARE', 260, 310, 295, 33, 'C1'),
  base('PR503', 'STREPSILS HONEY 24S', '503', 'RECKITT', 'OTC', 180, 225, 215, 4, 'A1', {
    expiry: true,
  }),
  base('PR601', 'COLGATE MAX FRESH 125G', '601', 'COLGATE', 'ORAL CARE', 190, 240, 228, 72, 'B2'),
  base('PR602', 'PALMOLIVE SHOWER GEL 500ML', '602', 'COLGATE', 'BEAUTY', 520, 610, 590, 11, 'B1'),
  base('PR701', 'J&J BABY POWDER 200G', '701', 'J&J', 'BABY CARE', 330, 395, 380, 47, 'C2', {
    expiry: true,
  }),
  base('PR702', 'J&J BABY SHAMPOO 200ML', '702', 'J&J', 'BABY CARE', 360, 430, 415, 29, 'C2', {
    expiry: true,
  }),
  base('PR703', 'BENADRYL SYRUP 100ML', '703', 'J&J', 'OTC', 290, 350, 335, 8, 'A1', {
    narcotic: true,
    expiry: true,
  }),
]

const emptyForm = {
  code: '',
  upc: '',
  name: '',
  pack: '',
  loose: '',
  company: '',
  distributor: '',
  shelf: '',
  purchase: '',
  retail: '',
  wprice: '',
  cost: '',
  high: '',
  low: '',
  finDisc: '',
  klass: '',
  short: false,
  expiry: false,
  narcotic: false,
  precious: false,
}
type Form = typeof emptyForm
const toForm = (p: CatalogueProduct): Form => ({
  code: p.code,
  upc: p.upc,
  name: p.name,
  pack: p.pack,
  loose: p.loose,
  company: p.company,
  distributor: p.distributor,
  shelf: p.shelf,
  purchase: String(p.purchase),
  retail: String(p.retail),
  wprice: String(p.wprice),
  cost: String(p.cost),
  high: String(p.high),
  low: String(p.low),
  finDisc: String(p.finDisc),
  klass: p.klass,
  short: p.short,
  expiry: p.expiry,
  narcotic: p.narcotic,
  precious: p.precious,
})

const STORE = 'finsoft-catalogue-v1'
function load(): CatalogueProduct[] {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) {
      const l = JSON.parse(raw)
      if (Array.isArray(l) && l.every((p) => p && typeof p.code === 'string')) return l
    }
  } catch {
    /* ignore */
  }
  return seedCatalogue
}

const tabs = [
  'All',
  'By Company',
  'By Class',
  'Shelf',
  'Short Items',
  'Expiry Required',
  'Precious',
  'Narcotics',
  'Stock List',
] as const
type Tab = (typeof tabs)[number]
const sorts: Record<string, (a: CatalogueProduct, b: CatalogueProduct) => number> = {
  'Product Name A - Z': (a, b) => a.name.localeCompare(b.name),
  'Product Name Z - A': (a, b) => b.name.localeCompare(a.name),
  Code: (a, b) => a.code.localeCompare(b.code),
  'Stock: Low to High': (a, b) => a.stock - b.stock,
  'Stock: High to Low': (a, b) => b.stock - a.stock,
  'Retail Price': (a, b) => b.retail - a.retail,
}
const stockTone = (p: CatalogueProduct) =>
  p.stock <= Math.max(1, Math.round(p.low / 4)) ? 'red' : p.stock <= p.low ? 'amber' : 'green'
const num = (n: number) => (n % 1 ? n.toFixed(2) : String(n))

/* ---------- small pieces ---------- */
function Sel({
  label,
  value,
  onChange,
  options,
  icon,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  icon?: ReactNode
}) {
  return (
    <label className="cat-filter">
      <span>{label}</span>
      <span className="cat-sel">
        {icon}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <ChevronDown className="cat-caret" />
      </span>
    </label>
  )
}
function FSel({
  label,
  required,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string
  required?: boolean
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
}) {
  return (
    <label className="cat-ff">
      <span>
        {label}
        {required && <em>*</em>}
      </span>
      <span className="cat-sel">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <ChevronDown className="cat-caret" />
      </span>
    </label>
  )
}
function FIn({
  label,
  required,
  value,
  onChange,
  placeholder,
  type,
  error,
}: {
  label: string
  required?: boolean
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: string
  error?: string
}) {
  return (
    <label className={`cat-ff ${error ? 'err' : ''}`}>
      <span>
        {label}
        {required && <em>*</em>}
      </span>
      <input
        type={type ?? 'text'}
        min={type === 'number' ? 0 : undefined}
        step={type === 'number' ? '0.01' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {error && <small>{error}</small>}
    </label>
  )
}
function Section({
  icon,
  title,
  sub,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode
  title: string
  sub: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={`cat-sec ${open ? 'open' : ''}`}>
      <button type="button" className="cat-sec-head" aria-expanded={open} onClick={onToggle}>
        <span className="cat-sec-ic">{icon}</span>
        <span>
          <b>{title}</b>
          <small>{sub}</small>
        </span>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && <div className="cat-sec-body">{children}</div>}
    </div>
  )
}

/* ---------- modal ---------- */
function ProductModal({
  initial,
  edit,
  existing,
  onClose,
  onSave,
}: {
  initial?: CatalogueProduct
  edit: boolean
  existing: CatalogueProduct[]
  onClose: () => void
  onSave: (p: CatalogueProduct, draft: boolean) => void
}) {
  const [f, setF] = useState<Form>(initial ? toForm(initial) : emptyForm)
  const [sec, setSec] = useState({ basic: true, pricing: true, klass: true })
  const [tried, setTried] = useState(false)
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }))
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    firstRef.current?.focus()
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const dup = !edit && existing.some((p) => p.code.toLowerCase() === f.code.trim().toLowerCase())
  const errors = {
    code: !f.code.trim() ? 'Product code is required' : dup ? 'This code already exists' : '',
    name: !f.name.trim() ? 'Product name is required' : '',
    pack: !f.pack ? 'Select a pack' : '',
    company: !f.company ? 'Select a company' : '',
    purchase: f.purchase === '' || Number(f.purchase) < 0 ? 'Enter purchase price' : '',
    retail: f.retail === '' || Number(f.retail) < 0 ? 'Enter retail price' : '',
    klass: !f.klass ? 'Select a class' : '',
    shelf:
      f.shelf && !/^[A-Za-z]{1,2}\d{1,3}$/.test(f.shelf.trim())
        ? 'Use letters then 1–3 digits (e.g. A1, PR12)'
        : '',
  }
  const invalid = Object.values(errors).some(Boolean)
  const build = (status: CatalogueProduct['status']): CatalogueProduct => ({
    code: f.code.trim().toUpperCase(),
    name: f.name.trim(),
    upc: f.upc.trim(),
    company: f.company,
    klass: f.klass,
    pack: f.pack,
    loose: f.loose,
    distributor: f.distributor,
    shelf: f.shelf.trim().toUpperCase(),
    purchase: Number(f.purchase) || 0,
    retail: Number(f.retail) || 0,
    wprice: Number(f.wprice) || 0,
    cost: Number(f.cost) || 0,
    high: Number(f.high) || 0,
    low: Number(f.low) || 0,
    finDisc: Number(f.finDisc) || 0,
    stock: edit ? (initial?.stock ?? 0) : 0,
    short: f.short,
    expiry: f.expiry,
    narcotic: f.narcotic,
    precious: f.precious,
    status,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (invalid) {
      setSec({ basic: true, pricing: true, klass: true })
      return
    }
    onSave(build('Active'), false)
  }
  const draft = () => {
    if (!f.code.trim() || !f.name.trim()) {
      setTried(true)
      return
    }
    onSave(build('Draft'), true)
  }
  const err = (k: keyof typeof errors) => (tried ? errors[k] : undefined)
  return (
    <div
      className="cat-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        className="cat-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cat-modal-title"
        onSubmit={submit}
        noValidate
      >
        <div className="cat-modal-head">
          <span className="cat-modal-ic">
            <Package />
          </span>
          <div>
            <h2 id="cat-modal-title">{edit ? 'Edit Product' : 'New Product'}</h2>
            <p>
              {edit ? `Update ${initial?.code} details` : 'Add a new product to your inventory'}
            </p>
          </div>
          <button type="button" className="cat-x" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="cat-modal-body">
          <Section
            icon={<FileText />}
            title="Basic Information"
            sub="Enter the essential product details"
            open={sec.basic}
            onToggle={() => setSec((s) => ({ ...s, basic: !s.basic }))}
          >
            <div className="cat-fgrid c3">
              <label className={`cat-ff ${err('code') ? 'err' : ''}`}>
                <span>
                  Product Code<em>*</em>
                </span>
                <input
                  ref={firstRef}
                  value={f.code}
                  onChange={(e) => set({ code: e.target.value })}
                  placeholder="Enter product code"
                  readOnly={edit}
                />
                {err('code') && <small>{errors.code}</small>}
              </label>
              <FIn
                label="UPC"
                value={f.upc}
                onChange={(v) => set({ upc: v })}
                placeholder="Enter UPC code"
              />
              <FIn
                label="Product Name"
                required
                value={f.name}
                onChange={(v) => set({ name: v })}
                placeholder="Enter product name"
                error={err('name')}
              />
            </div>
            <div className="cat-fgrid c4">
              <FSel
                label="Pack"
                required
                value={f.pack}
                onChange={(v) => set({ pack: v })}
                options={packs}
                placeholder="Select pack"
              />
              <FSel
                label="Loose"
                value={f.loose}
                onChange={(v) => set({ loose: v })}
                options={looses}
                placeholder="Select loose unit"
              />
              <FSel
                label="Company"
                required
                value={f.company}
                onChange={(v) => set({ company: v })}
                options={companies}
                placeholder="Select company"
              />
              <FSel
                label="Distributor"
                value={f.distributor}
                onChange={(v) => set({ distributor: v })}
                options={distributors}
                placeholder="Select distributor"
              />
            </div>
            {tried && (errors.pack || errors.company) && (
              <small className="cat-err-line">{errors.pack || errors.company}</small>
            )}
            <div className="cat-fgrid c3">
              <FIn
                label="Shelf #"
                value={f.shelf}
                onChange={(v) => set({ shelf: v })}
                placeholder="Enter shelf number"
                error={err('shelf')}
              />
            </div>
          </Section>
          <Section
            icon={<Database />}
            title="Pricing & Inventory"
            sub="Set pricing, stock levels, and other inventory details"
            open={sec.pricing}
            onToggle={() => setSec((s) => ({ ...s, pricing: !s.pricing }))}
          >
            <div className="cat-fgrid c4">
              <FIn
                label="Purchase Price"
                required
                type="number"
                value={f.purchase}
                onChange={(v) => set({ purchase: v })}
                placeholder="Enter purchase price"
                error={err('purchase')}
              />
              <FIn
                label="Retail Price"
                required
                type="number"
                value={f.retail}
                onChange={(v) => set({ retail: v })}
                placeholder="Enter retail price"
                error={err('retail')}
              />
              <FIn
                label="W. Price"
                type="number"
                value={f.wprice}
                onChange={(v) => set({ wprice: v })}
                placeholder="Enter W price"
              />
              <FIn
                label="Cost / Unit"
                type="number"
                value={f.cost}
                onChange={(v) => set({ cost: v })}
                placeholder="Enter cost per unit"
              />
            </div>
            <div className="cat-fgrid c3">
              <FIn
                label="High Level"
                type="number"
                value={f.high}
                onChange={(v) => set({ high: v })}
                placeholder="Enter high level"
              />
              <FIn
                label="Low Level"
                type="number"
                value={f.low}
                onChange={(v) => set({ low: v })}
                placeholder="Enter low level"
              />
              <FIn
                label="% Fin Disc."
                type="number"
                value={f.finDisc}
                onChange={(v) => set({ finDisc: v })}
                placeholder="Enter discount %"
              />
            </div>
          </Section>
          <Section
            icon={<Tag />}
            title="Classification"
            sub="Assign class, shelf and special attributes"
            open={sec.klass}
            onToggle={() => setSec((s) => ({ ...s, klass: !s.klass }))}
          >
            <div className="cat-class-row">
              <div>
                <FSel
                  label="Class"
                  required
                  value={f.klass}
                  onChange={(v) => set({ klass: v })}
                  options={classes}
                  placeholder="Select class"
                />
                {err('klass') && <small className="cat-err-line">{errors.klass}</small>}
              </div>
              <fieldset className="cat-attrs">
                <legend>Special Attributes</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={f.short}
                    onChange={(e) => set({ short: e.target.checked })}
                  />
                  Short Item <span>(No discount during sale)</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={f.expiry}
                    onChange={(e) => set({ expiry: e.target.checked })}
                  />
                  Required Expiry <span>(Expiry date must be entered)</span>
                </label>
                <div className="cat-attrs-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={f.narcotic}
                      onChange={(e) => set({ narcotic: e.target.checked })}
                    />
                    Narcotics Item
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={f.precious}
                      onChange={(e) => set({ precious: e.target.checked })}
                    />
                    Precious Item
                  </label>
                </div>
              </fieldset>
            </div>
            <div className="cat-notes">
              <span className="cat-notes-ic">
                <Info />
              </span>
              <div>
                <b>Important Notes</b>
                <ul>
                  <li>
                    <b>Short Item:</b> Discount not allowed on short items during sale.
                  </li>
                  <li>
                    <b>Required Expiry:</b> Expiry date must be fed in Purchase Voucher.
                  </li>
                  <li>
                    <b>Shelf Name:</b> Use first two characters and then numbers up to three digits
                    (e.g. A1, PR12, CN1).
                  </li>
                </ul>
              </div>
            </div>
          </Section>
        </div>
        <div className="cat-modal-foot">
          <button
            type="button"
            className="cat-btn ghost"
            onClick={() => {
              setF(initial ? toForm(initial) : emptyForm)
              setTried(false)
            }}
          >
            <RotateCcw /> Clear
          </button>
          <span className="cat-grow" />
          <button type="button" className="cat-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cat-btn outline" onClick={draft}>
            <Save /> Save Draft
          </button>
          <button type="submit" className="cat-btn primary">
            <Save /> {edit ? 'Save Changes' : 'Save Product'}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ---------- page ---------- */
export function ProductCatalogue({ canCreate = true }: { canCreate?: boolean }) {
  const [items, setItems] = useState<CatalogueProduct[]>(load)
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(items))
    } catch {
      /* ignore */
    }
  }, [items])
  const [scope, setScope] = useState('All Products'),
    [company, setCompany] = useState('All Companies'),
    [klass, setKlass] = useState('All Classes'),
    [shelf, setShelf] = useState('All Shelves'),
    [attr, setAttr] = useState('None')
  const [min, setMin] = useState(''),
    [max, setMax] = useState(''),
    [q, setQ] = useState(''),
    [view, setView] = useState('Detail'),
    [sort, setSort] = useState('Product Name A - Z')
  const [tab, setTab] = useState<Tab>('All'),
    [page, setPage] = useState(1),
    [per, setPer] = useState(15)
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState<string | null>(null)
  const [modal, setModal] = useState<{ open: boolean; edit?: CatalogueProduct }>({ open: false })
  const [toast, setToast] = useState('')
  const [focusCode, setFocusCode] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    if (!menu) return
    const h = () => setMenu(null)
    window.addEventListener('click', h)
    return () => window.removeEventListener('click', h)
  }, [menu])

  const counts = useMemo(
    () =>
      ({
        All: items.length,
        'Short Items': items.filter((p) => p.short).length,
        'Expiry Required': items.filter((p) => p.expiry).length,
        Precious: items.filter((p) => p.precious).length,
        Narcotics: items.filter((p) => p.narcotic).length,
      }) as Partial<Record<Tab, number>>,
    [items],
  )

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return items
      .filter(
        (p) =>
          (scope === 'All Products' ||
            (scope === 'Active' && p.status === 'Active') ||
            (scope === 'Drafts' && p.status === 'Draft') ||
            (scope === 'Inactive' && p.status === 'Inactive') ||
            (scope === 'Low Stock' && p.stock <= p.low)) &&
          (company === 'All Companies' || p.company === company) &&
          (klass === 'All Classes' || p.klass === klass) &&
          (shelf === 'All Shelves' || p.shelf === shelf) &&
          (attr === 'None' ||
            (attr === 'Short Item' && p.short) ||
            (attr === 'Required Expiry' && p.expiry) ||
            (attr === 'Narcotics' && p.narcotic) ||
            (attr === 'Precious' && p.precious)) &&
          (min === '' || p.stock >= Number(min)) &&
          (max === '' || p.stock <= Number(max)) &&
          (!s ||
            [p.code, p.name, p.upc, p.company, p.klass].some((v) => v.toLowerCase().includes(s))) &&
          (tab === 'Short Items'
            ? p.short
            : tab === 'Expiry Required'
              ? p.expiry
              : tab === 'Precious'
                ? p.precious
                : tab === 'Narcotics'
                  ? p.narcotic
                  : true),
      )
      .sort(sorts[sort] ?? sorts['Product Name A - Z'])
  }, [items, scope, company, klass, shelf, attr, min, max, q, tab, sort])

  const groupKey = useMemo(
    () =>
      tab === 'By Company'
        ? (p: CatalogueProduct) => p.company
        : tab === 'By Class'
          ? (p: CatalogueProduct) => p.klass
          : tab === 'Shelf'
            ? (p: CatalogueProduct) => `Shelf ${p.shelf || '—'}`
            : null,
    [tab],
  )
  const ordered = useMemo(
    () =>
      groupKey
        ? [...filtered].sort(
            (a, b) =>
              groupKey(a).localeCompare(groupKey(b)) ||
              (sorts[sort] ?? sorts['Product Name A - Z'])(a, b),
          )
        : filtered,
    [filtered, groupKey, sort],
  )
  const pages = Math.max(1, Math.ceil(ordered.length / per))
  const focusIdx = focusCode ? ordered.findIndex((p) => p.code === focusCode) : -1
  const cur = focusIdx >= 0 ? Math.floor(focusIdx / per) + 1 : Math.min(page, pages)
  const rows = ordered.slice((cur - 1) * per, cur * per)
  useEffect(() => {
    if (!focusCode) return
    const t = setTimeout(() => {
      setPage(cur)
      setFocusCode(null)
    }, 2500)
    return () => clearTimeout(t)
  }, [focusCode, cur])
  const stockList = tab === 'Stock List'
  const activeFilters = [
    scope !== 'All Products' && scope,
    company !== 'All Companies' && company,
    klass !== 'All Classes' && klass,
    shelf !== 'All Shelves' && shelf,
    attr !== 'None' && attr,
    (min || max) && `Stock ${min || 0}–${max || '∞'}`,
    q && `"${q}"`,
  ].filter(Boolean) as string[]
  const clear = () => {
    setScope('All Products')
    setCompany('All Companies')
    setKlass('All Classes')
    setShelf('All Shelves')
    setAttr('None')
    setMin('')
    setMax('')
    setQ('')
    setTab('All')
    setPage(1)
  }
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.code))
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s)
      if (allChecked) rows.forEach((r) => n.delete(r.code))
      else rows.forEach((r) => n.add(r.code))
      return n
    })
  const toggle = (c: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n
    })

  const save = (p: CatalogueProduct, draft: boolean) => {
    setItems((l) => (modal.edit ? l.map((x) => (x.code === modal.edit!.code ? p : x)) : [p, ...l]))
    setModal({ open: false })
    setFocusCode(p.code)
    setPage(1)
    setToast(
      modal.edit
        ? `${p.code} updated`
        : draft
          ? `${p.code} saved as draft`
          : `${p.name} added to catalogue`,
    )
  }
  const [pending, setPending] = useState<CatalogueProduct | undefined>()
  const duplicate = (p: CatalogueProduct) => {
    let n = 2
    while (items.some((x) => x.code === `${p.code}-${n}`)) n++
    setPending({ ...p, code: `${p.code}-${n}`, stock: 0, status: 'Draft' })
    setModal({ open: true })
  }
  const setStatus = (codes: string[], status: CatalogueProduct['status']) => {
    setItems((l) => l.map((x) => (codes.includes(x.code) ? { ...x, status } : x)))
    setSelected(new Set())
    setToast(`${codes.length} product${codes.length > 1 ? 's' : ''} marked ${status.toLowerCase()}`)
  }
  const remove = (codes: string[]) => {
    setItems((l) => l.filter((x) => !codes.includes(x.code)))
    setSelected(new Set())
    setToast(`${codes.length} product${codes.length > 1 ? 's' : ''} removed`)
  }

  const pageNums = (() => {
    const a: (number | '…')[] = []
    if (pages <= 7) {
      for (let i = 1; i <= pages; i++) a.push(i)
      return a
    }
    for (let i = 1; i <= 5; i++) a.push(i)
    a.push('…', pages)
    return a
  })()
  const start = ordered.length ? (cur - 1) * per + 1 : 0,
    end = Math.min(cur * per, ordered.length)
  const fmtCount = (n: number) => n.toLocaleString('en-US')

  const Row = (p: CatalogueProduct) => (
    <tr
      key={p.code}
      className={`${selected.has(p.code) ? 'sel' : ''} ${p.status !== 'Active' ? 'muted' : ''} ${focusCode === p.code ? 'flash' : ''}`}
    >
      <td className="chk">
        <input
          type="checkbox"
          aria-label={`Select ${p.code}`}
          checked={selected.has(p.code)}
          onChange={() => toggle(p.code)}
        />
      </td>
      <td className="code">
        {p.code}
        {p.status !== 'Active' && (
          <i className={`cat-state ${p.status.toLowerCase()}`}>{p.status}</i>
        )}
      </td>
      <td className="name">{p.name}</td>
      {!stockList && (
        <>
          <td>{p.upc}</td>
          <td>{p.company}</td>
          <td>{p.klass}</td>
          <td>{p.pack}</td>
        </>
      )}
      <td>{p.shelf}</td>
      <td className="r">{p.high}</td>
      <td className="r">{p.low}</td>
      {!stockList && (
        <>
          <td className="r">{num(p.purchase)}</td>
          <td className="r">{num(p.retail)}</td>
          <td className="r">{num(p.wprice)}</td>
        </>
      )}
      {stockList && <td className="r">{num(p.cost)}</td>}
      <td className="stock">
        <span className={`cat-stock ${stockTone(p)}`}>{p.stock}</span>
      </td>
      <td className="act">
        <div className="cat-menu-wrap">
          <button
            type="button"
            className="cat-more"
            aria-label={`Actions for ${p.code}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation()
              setMenu(menu === p.code ? null : p.code)
            }}
          >
            <MoreVertical />
          </button>
          {menu === p.code && (
            <div className="cat-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  setModal({ open: true, edit: p })
                }}
              >
                <Eye /> View / Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  duplicate(p)
                }}
              >
                <Copy /> Duplicate
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  setStatus([p.code], p.status === 'Inactive' ? 'Active' : 'Inactive')
                }}
              >
                <Pencil /> {p.status === 'Inactive' ? 'Activate' : 'Deactivate'}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setMenu(null)
                  remove([p.code])
                }}
              >
                <Trash2 /> Delete
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
  )

  let lastGroup = ''
  return (
    <div className={`cat-page ${view === 'Compact' ? 'compact' : ''}`}>
      <header className="cat-head">
        <span className="cat-head-ic">
          <Box />
        </span>
        <div>
          <h1>All Products</h1>
          <p>Manage your product inventory, pricing, classification and stock levels</p>
        </div>
        <button
          type="button"
          className="cat-btn primary big"
          disabled={!canCreate}
          onClick={() => setModal({ open: true })}
        >
          <Plus /> New Product
        </button>
      </header>

      <section className="cat-filters">
        <Sel
          label="Product Scope"
          value={scope}
          onChange={(v) => {
            setScope(v)
            setPage(1)
          }}
          options={['All Products', 'Active', 'Drafts', 'Inactive', 'Low Stock']}
        />
        <Sel
          label="Company"
          value={company}
          onChange={(v) => {
            setCompany(v)
            setPage(1)
          }}
          options={['All Companies', ...companies]}
        />
        <Sel
          label="Class"
          value={klass}
          onChange={(v) => {
            setKlass(v)
            setPage(1)
          }}
          options={['All Classes', ...classes]}
        />
        <div className="cat-filter">
          <span>Stock Range</span>
          <span className="cat-range">
            <input
              type="number"
              min={0}
              aria-label="Minimum stock"
              value={min}
              onChange={(e) => {
                setMin(e.target.value)
                setPage(1)
              }}
              placeholder="Min"
            />
            <i>–</i>
            <input
              type="number"
              min={0}
              aria-label="Maximum stock"
              value={max}
              onChange={(e) => {
                setMax(e.target.value)
                setPage(1)
              }}
              placeholder="Max"
            />
          </span>
        </div>
        <Sel
          label="Shelf"
          value={shelf}
          onChange={(v) => {
            setShelf(v)
            setPage(1)
          }}
          options={['All Shelves', ...shelves]}
        />
        <Sel
          label="Special Attributes"
          value={attr}
          onChange={(v) => {
            setAttr(v)
            setPage(1)
          }}
          options={['None', 'Short Item', 'Required Expiry', 'Narcotics', 'Precious']}
        />
        <label className="cat-filter wide">
          <span>Search by code, name or UPC</span>
          <span className="cat-search">
            <Search />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(1)
              }}
              placeholder="Enter code, name or UPC..."
            />
          </span>
        </label>
        <Sel
          label="Product View"
          value={view}
          onChange={setView}
          options={['Detail', 'Compact']}
          icon={<LayoutList className="cat-lead" />}
        />
        <Sel
          label="Sort By"
          value={sort}
          onChange={setSort}
          options={Object.keys(sorts)}
          icon={<ArrowUpDown className="cat-lead" />}
        />
      </section>

      <div className="cat-tabs-row">
        <div className="cat-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === t}
              key={t}
              className={tab === t ? 'on' : ''}
              onClick={() => {
                setTab(t)
                setPage(1)
              }}
            >
              {t}
              {counts[t] !== undefined && <b>({fmtCount(counts[t]!)})</b>}
            </button>
          ))}
        </div>
        <button type="button" className="cat-btn ghost" onClick={clear}>
          <RotateCcw /> Clear Filters
        </button>
      </div>

      <div className="cat-status-row">
        <span>
          Showing {start} – {end} of {fmtCount(ordered.length)} products
        </span>
        <span className="cat-chip">
          Filtered:{' '}
          <b>
            {activeFilters.length
              ? activeFilters.join(' · ')
              : tab === 'All'
                ? 'All Products'
                : tab}
          </b>
          {activeFilters.length || tab !== 'All' ? (
            <button type="button" aria-label="Clear filters" onClick={clear}>
              <X />
            </button>
          ) : null}
        </span>
        {selected.size > 0 && (
          <span className="cat-bulk">
            <b>{selected.size} selected</b>
            <button type="button" onClick={() => setStatus([...selected], 'Active')}>
              Activate
            </button>
            <button type="button" onClick={() => setStatus([...selected], 'Inactive')}>
              Deactivate
            </button>
            <button type="button" className="danger" onClick={() => remove([...selected])}>
              Delete
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </span>
        )}
      </div>

      <div className="cat-table-wrap">
        <table className="cat-table">
          <thead>
            <tr>
              <th className="chk">
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={allChecked}
                  onChange={toggleAll}
                />
              </th>
              <th>Code</th>
              <th>Product Name</th>
              {!stockList && (
                <>
                  <th>UPC</th>
                  <th>Company</th>
                  <th>Class</th>
                  <th>Pack</th>
                </>
              )}
              <th>Shelf</th>
              <th className="r">High Level</th>
              <th className="r">Low Level</th>
              {!stockList && (
                <>
                  <th className="r">
                    Purchase
                    <br />
                    Price
                  </th>
                  <th className="r">
                    Retail
                    <br />
                    Price
                  </th>
                  <th className="r">W. Price</th>
                </>
              )}
              {stockList && <th className="r">Cost / Unit</th>}
              <th className="stock">Stock</th>
              <th className="act">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.flatMap((p) => {
                const out: ReactNode[] = []
                if (groupKey) {
                  const g = groupKey(p)
                  if (g !== lastGroup) {
                    lastGroup = g
                    out.push(
                      <tr key={'g-' + g} className="cat-group">
                        <td colSpan={stockList ? 10 : 14}>
                          <b>{g}</b>
                          <small>
                            {fmtCount(ordered.filter((x) => groupKey(x) === g).length)} products ·{' '}
                            {fmtCount(
                              ordered
                                .filter((x) => groupKey(x) === g)
                                .reduce((a, x) => a + x.stock, 0),
                            )}{' '}
                            in stock
                          </small>
                        </td>
                      </tr>,
                    )
                  }
                }
                out.push(Row(p))
                return out
              })
            ) : (
              <tr className="cat-empty">
                <td colSpan={stockList ? 10 : 14}>
                  <Package />
                  <b>No products match these filters</b>
                  <small>Try widening the stock range or clearing a filter.</small>
                  <button type="button" className="cat-btn outline" onClick={clear}>
                    Clear Filters
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="cat-foot">
        <label className="cat-per">
          Rows per page{' '}
          <span className="cat-sel">
            <select
              value={per}
              onChange={(e) => {
                setPer(Number(e.target.value))
                setPage(1)
              }}
            >
              {[15, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <ChevronDown className="cat-caret" />
          </span>
        </label>
        <div className="cat-pager">
          <button
            type="button"
            className="nav"
            aria-label="Previous page"
            disabled={cur <= 1}
            onClick={() => setPage(cur - 1)}
          >
            <ChevronLeft />
          </button>
          {pageNums.map((n, i) =>
            n === '…' ? (
              <span key={'d' + i} className="dots">
                …
              </span>
            ) : (
              <button
                type="button"
                key={n}
                className={n === cur ? 'on' : ''}
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            className="nav"
            aria-label="Next page"
            disabled={cur >= pages}
            onClick={() => setPage(cur + 1)}
          >
            <ChevronRight />
          </button>
        </div>
      </div>

      {modal.open && (
        <ProductModal
          initial={modal.edit ?? pending}
          edit={!!modal.edit}
          existing={items}
          onClose={() => {
            setModal({ open: false })
            setPending(undefined)
          }}
          onSave={(p, d) => {
            if (pending) {
              setItems((l) => [p, ...l])
              setPending(undefined)
              setModal({ open: false })
              setFocusCode(p.code)
              setToast(`${p.code} created from ${p.code.replace(/-\d+$/, '')}`)
            } else save(p, d)
          }}
        />
      )}
      {toast && (
        <div className="cat-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
