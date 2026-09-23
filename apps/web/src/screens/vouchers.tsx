'use client'
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from '@/lib/router'
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  Copy,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Landmark,
  ListPlus,
  MoreHorizontal,
  Paperclip,
  Plus,
  Printer,
  ReceiptText,
  Save,
  Scale,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  UserRound,
  WalletCards,
} from 'lucide-react'
import { users, voucherCode, type Voucher, type VoucherLine } from '@/mocks/api'
import { allVouchers } from './voucher-data'
import type { AppData } from '@/mocks/api'
import { Badge, Button, Panel, Table } from '@finsoft/ui'
import { money } from '@finsoft/ui'

const typeMeta: Record<string, { name: string; short: string }> = {
  JV: { name: 'Journal Voucher', short: 'JV' },
  CRV: { name: 'Cash Receipt', short: 'CRV' },
  CPV: { name: 'Cash Payment', short: 'CPV' },
  BRV: { name: 'Bank Receipt', short: 'BRV' },
  BPV: { name: 'Bank Payment', short: 'BPV' },
  CV: { name: 'Contra Voucher', short: 'CV' },
  SINV: { name: 'Sales Invoice', short: 'SINV' },
  PINV: { name: 'Purchase Invoice (GRN)', short: 'PINV' },
}
const typeTone = (t: string): 'info' | 'good' | 'warn' | 'neutral' =>
  t === 'JV'
    ? 'info'
    : t === 'CRV' || t === 'BRV'
      ? 'good'
      : t === 'CPV' || t === 'BPV'
        ? 'warn'
        : t === 'CV'
          ? 'neutral'
          : 'good'

