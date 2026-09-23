'use client'
import { useState } from 'react'
import { Button, Modal } from '@finsoft/ui'
import { money } from '@finsoft/ui'
import type { Master, Product } from '@/mocks/api'

const codeFor = (type: string) =>
  ({
    Customer: 'CUS',
    Supplier: 'SUP',
    Bank: 'BNK',
    Department: 'DEP',
    Doctor: 'DOC',
    Asset: 'ACC',
    Liability: 'ACC',
    Revenue: 'ACC',
    Expense: 'ACC',
    Account: 'ACC',
  })[type] ?? 'ACC'
const masterTypes = [
  'Account',
  'Asset',
  'Bank',
  'Customer',
  'Supplier',
  'Department',
  'Doctor',
  'Liability',
  'Revenue',
  'Expense',
]
const nextCode = (type: string, list: Master[]) => {
  const pre = codeFor(type)
  const n =
    Math.max(
      0,
      ...list
        .filter((m) => m.code.startsWith(pre))
        .map((m) => parseInt(m.code.split('-')[1] || '0', 10) || 0),
    ) + 1
  return `${pre}-${String(n).padStart(4, '0')}`
}

function MasterFields({
  list,
  preset,
  presetLevel,
  presetParent,
  onDone,
}: {
  list: Master[]
  preset: string
  presetLevel?: number
  presetParent?: string
  onDone: (m: Master) => void
}) {
  const [type, setType] = useState(preset)
  const [level, setLevel] = useState(presetLevel ?? 1)
  const [parent, setParent] = useState(presetParent ?? '')
  const [name, setName] = useState(''),
    [city, setCity] = useState('Lahore'),
    [contact, setContact] = useState(''),
    [balanceType, setBalanceType] = useState('Debit'),
    [balance, setBalance] = useState(0),
    [status, setStatus] = useState<'Active' | 'Inactive'>('Active')
  const isAccount = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Account'].includes(type)
  const parentPool =
    isAccount && level > 1
      ? list.filter((m) => m.level === level - 1 && (m.type === type || m.level === 1))
      : []
  const save = () => {
    if (!name.trim()) return alert('Give the record a name.')
    onDone({
      code: nextCode(type, list),
      name: name.trim(),
      type,
      balanceType,
      status,
      city,
      contact: contact || '—',
      balance: Number(balance) || 0,
      level: isAccount ? level : undefined,
      parent: isAccount
        ? level === 1
          ? null
          : parent || (parentPool[0]?.code ?? null)
        : undefined,
    })
  }
  return (
    <>
      {/* Identity strip: auto code + status */}
      <div className="mf-info">
        <div className="mf-code">
          <span className="mf-code-label">Code (auto)</span>
          <span className="mf-code-value">{nextCode(type, list)}</span>
        </div>
        <label className="mf-status-pick">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'Active' | 'Inactive')}
            aria-label="Record status"
          >
            <option>Active</option>
            <option>Inactive</option>
          </select>
        </label>
      </div>
      {/* Section: Record */}
      <div className="mf-section">
        <p className="mf-section-title">Record</p>
        <div className="mf-fields">
          <label>
            <span className="mf-label">Record type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {masterTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mf-label">Record name *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lahore Clinic, HBL — 5502, Getz Pharma"
              required
              autoFocus
            />
          </label>
        </div>
      </div>
      {/* Section: Details */}
      <div className="mf-section">
        <p className="mf-section-title">Details</p>
        <div className="mf-fields">
          <label>
            <span className="mf-label">City</span>
            <select value={city} onChange={(e) => setCity(e.target.value)}>
              <option>Lahore</option>
              <option>Rawalpindi</option>
              <option>Faisalabad</option>
              <option>Karachi</option>
            </select>
          </label>
          <label>
            <span className="mf-label">Contact / NTN / account no.</span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Phone, NTN or bank account"
            />
          </label>
        </div>
      </div>
      {/* Section: Accounting — only for account-type masters */}
      {isAccount && (
        <div className="mf-section">
          <p className="mf-section-title">Accounting</p>
          <div className="mf-fields">
            <label>
              <span className="mf-label">Balance type</span>
              <select value={balanceType} onChange={(e) => setBalanceType(e.target.value)}>
                <option>Debit</option>
                <option>Credit</option>
                <option>—</option>
              </select>
            </label>
            <label>
              <span className="mf-label">Opening balance (PKR)</span>
              <input
                type="number"
                value={balance}
                onChange={(e) => setBalance(Number(e.target.value))}
              />
            </label>
            <label>
              <span className="mf-label">Chart level</span>
              <select
                value={level}
                onChange={(e) => {
                  setLevel(Number(e.target.value))
                  setParent('')
                }}
              >
                <option value={1}>1 — Primary</option>
                <option value={2}>2 — Subtype</option>
                <option value={3}>3 — Group</option>
                <option value={4}>4 — Transaction</option>
              </select>
            </label>
            <label>
              <span className="mf-label">Parent account</span>
              {level > 1 ? (
                <select
                  value={parent || (parentPool[0]?.code ?? '')}
                  onChange={(e) => setParent(e.target.value)}
                >
                  {parentPool.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} ({p.code})
                    </option>
                  ))}
                </select>
              ) : (
                <span className="mf-note">Top-level primary — no parent</span>
              )}
            </label>
          </div>
        </div>
      )}
      <div className="modal-foot">
        <Button kind="secondary" onClick={() => onDone(null as unknown as Master)}>
          Cancel
        </Button>
        <Button onClick={save}>Create record</Button>
      </div>
    </>
  )
}
export function MasterModal({
  open,
  list,
  presetType,
  presetLevel,
  presetParent,
  onClose,
  onSave,
}: {
  open: boolean
  list: Master[]
  presetType?: string
  presetLevel?: number
  presetParent?: string
  onClose: () => void
  onSave: (m: Master) => void
}) {
  if (!open) return null
  const done = (m: Master) => {
    if (m) {
      onSave(m)
    }
    onClose()
  }
  return (
    <Modal title="Create master record" onClose={onClose} wide eyebrow={false}>
      <MasterFields
        key={(presetType ?? 'Account') + '-' + (presetLevel ?? 0) + '-' + (presetParent ?? '')}
        list={list}
        preset={presetType ?? 'Account'}
        presetLevel={presetLevel}
        presetParent={presetParent}
        onDone={done}
      />
    </Modal>
  )
}

