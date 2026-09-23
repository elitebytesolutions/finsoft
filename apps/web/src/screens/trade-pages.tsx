'use client'
import { useNavigate } from '@/lib/router'
import {
  ArrowRight,
  Check,
  ClipboardCheck,
  Clock3,
  FileText,
  LockKeyhole,
  TrendingUp,
  Users,
  WalletCards,
} from 'lucide-react'
import { employees } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Button, Kpi, PageHead, Panel, Table } from '@finsoft/ui'
import { money } from '@finsoft/ui'

function FieldSales() {
  const navigate = useNavigate()
  const reps = [
    ['Bilal Khan', 'Rs 1,200,000', 'Rs 1,012,000', 'Rs 25,300'],
    ['Sana Javed', 'Rs 900,000', 'Rs 986,000', 'Rs 24,650'],
    ['Umar Farooq', 'Rs 800,000', 'Rs 612,000', 'Rs 15,300'],
  ]
  const target = reps.reduce((a, r) => a + Number(String(r[1]).replace(/[^0-9]/g, '')), 0)
  const achieved = reps.reduce((a, r) => a + Number(String(r[2]).replace(/[^0-9]/g, '')), 0)
  const roster = employees.filter((r) => String(r[2]).toLowerCase().includes('sales'))
  const pct = target ? Math.round((achieved / target) * 100) : 0
  return (
    <>
      <PageHead
        eyebrow="Sales & POS / Field sales"
        title="Field sales"
        description="Representative performance, targets, commission and delivery coverage across the sales force."
        actions={
          <Button kind="secondary">
            <ClipboardCheck /> Assign territory
          </Button>
        }
      />
      <div className="kpi-grid">
        <Kpi
          label="Representatives"
          value={String(reps.length)}
          change="Active field team"
          icon={Users}
        />
        <Kpi
          label="Sales target"
          value={money(target)}
          change="August 2026"
          icon={TrendingUp}
          tone="teal"
        />
        <Kpi
          label="Achieved"
          value={money(achieved)}
          change={`${pct}% of target`}
          icon={WalletCards}
          tone="yellow"
        />
      </div>
      <div className="doc-grid">
        <Panel
          title="Representative performance"
          sub="Targets, returns and commission · from the sales register"
        >
          <Table
            headers={['Representative', 'Target', 'Achieved', 'Commission']}
            rows={reps.map((r) => [<b>{r[0]}</b>, r[1], r[2], r[3]])}
          />
        </Panel>
        <Panel title="Field team roster" sub="Employees assigned to field sales">
          <Table
            headers={['ID', 'Name', 'Designation', 'Branch']}
            rows={roster.map((r) => [r[0], r[1], r[2], r[3]])}
          />
        </Panel>
      </div>
      <div className="lower-grid">
        <Panel title="Booker & delivery coverage" sub="Legacy routes surfaced as one view">
          <Table
            headers={['Route / area', 'Booker', 'Deliveryman', 'Stops']}
            rows={[
              ['Lahore — Gulberg', 'Bilal Khan', 'Rashid', '28'],
              ['Lahore — DHA', 'Sana Javed', 'Imran', '34'],
              ['Rawalpindi — Saddar', 'Umar Farooq', 'Kamran', '22'],
            ]}
          />
        </Panel>
        <Panel title="Credit in market" sub="Field credit exposure by representative">
          <div className="totals-card">
            <div>
              <span>Field credit</span>
              <b>Rs 64,280</b>
            </div>
            <div>
              <span>Uncleared invoices</span>
              <b>18</b>
            </div>
            <div>
              <span>Collection due</span>
              <b>Rs 214,000</b>
            </div>
          </div>
          <div className="modal-foot" style={{ border: 0, margin: 0, padding: '4px 0 0' }}>
            <Button onClick={() => navigate('/receivables')}>
              <ArrowRight /> Open receivables
            </Button>
          </div>
        </Panel>
      </div>
    </>
  )
}

function PeriodClose({ data }: { data: AppData }) {
  const revenue = data.journals
    .filter((j) => j.credit === 'Sales Revenue')
    .reduce((a, j) => a + j.amount, 0)
  const cogs = data.journals
    .filter((j) => j.debit === 'Cost of Goods Sold')
    .reduce((a, j) => a + j.amount, 0)
  const drafts = data.purchases.filter((p) => p.status === 'Draft')
  const checks = [
    ['Journal vouchers balanced', 'All posted entries are double-entry', data.journals.length > 0],
    ['Bank reconciliation', 'Meezan Bank — 8721 matched for August', false],
    ['Draft purchase invoices', 'Abbott PUR-2026-0182 is still a draft', drafts.length === 0],
    ['Date lock', 'Posting window ends 31 Aug 2026', false],
  ]
  return (
    <>
      <PageHead
        eyebrow="Accounting / Period close"
        title="Period close"
        description="Lock the fiscal month for posting — a pre-close checklist mirrors the legacy DATASECURE date lock."
        actions={
          <Button>
            <LockKeyhole /> Close August 2026
          </Button>
        }
      />
      <div className="kpi-grid">
        <Kpi
          label="Period revenue"
          value={money(revenue)}
          change="Sales revenue posted"
          icon={TrendingUp}
        />
        <Kpi
          label="Cost of sales"
          value={money(cogs)}
          change="COGS vouchers posted"
          icon={WalletCards}
          tone="teal"
        />
        <Kpi
          label="Net surplus"
          value={money(revenue - cogs)}
          change="August 2026 · pre-close"
          icon={Clock3}
          tone="blue"
        />
        <Kpi
          label="Open drafts"
          value={String(drafts.length)}
          change="Must post or cancel"
          icon={FileText}
          tone="yellow"
        />
      </div>
      <div className="doc-grid">
        <Panel title="Pre-close checklist" sub="Run before locking the period">
          <div className="period-checks">
            {checks.map(([name, desc, ok]) => (
              <div key={String(name)}>
                <span className={ok ? 'ok' : ''}>{ok ? <Check /> : <Clock3 />}</span>
                <div>
                  <b>{name}</b>
                  <p>{desc}</p>
                </div>
                <Badge tone={ok ? 'good' : 'warn'}>{ok ? 'Ready' : 'Review'}</Badge>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Fiscal periods" sub="Closed periods are locked for posting">
          <Table
            headers={['Period', 'Opened', 'Status', 'Closed by']}
            rows={[
              ['FY 2026-27', '01 Jul 2026', <Badge tone="good">Open</Badge>, '—'],
              ['FY 2025-26', '01 Jul 2025', <Badge>Closed</Badge>, 'Ahmed Raza'],
              ['FY 2024-25', '01 Jul 2024', <Badge>Closed</Badge>, 'Ahmed Raza'],
            ]}
          />
        </Panel>
      </div>
      <Panel title="What happens at close" sub="Mirrors the legacy posting controls">
        <div className="summary-strip">
          <span>
            Posting<b>Locked for August 2026</b>
          </span>
          <span>
            Vouchers<b>New period numbering</b>
          </span>
          <span>
            Ledgers<b>Opening balances rolled</b>
          </span>
          <span>
            Reports<b>Month frozen</b>
          </span>
        </div>
      </Panel>
    </>
  )
}

export { FieldSales, PeriodClose }
