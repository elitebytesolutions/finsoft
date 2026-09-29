'use client'
import { useState, type FormEvent } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowRight,
  ClipboardCheck,
  Clock3,
  FileText,
  LockKeyhole,
  TrendingUp,
  Users,
  WalletCards,
} from 'lucide-react'
import { employees } from '@/mocks/api'
import {
  Badge,
  Banner,
  Button,
  Field,
  Kpi,
  Modal,
  PageHead,
  Panel,
  Table,
  TextInput,
} from '@finsoft/ui'
import { money } from '@finsoft/ui'
import { useApiQuery } from '@/lib/api/use-api-query'
import { closePeriod, listPeriods, reopenPeriod } from '@/lib/api/accounting-client'
import { ApiError } from '@/lib/api/types'
import type { FiscalPeriodDto } from '@/lib/api/accounting-types'

// FieldSales is untouched by this lane — same file as PeriodClose in the ported prototype, but
// owned elsewhere. Byte-identical to 8c5c283 and to HEAD before this restoration; do not edit
// here.
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

/*
 * /period-close — the PO's original two-panel design (8c5c283), restored, on real data:
 * GET /api/periods, POST /api/periods/:id/{close,reopen}. No lock route, no bank-reconciliation
 * or draft-purchase checks in M2 (periods.md §7 — deferred; the original mock's pre-close
 * checklist items for those are not backed by any endpoint, so that panel is now an honest
 * "not available yet" notice instead of four invented pass/fail rows). Revenue/COGS/"net
 * surplus" KPIs are gone for the same reason the mock's own comment for the chart-of-accounts
 * page flagged: they were `data.journals` summed in the browser — not available from the real
 * fiscal-periods API at all, so the KPI row now shows real period counts instead.
 */
function PeriodClose() {
  const { state, reload } = useApiQuery(() => listPeriods().then((r) => [...r.periods]), [])

  return (
    <>
      <PageHead
        eyebrow="Accounting / Period close"
        title="Period close"
        description="Lock the fiscal month for posting. Correcting a closed period is by reversal, in an open period — never by reopening it lightly."
      />

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <Clock3 />
          </span>
          <h1>Loading fiscal periods…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <LockKeyhole />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view fiscal periods.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <LockKeyhole />
          </span>
          <h1>We could not load the fiscal periods</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <div className="empty-state">No fiscal periods exist yet for this tenant.</div>
        ) : (
          <PeriodCloseReady periods={state.data} onChanged={reload} />
        ))}
    </>
  )
}

function PeriodCloseReady({
  periods,
  onChanged,
}: {
  periods: FiscalPeriodDto[]
  onChanged: () => void
}) {
  const ordered = [...periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart))
  const openPeriods = ordered.filter((p) => p.status === 'OPEN')
  const closedPeriods = ordered.filter((p) => p.status === 'CLOSED')
  const lockedPeriods = ordered.filter((p) => p.status === 'LOCKED')

  return (
    <>
      {/* Counts only, deliberately — a period's own label (e.g. "2026-07") also appears as a
       * table cell below; repeating it here as a KPI VALUE risks two elements with identical
       * text, which is also just a worse way to say "see the table". */}
      <div className="kpi-grid">
        <Kpi
          label="Fiscal periods"
          value={String(periods.length)}
          change="This tenant"
          icon={FileText}
        />
        <Kpi
          label="Open"
          value={String(openPeriods.length)}
          change="Earliest closes first"
          icon={Clock3}
          tone="teal"
        />
        <Kpi
          label="Closed"
          value={String(closedPeriods.length)}
          change="Locked for posting"
          icon={LockKeyhole}
          tone="blue"
        />
        <Kpi
          label="Locked"
          value={String(lockedPeriods.length)}
          change="Cannot be reopened"
          icon={TrendingUp}
          tone="yellow"
        />
      </div>
      <div className="doc-grid">
        <Panel title="Pre-close checklist" sub="Run before locking the period">
          <div className="empty-state">
            Automated pre-close checks (bank reconciliation, open drafts, date lock) are not
            available yet — review these manually before closing a period.
          </div>
        </Panel>
        <Panel title="Fiscal periods" sub="Closed periods are locked for posting">
          <PeriodTable periods={ordered} onChanged={onChanged} />
        </Panel>
      </div>
      <Panel title="What happens at close" sub="Mirrors the legacy posting controls">
        <div className="summary-strip">
          <span>
            Posting<b>Locked for the closed period</b>
          </span>
          <span>
            Vouchers<b>New period numbering</b>
          </span>
          <span>
            Ledgers<b>Opening balances rolled</b>
          </span>
          <span>
            Reports<b>Period frozen</b>
          </span>
        </div>
      </Panel>
    </>
  )
}