function VoucherDetail({
  data,
  onPost,
  onCancel,
}: {
  data: AppData
  onPost: (id: string) => void
  onCancel: (id: string) => void
}) {
  const navigate = useNavigate(),
    { id } = useParams()
  const voucher = allVouchers(data).find((v) => v.id === id)
  if (!voucher)
    return (
      <div className="state-page">
        <span>
          <FileText />
        </span>
        <h1>Record not found</h1>
        <p>No voucher matches that reference.</p>
        <Button kind="secondary" onClick={() => navigate('/vouchers')}>
          <ArrowLeft /> Back to vouchers
        </Button>
      </div>
    )
  const meta = typeMeta[voucher.type],
    dr = voucher.lines.reduce((a, l) => a + l.amount, 0)
  const related =
    voucher.type === 'SINV' && voucher.reference.startsWith('INV')
      ? `/sales/${voucher.reference}`
      : voucher.type === 'PINV' && voucher.reference.startsWith('PUR')
        ? `/purchases/${voucher.reference}`
        : null
  return (
    <>
      <div className="vou-breadcrumb">
        <button onClick={() => navigate('/vouchers')}>Voucher Management</button>
        <ChevronRight />
        <span>{meta.name}s</span>
        <ChevronRight />
        <b>{voucher.id}</b>
      </div>
      <div className="vd-head">
        <div className="vd-title">
          <div>
            <Badge tone={typeTone(voucher.type)}>
              {meta.short} · {voucher.status}
            </Badge>
            <Badge tone={voucher.posting === 'Posted' ? 'good' : 'neutral'}>
              {voucher.posting}
            </Badge>
          </div>
          <h1>{voucher.id}</h1>
          <p>{voucher.narration}</p>
        </div>
        <div className="vd-actions">
          <Button kind="secondary">
            <Printer /> Print
          </Button>
          {voucher.status === 'Draft' ? (
            <Button
              onClick={() => {
                onPost(voucher.id)
                navigate('/vouchers')
              }}
            >
              <Check /> Post &amp; approve
            </Button>
          ) : voucher.status === 'Posted' ? (
            <Button kind="danger" onClick={() => onCancel(voucher.id)}>
              Cancel voucher
            </Button>
          ) : null}
          <Button kind="secondary" onClick={() => navigate(-1)}>
            <ArrowLeft /> Back
          </Button>
        </div>
      </div>
      <div className="vd-grid">
        <section className="vd-main">
          <Panel title="Voucher header" sub="Posting information">
            <div className="vd-fields">
              <div>
                <small>Voucher no.</small>
                <b>{voucher.id}</b>
              </div>
              <div>
                <small>Voucher type</small>
                <b>{meta.name}</b>
              </div>
              <div>
                <small>Voucher date</small>
                <b>{voucher.date}</b>
              </div>
              <div>
                <small>Posting date</small>
                <b>{voucher.date}</b>
              </div>
              <div>
                <small>Reference</small>
                <b>{voucher.reference || '—'}</b>
              </div>
              <div>
                <small>Branch</small>
                <b>{voucher.branch}</b>
              </div>
              <div>
                <small>Department</small>
                <b>{voucher.department}</b>
              </div>
              <div>
                <small>Currency</small>
                <b>PKR — Pakistani Rupee</b>
              </div>
            </div>
          </Panel>
          <Panel title="Accounting entries" sub="Debit and credit lines · double-entry balanced">
            <div className="vou-entries">
              <table>
                <thead>
                  <tr>
                    <th>Dr Account</th>
                    <th>Code</th>
                    <th>Debit (PKR)</th>
                    <th>Cr Account</th>
                    <th>Code</th>
                    <th>Credit (PKR)</th>
                    <th>Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {voucher.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <b>{l.debit}</b>
                      </td>
                      <td>{voucherCode[l.debit] ?? '—'}</td>
                      <td>{money(l.amount)}</td>
                      <td>
                        <b>{l.credit}</b>
                      </td>
                      <td>{voucherCode[l.credit] ?? '—'}</td>
                      <td>{money(l.amount)}</td>
                      <td>{l.remark ?? '—'}</td>
                    </tr>
                  ))}
                  <tr className="vou-total">
                    <td colSpan={2}>Total</td>
                    <td>
                      <b>{money(dr)}</b>
                    </td>
                    <td />
                    <td />
                    <td>
                      <b>{money(dr)}</b>
                    </td>
                    <td>
                      Difference <Badge tone="good">Rs 0.00</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="vd-totals">
              <span>
                Total debit <b>{money(dr)}</b>
              </span>
              <span>
                Total credit <b>{money(dr)}</b>
              </span>
              <span>
                Difference <b>Rs 0.00</b>
              </span>
            </div>
          </Panel>
          <Panel title="Related documents" sub="Source and destination records">
            <Table
              headers={['Reference', 'Type', 'Narration', '']}
              rows={[
                [
                  related ? (
                    <button className="linkable" onClick={() => navigate(related!)}>
                      {voucher.reference}
                    </button>
                  ) : (
                    voucher.reference || '—'
                  ),
                  meta.name,
                  voucher.narration,
                  related ? (
                    <button className="table-action" onClick={() => navigate(related!)}>
                      Open <ArrowRight />
                    </button>
                  ) : null,
                ],
              ]}
            />
          </Panel>
        </section>
        <aside className="vd-rail">
          <Panel title="Status & audit">
            <div className="vd-info">
              <p>
                <span>Status</span>
                <b>
                  <Badge
                    tone={
                      voucher.status === 'Posted'
                        ? 'good'
                        : voucher.status === 'Draft'
                          ? 'warn'
                          : 'danger'
                    }
                  >
                    {voucher.status}
                  </Badge>
                </b>
              </p>
              <p>
                <span>Posting status</span>
                <b>
                  <Badge tone={voucher.posting === 'Posted' ? 'good' : 'neutral'}>
                    {voucher.posting}
                  </Badge>
                </b>
              </p>
              <p>
                <span>Created by</span>
                <b>{voucher.createdBy}</b>
              </p>
              <p>
                <span>Created on</span>
                <b>{voucher.date} · 09:12 AM</b>
              </p>
              <p>
                <span>Last modified</span>
                <b>
                  {voucher.date} · {voucher.posting === 'Posted' ? '11:45 AM' : '09:12 AM'}
                </b>
              </p>
              <p>
                <span>Approved by</span>
                <b>{voucher.status === 'Posted' ? 'Ahmed Raza' : 'Pending approval'}</b>
              </p>
            </div>
          </Panel>
          <Panel
            title="Attachments"
            sub="Supporting documents"
            action={
              <Button kind="ghost">
                <Paperclip size={14} /> Add
              </Button>
            }
          >
            <div className="vd-attach">
              <span>
                <FileText />
                Purchase invoice {voucher.reference || 'scan'}
              </span>
              <small>{Math.max(120, voucher.lines.length * 92)} KB · PDF</small>
            </div>
            <div className="vd-attach">
              <span>
                <FileText />
                Ledger excerpt
              </span>
              <small>64 KB · XLSX</small>
            </div>
          </Panel>
          <Panel title="Comments" sub="Thread for approvers">
            <div className="vd-comment">
              <b>No comments yet</b>
              <p>Be the first to add a comment.</p>
            </div>
            <div className="modal-foot" style={{ border: 0, margin: 0, padding: 0 }}>
              <Button
                kind="secondary"
                onClick={() => navigate(`/vouchers/new?type=${voucher.type.toLowerCase()}`)}
              >
                <Plus /> Add comment
              </Button>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  )
}

