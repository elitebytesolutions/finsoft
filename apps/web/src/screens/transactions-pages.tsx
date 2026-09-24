'use client'
import { useState } from 'react'
import {
  ArrowDown,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  Filter,
  Landmark,
  MoreHorizontal,
  Plus,
  Printer,
  ReceiptText,
  Search,
  Settings2,
  Upload,
  UserRound,
  WalletCards,
} from 'lucide-react'
import type { Payment } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Button, Modal, Panel, Table } from '@finsoft/ui'
import { money } from '@finsoft/ui'

export function PaymentsCentre({
  data,
  onAddPayment,
  canCreate,
}: {
  data: AppData
  onAddPayment: (p: Payment) => void
  canCreate: boolean
}) {
  const [kind, setKind] = useState<'Receipt' | 'Payment'>('Receipt'),
    [open, setOpen] = useState(false)
  const [cashTab, setCashTab] = useState<'Reports' | 'Transaction History'>('Reports'),
    [cashTypeFilter, setCashTypeFilter] = useState<'Payments' | 'Receipts' | 'All Transactions'>(
      'Payments',
    ),
    [cashDateFilter, setCashDateFilter] = useState<'One (Date Wise)' | 'All (Date Wise)'>(
      'One (Date Wise)',
    ),
    [cashNumberFilter, setCashNumberFilter] = useState<'One (Number Wise)' | 'All (Number Wise)'>(
      'One (Number Wise)',
    )
  const [party, setParty] = useState(''),
    [account, setAccount] = useState('Cash in Hand'),
    [alloc, setAlloc] = useState<Record<string, number>>({}),
    [wtax, setWtax] = useState(0)
  const customers = [
    ...new Set(
      data.sales
        .filter((s) => s.status === 'Credit' && s.customer !== 'Walk-in Customer')
        .map((s) => s.customer),
    ),
  ]
  const suppliers = [
    ...new Set(data.purchases.filter((p) => p.status === 'Posted').map((p) => p.supplier)),
  ]
  const openDocs = party
    ? kind === 'Receipt'
      ? data.sales.filter((s) => s.customer === party && s.status === 'Credit')
      : data.purchases.filter((p) => p.supplier === party && p.status === 'Posted')
    : []
  const allocated = Object.values(alloc).reduce((a, b) => a + (Number(b) || 0), 0)
  const docTotal = openDocs.reduce((a, d) => a + d.amount, 0)
  const start = (k: 'Receipt' | 'Payment') => {
    setKind(k)
    setParty(k === 'Receipt' ? (customers[0] ?? '') : (suppliers[0] ?? ''))
    setAccount('Cash in Hand')
    setWtax(0)
    setAlloc({})
    setOpen(true)
  }
  const effectiveDoc = openDocs
  const pickParty = (p: string) => {
    setParty(p)
    const docs =
      kind === 'Receipt'
        ? data.sales.filter((s) => s.customer === p && s.status === 'Credit')
        : data.purchases.filter((x) => x.supplier === p && x.status === 'Posted')
    const a: Record<string, number> = {}
    docs.forEach((d) => (a[d.id] = d.amount))
    setAlloc(a)
  }
  const save = () => {
    if (!allocated) return alert('Allocate at least one invoice.')
    const net = Math.max(0, allocated - (Number(wtax) || 0))
    onAddPayment({
      id: `${kind === 'Receipt' ? 'RCV' : 'PAY'}-${String(1000 + data.payments.length).slice(-4)}`,
      date: '30 Aug 2026',
      kind,
      party,
      account,
      total: allocated,
      wtax: Number(wtax) || 0,
      net,
      allocations: Object.entries(alloc)
        .filter(([, v]) => Number(v) > 0)
        .map(([ref, amount]) => ({ ref, amount: Number(amount) })),
      status: 'Posted',
      createdBy: 'Ahmed Raza',
    })
    setOpen(false)
  }
  const partyName = (n: string) => data.masters.find((m) => m.name === n)?.name ?? n
  return (
    <>
      <span className="sr-only">Payments &amp; receipts</span>
      <div className="cash-page-head">
        <div className="cash-title">
          <span>
            <WalletCards />
          </span>
          <div>
            <h1>Cash Transactions</h1>
            <p>
              Create cash receipts and payments, monitor activity, and access transaction records.
            </p>
          </div>
        </div>
        <div className="cash-head-actions">
          <Button disabled={!canCreate} onClick={() => start('Payment')}>
            <ArrowUpRight /> New Payment
          </Button>
          <Button kind="secondary" disabled={!canCreate} onClick={() => start('Receipt')}>
            <Plus /> New Receipt
          </Button>
          <button>
            <Printer /> Print <ChevronDown />
          </button>
        </div>
      </div>
      <div className="cash-kpis">
        <article>
          <span>
            <Landmark />
          </span>
          <div>
            <small>Opening Balance</small>
            <b>Rs 125,000.00</b>
            <em>As on 01 Apr 2024</em>
          </div>
        </article>
        <article>
          <span>
            <ArrowDown />
          </span>
          <div>
            <small>Total Receipts Today</small>
            <b>Rs 12,500.00</b>
            <em>3 transactions</em>
          </div>
          <i className="cash-bars green" />
        </article>
        <article>
          <span>
            <ArrowUpRight />
          </span>
          <div>
            <small>Total Payments Today</small>
            <b>Rs 8,750.00</b>
            <em>2 transactions</em>
          </div>
          <i className="cash-bars red" />
        </article>
        <article>
          <span>
            <WalletCards />
          </span>
          <div>
            <small>Closing Balance</small>
            <b>Rs 128,750.00</b>
            <em>As on 26 Apr 2024</em>
          </div>
        </article>
      </div>
      <div className="cash-main-grid">
        <section className="cash-create">
          <div className="cash-section-head">
            <h2>
              <FileText /> Create Transaction
            </h2>
            <div className="cash-kind">
              <button
                type="button"
                className={kind === 'Payment' ? 'active' : ''}
                onClick={() => setKind('Payment')}
              >
                <ArrowUpRight /> Payment Voucher
              </button>
              <button
                type="button"
                className={kind === 'Receipt' ? 'active' : ''}
                onClick={() => setKind('Receipt')}
              >
                <ArrowDown /> Receipt Voucher
              </button>
            </div>
            <span className={kind === 'Payment' ? 'cash-outflow' : 'cash-inflow'}>
              {kind === 'Payment' ? <ArrowUpRight /> : <ArrowDown />} Cash{' '}
              {kind === 'Payment' ? 'Outflow' : 'Inflow'}
            </span>
          </div>
          <div className="cash-form-grid">
            <label>
              Voucher No. <b>*</b>
              <div>
                <input value="PV-2024-00026" readOnly />
                <Settings2 />
              </div>
            </label>
            <label>
              Date <b>*</b>
              <div>
                <input value="26 Apr 2024" readOnly />
                <CalendarDays />
              </div>
            </label>
            <label>
              Account (Cash Account) <b>*</b>
              <div>
                <Landmark />
                <select value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option>Cash in Hand</option>
                  <option>Meezan Bank — 8721</option>
                </select>
                <ChevronDown />
              </div>
            </label>
            <label>
              Amount <b>*</b>
              <div>
                <span>Rs</span>
                <input placeholder="0.00" />
              </div>
            </label>
            <label>
              Paid To <b>*</b>
              <div>
                <UserRound />
                <input placeholder="Select or enter payee" />
                <ChevronDown />
              </div>
            </label>
            <label>
              Reference No.
              <div>
                <ReceiptText />
                <input placeholder="Enter reference no." />
              </div>
            </label>
            <label>
              Category / Head <b>*</b>
              <div>
                <Settings2 />
                <input placeholder="Select account head" />
                <ChevronDown />
              </div>
            </label>
            <label>
              Remarks / Notes
              <div>
                <FileText />
                <input placeholder="Enter remarks (optional)" />
              </div>
            </label>
          </div>
          <div className="cash-create-foot">
            <button>
              <Upload /> Attach File
            </button>
            <small>Max file size 5 MB (PDF, JPG, PNG)</small>
            <Button kind="secondary">Clear</Button>
            <Button onClick={() => start(kind)}>
              <WalletCards /> Save {kind}
            </Button>
          </div>
        </section>
        <section className="cash-reports">
          <div className="cash-section-head">
            <h2>
              <BarChart3 /> Reports &amp; Filters
            </h2>
            <p>View and print payment &amp; receipt reports</p>
          </div>
          <div className="cash-report-tabs">
            <button
              className={cashTab === 'Reports' ? 'active' : ''}
              onClick={() => setCashTab('Reports')}
            >
              Reports
            </button>
            <button
              className={cashTab === 'Transaction History' ? 'active' : ''}
              onClick={() => setCashTab('Transaction History')}
            >
              Transaction History
            </button>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>1</i> Transaction Type
            </h3>
            <div>
              <button
                className={cashTypeFilter === 'Payments' ? 'active' : ''}
                onClick={() => setCashTypeFilter('Payments')}
              >
                Payments
              </button>
              <button
                className={cashTypeFilter === 'Receipts' ? 'active' : ''}
                onClick={() => setCashTypeFilter('Receipts')}
              >
                Receipts
              </button>
              <button
                className={cashTypeFilter === 'All Transactions' ? 'active' : ''}
                onClick={() => setCashTypeFilter('All Transactions')}
              >
                All Transactions
              </button>
            </div>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>2</i> Date Filter
            </h3>
            <div>
              <button
                className={cashDateFilter === 'One (Date Wise)' ? 'active' : ''}
                onClick={() => setCashDateFilter('One (Date Wise)')}
              >
                One (Date Wise)
              </button>
              <button
                className={cashDateFilter === 'All (Date Wise)' ? 'active' : ''}
                onClick={() => setCashDateFilter('All (Date Wise)')}
              >
                All (Date Wise)
              </button>
            </div>
            <label>
              Date Range
              <div>
                <CalendarDays />
                <input value="26 Apr 2024   –   26 Apr 2024" readOnly />
                <ChevronDown />
              </div>
            </label>
          </div>
          <div className="cash-filter-card">
            <h3>
              <i>3</i> Number Filter
            </h3>
            <div>
              <button
                className={cashNumberFilter === 'One (Number Wise)' ? 'active' : ''}
                onClick={() => setCashNumberFilter('One (Number Wise)')}
              >
                One (Number Wise)
              </button>
              <button
                className={cashNumberFilter === 'All (Number Wise)' ? 'active' : ''}
                onClick={() => setCashNumberFilter('All (Number Wise)')}
              >
                All (Number Wise)
              </button>
            </div>
            <h4>
              Voucher Number Range{' '}
              <small>ⓘ Filter by voucher number range (can be combined with date range)</small>
            </h4>
            <div className="cash-range">
              <label>
                From No.
                <input value="PV-2024-00001" readOnly />
              </label>
              <label>
                To No.
                <input value="PV-2024-00050" readOnly />
              </label>
            </div>
          </div>
          <div className="cash-report-actions">
            <Button>
              <BarChart3 /> Generate Report
            </Button>
            <button>
              <Upload /> Export <ChevronDown />
            </button>
          </div>
        </section>
      </div>
      <section className="cash-recent">
        <div className="cash-recent-head">
          <div>
            <h2>
              <ReceiptText /> Recent Cash Transactions
            </h2>
            <p>Latest payment and receipt vouchers</p>
          </div>
          <div>
            <label>
              <Search />
              <input placeholder="Search transactions..." />
            </label>
            <button>
              <Filter /> Filter
            </button>
            <button>
              <ArrowDown /> Sort: Date (Newest)
              <ChevronDown />
            </button>
          </div>
        </div>
        <Table
          headers={[
            '#',
            'Voucher No.',
            'Type',
            'Date',
            'Account Name',
            'Counterparty',
            'Amount',
            'Status',
            'Remarks',
            '',
          ]}
          rows={[
            [
              '1',
              'RV-2024-00018',
              <Badge tone="good">↓ Receipt</Badge>,
              '26 Apr 2024',
              'Cash in Hand',
              'Acme Corporation',
              <b className="cash-green">Rs 5,000.00</b>,
              <Badge tone="good">● Posted</Badge>,
              'Sales collection',
              <MoreHorizontal />,
            ],
            [
              '2',
              'PV-2024-00026',
              <Badge tone="danger">↑ Payment</Badge>,
              '26 Apr 2024',
              'Cash in Hand',
              'Office Supplies Mart',
              <b className="cash-red">Rs 2,500.00</b>,
              <Badge tone="good">● Posted</Badge>,
              'Stationery purchase',
              <MoreHorizontal />,
            ],
            [
              '3',
              'RV-2024-00017',
              <Badge tone="good">↓ Receipt</Badge>,
              '25 Apr 2024',
              'Cash in Hand',
              'Rakesh Traders',
              <b className="cash-green">Rs 7,500.00</b>,
              <Badge tone="good">● Posted</Badge>,
              'Payment against invoice #RT-100',
              <MoreHorizontal />,
            ],
            [
              '4',
              'PV-2024-00025',
              <Badge tone="danger">↑ Payment</Badge>,
              '25 Apr 2024',
              'Cash in Hand',
              'Electricity Board',
              <b className="cash-red">Rs 6,250.00</b>,
              <Badge tone="good">● Posted</Badge>,
              'Electricity bill payment',
              <MoreHorizontal />,
            ],
            [
              '5',
              'RV-2024-00016',
              <Badge tone="good">↓ Receipt</Badge>,
              '24 Apr 2024',
              'Cash in Hand',
              'Walk-in Customer',
              <b className="cash-green">Rs 3,000.00</b>,
              <Badge tone="good">● Posted</Badge>,
              'Misc. income',
              <MoreHorizontal />,
            ],
            ...data.payments.map((p) => [
              p.id,
              p.id,
              <Badge tone={p.kind === 'Receipt' ? 'good' : 'danger'}>{p.kind}</Badge>,
              p.date,
              p.account,
              partyName(p.party),
              <b>{money(p.total)}</b>,
              <Badge tone="good">● Posted</Badge>,
              '',
              <MoreHorizontal />,
            ]),
          ]}
        />
        <div className="cash-pagination">
          <span>Showing 1 to 5 of 5 transactions</span>
          <div>
            <button>‹</button>
            <button className="active">1</button>
            <button>›</button>
          </div>
        </div>
      </section>
      {open && (
        <Modal
          title={`New ${kind.toLowerCase()} — allocate against open invoices`}
          onClose={() => setOpen(false)}
          wide
        >
          <div className="mode-picker">
            <button
              className={kind === 'Receipt' ? 'active' : ''}
              onClick={() => start('Receipt')}
              type="button"
            >
              Receipt
            </button>
            <button
              className={kind === 'Payment' ? 'active' : ''}
              onClick={() => start('Payment')}
              type="button"
            >
              Payment
            </button>
          </div>
          <div className="form-grid">
            <label>
              Party{kind === 'Receipt' ? ' (customer)' : ' (supplier)'}
              <select value={party} onChange={(e) => pickParty(e.target.value)}>
                {(kind === 'Receipt' ? customers : suppliers).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Paid from / into
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option>Cash in Hand</option>
                <option>Meezan Bank — 8721</option>
                <option>HBL — 2294</option>
              </select>
            </label>
          </div>
          <Panel
            title="Allocate against open documents"
            sub={`${openDocs.length} open · ${docTotal ? money(docTotal) : '—'} total`}
          >
            <Table
              headers={['Ref', 'Date', 'Party doc', 'Total', 'Allocate']}
              rows={effectiveDoc.map((d) => {
                const isSale = 'customer' in d
                return [
                  <b>{d.id}</b>,
                  d.date,
                  d.product ?? (isSale ? (d as { customer: string }).customer : ''),
                  money(d.amount),
                  <input
                    aria-label={`Allocate ${d.id}`}
                    style={{ width: 110 }}
                    type="number"
                    value={alloc[d.id] ?? 0}
                    min="0"
                    max={d.amount}
                    onChange={(e) =>
                      setAlloc((a) => ({
                        ...a,
                        [d.id]: Math.min(Number(e.target.value) || 0, d.amount),
                      }))
                    }
                  />,
                ]
              })}
            />
          </Panel>
          <div className="summary-strip">
            <span>
              Allocated<b>{money(allocated)}</b>
            </span>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 9,
                color: '#64748B',
              }}
            >
              WHT u/s 153(1)(b)
              <input
                type="number"
                style={{
                  height: 30,
                  border: '1px solid #E4E9EF',
                  borderRadius: 8,
                  padding: '0 8px',
                }}
                value={wtax}
                onChange={(e) => setWtax(Number(e.target.value))}
              />
            </label>
            <span>
              Net {kind.toLowerCase()}
              <b>{money(Math.max(0, allocated - (Number(wtax) || 0)))}</b>
            </span>
          </div>
          <div className="modal-foot">
            <Button kind="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>
              <Check /> Post {kind.toLowerCase()}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