function PeriodTable({
  periods,
  onChanged,
}: {
  periods: FiscalPeriodDto[]
  onChanged: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reopenTarget, setReopenTarget] = useState<FiscalPeriodDto | null>(null)

  // Order rule (periods.md §4.1): close only the earliest OPEN period; reopen only the
  // latest CLOSED one. Computed client-side as a UX convenience — the server is the real
  // gate (409 period_close_out_of_order / period_reopen_out_of_order on any other attempt).
  const earliestOpenId = periods.find((p) => p.status === 'OPEN')?.id
  const closedPeriods = periods.filter((p) => p.status === 'CLOSED')
  const latestClosedId = closedPeriods[closedPeriods.length - 1]?.id

  const doClose = async (period: FiscalPeriodDto) => {
    setBusyId(period.id)
    setError(null)
    try {
      await closePeriod(period.id)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close this period.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Table
        headers={['Period', 'Status', 'Start', 'End', 'Actions']}
        rows={periods.map((p) => [
          p.label,
          <Badge tone={p.status === 'OPEN' ? 'good' : p.status === 'CLOSED' ? 'warn' : 'neutral'}>
            {p.status === 'OPEN' ? 'Open' : p.status === 'CLOSED' ? 'Closed' : 'Locked'}
          </Badge>,
          p.periodStart,
          p.periodEnd,
          <span style={{ display: 'flex', gap: 8 }}>
            {p.status === 'OPEN' && (
              <Button
                kind="secondary"
                busy={busyId === p.id}
                disabled={p.id !== earliestOpenId}
                onClick={() => doClose(p)}
              >
                Close
              </Button>
            )}
            {p.status === 'CLOSED' && p.id === latestClosedId && (
              <Button kind="danger" onClick={() => setReopenTarget(p)}>
                Reopen
              </Button>
            )}
          </span>,
        ])}
      />
      {reopenTarget && (
        <ReopenDialog
          period={reopenTarget}
          onClose={() => setReopenTarget(null)}
          onDone={() => {
            setReopenTarget(null)
            onChanged()
          }}
        />
      )}
    </>
  )
}

function ReopenDialog({
  period,
  onClose,
  onDone,
}: {
  period: FiscalPeriodDto
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await reopenPeriod(period.id, { reason: reason.trim() })
      onDone()
    } catch (err) {
      // `period.reopen` is Owner-only (contract §6's permission ruling) — the only way this
      // call 403s is the caller not holding it, so a plain `forbidden` is mapped to a clear,
      // specific message rather than apiFetch's generic "You do not have permission to do
      // that." No real per-user permission list reaches the client to hide the Reopen button
      // proactively for a non-Owner; this is the second line of defence, and the server's
      // rejection is still the real gate either way.
      if (err instanceof ApiError && err.code === 'forbidden') {
        setError('Only the Owner can reopen a period.')
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not reopen this period.')
      }
      setSubmitting(false)
    }
  }

  return (
    <Modal title={`Reopen ${period.label}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p>
          Reopening {period.label} allows postings into it again. Only the Owner role can do this.
          State why — this is audited.
        </p>
        <Field label="Reason" htmlFor="reopen-reason" required error={error ?? undefined}>
          <TextInput id="reopen-reason" value={reason} onChange={setReason} required />
        </Field>
        <div className="modal-foot">
          <Button kind="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="danger" type="submit" busy={submitting}>
            Reopen period
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export { FieldSales, PeriodClose }