function ProductFields({ list, onDone }: { list: Product[]; onDone: (p: Product) => void }) {
  const [name, setName] = useState(''),
    [generic, setGeneric] = useState(''),
    [category, setCategory] = useState('Analgesic'),
    [supplier, setSupplier] = useState('Getz Pharma'),
    [cost, setCost] = useState(0),
    [price, setPrice] = useState(0),
    [reorder, setReorder] = useState(10),
    [stock, setStock] = useState(0),
    [expiry, setExpiry] = useState('2027-12-31'),
    [batch, setBatch] = useState('')
  const cats = [
    'Analgesic',
    'Antibiotic',
    'Gastrointestinal',
    'Paediatric',
    'Cardiovascular',
    'Diabetes',
    'Anti-infective',
    'Respiratory',
    'Other',
  ]
  const save = () => {
    if (!name.trim() || !price) return alert('Product name and retail price are required.')
    const n = Math.max(0, ...list.map((p) => parseInt(p.id.split('-')[1] || '0', 10) || 0)) + 1
    const id = `MED-${String(1000 + n).padStart(4, '0')}`
    const bId = batch || `BT-${n}`
    const exp = expiry
    onDone({
      id,
      name: name.trim(),
      generic: generic.trim() || 'Generic',
      category,
      supplier,
      stock: Number(stock) || 0,
      reorder: Number(reorder) || 0,
      cost: Number(cost) || 0,
      price: Number(price),
      batch: bId,
      expiry: exp,
      batches: [{ id: bId, expiry: exp, stock: Number(stock) || 0, cost: Number(cost) || 0 }],
    })
  }
  return (
    <>
      <div className="form-grid">
        <label>
          Product name *
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Brufen 400mg"
          />
        </label>
        <label>
          Generic name
          <input
            value={generic}
            onChange={(e) => setGeneric(e.target.value)}
            placeholder="e.g. Ibuprofen"
          />
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {cats.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Supplier
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option>Getz Pharma</option>
            <option>GlaxoSmithKline</option>
            <option>Abbott Laboratories</option>
            <option>The Searle Company</option>
            <option>Martin Dow</option>
            <option>Sami Pharmaceuticals</option>
            <option>High-Q Pharma</option>
          </select>
        </label>
        <label>
          Batch no.
          <input
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            placeholder="Auto if blank"
          />
        </label>
        <label>
          Expiry
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <label>
          Opening stock
          <input type="number" value={stock} onChange={(e) => setStock(Number(e.target.value))} />
        </label>
        <label>
          Cost (PKR)
          <input type="number" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
        </label>
        <label>
          Retail price (PKR) *
          <input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
        </label>
        <label>
          Reorder level
          <input
            type="number"
            value={reorder}
            onChange={(e) => setReorder(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="modal-foot">
        <Button kind="secondary" onClick={() => onDone(null as unknown as Product)}>
          Cancel
        </Button>
        <Button onClick={save}>Add product</Button>
      </div>
    </>
  )
}
export function ProductFormModal({
  open,
  list,
  onClose,
  onSave,
}: {
  open: boolean
  list: Product[]
  onClose: () => void
  onSave: (p: Product) => void
}) {
  if (!open) return null
  const done = (p: Product) => {
    if (p) onSave(p)
    onClose()
  }
  return (
    <Modal title="Add product" onClose={onClose} wide>
      <ProductFields list={list} onDone={done} />
    </Modal>
  )
}

function EmployeeFields({ list, onDone }: { list: string[][]; onDone: (e: string[]) => void }) {
  const [name, setName] = useState(''),
    [designation, setDesignation] = useState('Pharmacist'),
    [branch, setBranch] = useState('Lahore'),
    [salary, setSalary] = useState(0),
    [today, setToday] = useState('Present')
  const save = () => {
    if (!name.trim()) return alert('Employee name is required.')
    const n =
      Math.max(0, ...list.map((r) => parseInt(String(r[0]).split('-')[1] || '0', 10) || 0)) + 1
    onDone([
      `BT-${String(n).padStart(3, '0')}`,
      name.trim(),
      designation,
      branch,
      money(Math.round(Number(salary) || 0)),
      today,
    ])
  }
  return (
    <>
      <div className="form-grid">
        <label>
          Employee name *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </label>
        <label>
          Designation
          <select value={designation} onChange={(e) => setDesignation(e.target.value)}>
            <option>Branch Manager</option>
            <option>Pharmacist</option>
            <option>Sales Executive</option>
            <option>Accounts Officer</option>
            <option>Store Keeper</option>
            <option>Assistant</option>
          </select>
        </label>
        <label>
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option>Lahore</option>
            <option>Rawalpindi</option>
            <option>Faisalabad</option>
          </select>
        </label>
        <label>
          Gross salary (PKR)
          <input type="number" value={salary} onChange={(e) => setSalary(Number(e.target.value))} />
        </label>
        <label>
          Today
          <select value={today} onChange={(e) => setToday(e.target.value)}>
            <option>Present</option>
            <option>Field</option>
            <option>Leave</option>
          </select>
        </label>
      </div>
      <div className="modal-foot">
        <Button kind="secondary" onClick={() => onDone(null as unknown as string[])}>
          Cancel
        </Button>
        <Button onClick={save}>Add employee</Button>
      </div>
    </>
  )
}
export function EmployeeFormModal({
  open,
  list,
  onClose,
  onSave,
}: {
  open: boolean
  list: string[][]
  onClose: () => void
  onSave: (e: string[]) => void
}) {
  if (!open) return null
  const done = (e: string[]) => {
    if (e) onSave(e)
    onClose()
  }
  return (
    <Modal title="Add employee" onClose={onClose}>
      <EmployeeFields list={list} onDone={done} />
    </Modal>
  )
}