const typeByCat: Record<string, string> = {
  journal: 'JV',
  cash: 'CRV',
  bank: 'BRV',
  contra: 'CV',
  payments: 'BPV',
  receipts: 'BRV',
}

const drCrDefaults: Record<string, { debit: string; credit: string }> = {
  JV: { debit: 'Cash in Hand', credit: 'Sales Revenue' },
  CRV: { debit: 'Cash in Hand', credit: 'Accounts Receivable' },
  CPV: { debit: 'Accounts Payable', credit: 'Cash in Hand' },
  BRV: { debit: 'Meezan Bank — 8721', credit: 'Accounts Receivable' },
  BPV: { debit: 'Accounts Payable', credit: 'Meezan Bank — 8721' },
  CV: { debit: 'Meezan Bank — 8721', credit: 'Cash in Hand' },
}
function MoneyInput({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (n: number) => void
  label: string
}) {
  const [focus, setFocus] = useState(false)
  const shown = focus
    ? value
      ? String(value)
      : ''
    : value
      ? value.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : ''
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={shown}
      placeholder="0.00"
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)}
    />
  )
}
function VoucherForm({
  data,
  onSave,
}: {
  data: AppData
  onSave: (v: Voucher, post: boolean) => void
}) {
  const navigate = useNavigate(),
    [params] = useSearchParams()
  const pre = typeByCat[params.get('type') || 'journal'] ?? 'JV'
  const [form, setForm] = useState({
    vtype: pre,
    date: '2026-08-30',
    narration: '',
    reference: '',
    branch: 'Lahore Main',
    department: 'Accounts',
    prepared: users[0].name,
    approver: '',
  })
  type Entry = { account: string; description: string; debit: number; credit: number }
  const initial = (t: string): Entry[] => {
    const d = drCrDefaults[t] ?? drCrDefaults.JV
    if (t === 'JV')
      return [
        { account: d.debit, description: 'Cash received from customer', debit: 50000, credit: 0 },
        {
          account: d.credit,
          description: 'Sales against invoice #INV-1024',
          debit: 0,
          credit: 50000,
        },
      ]
    return [
      { account: d.debit, description: '', debit: 0, credit: 0 },
      { account: d.credit, description: '', debit: 0, credit: 0 },
    ]
  }
  const [entries, setEntries] = useState<Entry[]>(initial(pre)),
    [saveTemplate, setSaveTemplate] = useState(false)
  const setType = (t: string) => {
    setForm((f) => ({ ...f, vtype: t }))
    setEntries(initial(t))
  }
  const allAccounts = data.masters.filter((m) => m.level === 4).map((m) => m.name)
  const debitTotal = entries.reduce((a, l) => a + (Number(l.debit) || 0), 0),
    creditTotal = entries.reduce((a, l) => a + (Number(l.credit) || 0), 0),
    difference = Math.abs(debitTotal - creditTotal),
    balanced = debitTotal > 0 && difference < 0.005
  const voucherNo = `${form.vtype}-2026-${String(Math.max(0, ...data.vouchers.filter((v) => v.type === form.vtype).map((v) => parseInt(v.id.split('-').at(-1) ?? '0', 10) || 0)) + 1).padStart(4, '0')}`
  const toLines = (): VoucherLine[] => {
    const debits = entries.filter((e) => e.debit > 0).map((e) => ({ ...e, left: e.debit })),
      credits = entries.filter((e) => e.credit > 0).map((e) => ({ ...e, left: e.credit })),
      result: VoucherLine[] = []
    let d = 0,
      c = 0
    while (d < debits.length && c < credits.length) {
      const amount = Math.min(debits[d].left, credits[c].left)
      result.push({
        debit: debits[d].account,
        credit: credits[c].account,
        amount,
        remark: debits[d].description || credits[c].description || form.narration,
      })
      debits[d].left -= amount
      credits[c].left -= amount
      if (debits[d].left < 0.005) d++
      if (credits[c].left < 0.005) c++
    }
    return result
  }
  const submit = (post: boolean) => {
    if (!form.narration.trim()) {
      alert('Add a narration before saving the voucher.')
      return
    }
    if (!balanced) {
      alert('Voucher entries must include equal debit and credit totals.')
      return
    }
    const seq =
      Math.max(
        0,
        ...data.vouchers
          .filter((v) => v.type === form.vtype)
          .map((v) => parseInt(v.id.split('-').at(-1) ?? '0', 10) || 0),
      ) + 1
    const v: Voucher = {
      id: `${form.vtype}-2026-${String(seq).padStart(4, '0')}`,
      date: form.date,
      type: form.vtype as Voucher['type'],
      narration: form.narration,
      reference: form.reference,
      status: post ? 'Posted' : 'Draft',
      posting: post ? 'Posted' : 'Unposted',
      createdBy: form.prepared,
      branch: form.branch,
      department: form.department,
      lines: toLines(),
    }
    onSave(v, post)
    navigate('/vouchers')
  }
  const setEntry = (i: number, p: Partial<Entry>) =>
    setEntries((list) => list.map((entry, j) => (j === i ? { ...entry, ...p } : entry)))
  const addEntry = () =>
    setEntries((list) => [
      ...list,
      { account: 'Cash in Hand', description: '', debit: 0, credit: 0 },
    ])
  const typeCards = [
    { type: 'JV', label: 'Journal', sub: 'General entry', icon: FileSpreadsheet },
    { type: 'CPV', label: 'Cash Payment', sub: 'Cash out', icon: WalletCards },
    { type: 'CRV', label: 'Cash Receipt', sub: 'Cash in', icon: Banknote },
    { type: 'BPV', label: 'Bank Payment', sub: 'From bank', icon: Landmark },
    { type: 'BRV', label: 'Bank Receipt', sub: 'To bank', icon: ReceiptText },
    { type: 'CV', label: 'More', sub: 'Other types', icon: MoreHorizontal },
  ]
  const fmtLong = (iso: string) =>
    iso
      ? new Date(iso + 'T00:00').toLocaleDateString('en-US', {
          month: 'short',
          day: '2-digit',
          year: 'numeric',
        })
      : ''
  const dupEntry = (i: number) =>
    setEntries((list) => [...list.slice(0, i + 1), { ...list[i] }, ...list.slice(i + 1)])
  return (
    <form className="vn-page" onSubmit={(e) => e.preventDefault()}>
      <span className="sr-only">New {typeMeta[form.vtype].name}</span>
      <div className="vn-head">
        <button
          type="button"
          className="vn-back"
          aria-label="Back to vouchers"
          onClick={() => navigate('/vouchers')}
        >
          <ArrowLeft />
        </button>
        <div className="vn-title">
          <h1>New Voucher</h1>
          <p>Enter a balanced voucher — every debit has a matching credit.</p>
        </div>
        <div className="vn-types">
          {typeCards.map((card) => {
            const Icon = card.icon
            return (
              <button
                type="button"
                key={card.type}
                className={form.vtype === card.type ? 'active' : ''}
                onClick={() => setType(card.type)}
              >
                <Icon />
                <b>{card.label}</b>
                <small>{card.sub}</small>
              </button>
            )
          })}
        </div>
      </div>

      <section className="vn-card">
        <div className="vn-card-head">
          <span className="vn-ico">
            <FileText />
          </span>
          <div>
            <h2>Voucher Details</h2>
            <p>Basic information about this voucher</p>
          </div>
          <span className="vn-auto">
            Auto number: <b>{voucherNo}</b>
            <Settings2 />
          </span>
        </div>
        <div className="vn-grid4">
          <label className="vn-fld">
            <span>
              Voucher Date<em>*</em>
            </span>
            <span className="vn-in">
              <i>
                <CalendarDays />
              </i>
              <input type="text" readOnly value={fmtLong(form.date)} aria-label="Voucher Date" />
              <input
                className="vn-date-overlay"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </span>
          </label>
          <label className="vn-fld">
            <span>
              Posting Date<em>*</em>
            </span>
            <span className="vn-in">
              <i>
                <CalendarDays />
              </i>
              <input type="text" readOnly value={fmtLong(form.date)} aria-label="Posting Date" />
              <input
                className="vn-date-overlay"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </span>
          </label>
          <label className="vn-fld">
            <span>
              Voucher Type<em>*</em>
            </span>
            <span className="vn-in sel">
              <i>
                <SlidersHorizontal />
              </i>
              <select
                aria-label="Voucher Type"
                value={form.vtype}
                onChange={(e) => setType(e.target.value)}
              >
                {['JV', 'CRV', 'CPV', 'BRV', 'BPV', 'CV'].map((t) => (
                  <option key={t} value={t}>
                    {typeMeta[t].name}
                  </option>
                ))}
              </select>
              <ChevronDown className="chev" />
            </span>
          </label>
          <label className="vn-fld">
            <span>Reference No.</span>
            <span className="vn-in">
              <i>
                <ReceiptText />
              </i>
              <input
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                placeholder="e.g. BRV-1024"
              />
            </span>
          </label>
          <label className="vn-fld">
            <span>
              Branch<em>*</em>
            </span>
            <span className="vn-in sel">
              <i>
                <Landmark />
              </i>
              <select
                value={form.branch}
                onChange={(e) => setForm({ ...form, branch: e.target.value })}
              >
                <option>Lahore Main</option>
                <option>Rawalpindi</option>
                <option>Faisalabad</option>
              </select>
              <ChevronsUpDown className="chev" />
            </span>
          </label>
          <label className="vn-fld">
            <span>Department</span>
            <span className="vn-in sel">
              <i>
                <UserRound />
              </i>
              <select
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
              >
                <option>Accounts</option>
                <option>Payroll</option>
                <option>Counter</option>
                <option>Stores</option>
                <option>Sales</option>
                <option>Operations</option>
                <option>Marketing</option>
              </select>
              <ChevronsUpDown className="chev" />
            </span>
          </label>
          <label className="vn-fld">
            <span>Prepared By</span>
            <span className="vn-in sel">
              <i>
                <UserRound />
              </i>
              <select
                value={form.prepared}
                onChange={(e) => setForm({ ...form, prepared: e.target.value })}
              >
                {users.map((u) => (
                  <option key={u.id}>{u.name}</option>
                ))}
              </select>
              <ChevronDown className="chev" />
            </span>
          </label>
          <label className="vn-fld">
            <span>Approved By</span>
            <span className="vn-in sel">
              <i>
                <UserRound />
              </i>
              <select
                value={form.approver}
                onChange={(e) => setForm({ ...form, approver: e.target.value })}
              >
                <option value="">Select approver</option>
                {users
                  .filter((u) => u.role === 'Owner' || u.role === 'Accountant')
                  .map((u) => (
                    <option key={u.id}>{u.name}</option>
                  ))}
              </select>
              <ChevronDown className="chev" />
            </span>
          </label>
        </div>
        <label className="vn-fld vn-narr">
          <span>
            Narration<em>*</em>
          </span>
          <span className="vn-in area">
            <i>
              <FileText />
            </i>
            <textarea
              aria-label="Narration"
              maxLength={300}
              value={form.narration}
              onChange={(e) => setForm({ ...form, narration: e.target.value })}
              placeholder="Briefly describe this voucher..."
            />
            <small>{form.narration.length}/300</small>
          </span>
        </label>
      </section>

      <section className="vn-card">
        <div className="vn-card-head">
          <span className="vn-ico">
            <ListPlus />
          </span>
          <div>
            <h2>Voucher Entries</h2>
            <p>Add debit and credit lines. The voucher must be balanced.</p>
          </div>
          <div className="vn-entry-actions">
            <span className="vn-in sel tmpl">
              <i>
                <FileSpreadsheet />
              </i>
              <select aria-label="Import from template">
                <option>Import from template</option>
                <option>Monthly rent</option>
                <option>Cash sale</option>
              </select>
              <ChevronDown className="chev" />
            </span>
            <button
              type="button"
              className="vn-btn ghost"
              onClick={() =>
                setEntries((list) => [
                  ...list,
                  ...Array.from({ length: 3 }, () => ({
                    account: 'Cash in Hand',
                    description: '',
                    debit: 0,
                    credit: 0,
                  })),
                ])
              }
            >
              <Plus />
              Add multiple lines
            </button>
            <button type="button" className="vn-btn solid" onClick={addEntry}>
              <Plus />
              Add line
            </button>
          </div>
        </div>
        <div className="vn-table-wrap">
          <table className="vn-table">
            <thead>
              <tr>
                <th className="n">#</th>
                <th>Account</th>
                <th>Code</th>
                <th>Description / Narration</th>
                <th className="num">Debit (PKR)</th>
                <th className="num">Credit (PKR)</th>
                <th>Cost Center</th>
                <th className="act">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={i}>
                  <td className="n">
                    <span>{i + 1}</span>
                    <GripVertical />
                  </td>
                  <td>
                    <span className="vn-in sel sm">
                      <select
                        aria-label={`Account line ${i + 1}`}
                        value={entry.account}
                        onChange={(e) => setEntry(i, { account: e.target.value })}
                      >
                        {allAccounts.map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                      <ChevronsUpDown className="chev" />
                    </span>
                  </td>
                  <td>
                    <span className="vn-in sm">
                      <input readOnly value={voucherCode[entry.account] ?? '—'} />
                    </span>
                  </td>
                  <td>
                    <span className="vn-in sm">
                      <input
                        value={entry.description}
                        onChange={(e) => setEntry(i, { description: e.target.value })}
                        placeholder="Line description"
                      />
                    </span>
                  </td>
                  <td>
                    <span className="vn-in sm num">
                      <MoneyInput
                        label={`Debit line ${i + 1}`}
                        value={entry.debit}
                        onChange={(n) => setEntry(i, { debit: n, credit: n ? 0 : entry.credit })}
                      />
                    </span>
                  </td>
                  <td>
                    <span className="vn-in sm num">
                      <MoneyInput
                        label={`Credit line ${i + 1}`}
                        value={entry.credit}
                        onChange={(n) => setEntry(i, { credit: n, debit: n ? 0 : entry.debit })}
                      />
                    </span>
                  </td>
                  <td>
                    <span className="vn-in sel sm">
                      <select aria-label={`Cost center line ${i + 1}`}>
                        <option>Main Branch</option>
                        <option>Rawalpindi</option>
                        <option>Sales</option>
                      </select>
                      <ChevronDown className="chev" />
                    </span>
                  </td>
                  <td className="act">
                    <button
                      type="button"
                      aria-label={`Duplicate line ${i + 1}`}
                      onClick={() => dupEntry(i)}
                    >
                      <Copy />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={entries.length <= 2}
                      onClick={() => setEntries((list) => list.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="vn-entry-foot">
          <button type="button" className="vn-addline" onClick={addEntry}>
            <Plus />
            Add another line
          </button>
          <div className="vn-totals">
            <div>
              <small>Total Debit</small>
              <b>Rs {debitTotal.toLocaleString('en-PK', { minimumFractionDigits: 2 })}</b>
            </div>
            <div>
              <small>Total Credit</small>
              <b>Rs {creditTotal.toLocaleString('en-PK', { minimumFractionDigits: 2 })}</b>
            </div>
            <div className={`vn-bal ${balanced ? 'ok' : 'pending'}`}>
              <span>{balanced ? <Check /> : <Scale />}</span>
              <div>
                <b>{balanced ? 'Balanced' : 'Unbalanced'}</b>
                <small>{balanced ? 'Difference is zero' : `Difference ${money(difference)}`}</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="vn-lower">
        <section className="vn-card">
          <div className="vn-card-head">
            <span className="vn-ico">
              <Paperclip />
            </span>
            <div>
              <h2>Attachments</h2>
            </div>
          </div>
          <label className="vn-upload">
            <UploadCloud />
            <b>Drag &amp; drop files here, or click to upload</b>
            <small>PDF, Excel, JPG up to 10MB each</small>
            <input type="file" multiple />
          </label>
        </section>
        <section className="vn-card">
          <div className="vn-card-head">
            <span className="vn-ico">
              <FileText />
            </span>
            <div>
              <h2>Additional Information</h2>
            </div>
          </div>
          <div className="vn-extra">
            <label className="vn-fld">
              <span>Tags</span>
              <span className="vn-in">
                <input placeholder="Add tags (optional)" />
              </span>
            </label>
            <label className="vn-fld">
              <span>Comments</span>
              <span className="vn-in area plain">
                <textarea rows={2} placeholder="Any additional notes..." />
              </span>
            </label>
          </div>
        </section>
      </div>

      <div className="vn-actionbar">
        <label className="vn-switch">
          <input
            type="checkbox"
            checked={saveTemplate}
            onChange={(e) => setSaveTemplate(e.target.checked)}
          />
          <i />
          <span>
            <b>Save as template</b>
            <small>Reuse this voucher format later</small>
          </span>
        </label>
        <div className="vn-actionbar-right">
          <button type="button" className="vn-btn text" onClick={() => navigate('/vouchers')}>
            Cancel
          </button>
          <button type="button" className="vn-btn ghost" onClick={() => submit(false)}>
            <Save />
            Save Draft
          </button>
          <span className="vn-split">
            <button type="button" onClick={() => submit(true)}>
              <CircleCheck />
              Save &amp; Post
            </button>
            <button type="button" aria-label="More save options">
              <ChevronDown />
            </button>
          </span>
        </div>
      </div>
    </form>
  )
}

export { VoucherDetail, VoucherForm }
