'use client'
import { ArrowDownRight, ArrowUpRight, Landmark, WalletCards } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Master } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Kpi, Panel } from '@finsoft/ui'
import { money } from '@finsoft/ui'
import { buildLedger, entriesOf, netOf, rootOf } from './ledger-data'

/** Grouped <select> over the four-level chart; use postable=true to restrict to level-4 transaction accounts. */
export function AccountSelect({
  masters,
  value,
  onChange,
  postable = false,
}: {
  masters: Master[]
  value: string
  onChange: (code: string) => void
  postable?: boolean
}) {
  const chart = masters.filter(
    (m) => m.level && m.code && /^[0-9]/.test(m.code) && (!postable || m.level === 4),
  )
  const roots = chart.filter((m) => m.level === 1).sort((a, b) => a.code.localeCompare(b.code))
  const groups = roots
    .map((root) => ({
      label: `${root.name} (${root.code})`,
      items: chart
        .filter((m) => m.code !== root.code && rootOf(chart, m).code === root.code)
        .sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .filter((g) => g.items.length)
  return (
    <label className="lg-pick">
      <span>Select account</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Select account">
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((m) => (
              <option key={m.code} value={m.code}>
                {'\u00A0'.repeat(((m.level ?? 1) - 1) * 2)}
                {m.name} — {m.code}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

export function LedgerKpis({ data, master }: { data: AppData; master: Master }) {
  const net = netOf(data.journals, master.name)
  const opening = master.balance || 0
  const closing = opening + net.dr - net.cr
  const dN = entriesOf(data.journals, master.name, 'Dr'),
    cN = entriesOf(data.journals, master.name, 'Cr')
  return (
    <div className="kpi-grid lg-kpis">
      <Kpi
        label="Opening balance"
        value={money(Math.abs(opening))}
        change={
          opening
            ? `${master.balanceType === 'Credit' ? 'Cr' : 'Dr'} · b/f 01 Aug 2026`
            : 'Nil at period start'
        }
        icon={Landmark}
      />
      <Kpi
        label="Debits (Dr)"
        value={money(net.dr)}
        change={`${dN} posting${dN === 1 ? '' : 's'} on debit side`}
        icon={ArrowDownRight}
        tone="teal"
      />
      <Kpi
        label="Credits (Cr)"
        value={money(net.cr)}
        change={`${cN} posting${cN === 1 ? '' : 's'} on credit side`}
        icon={ArrowUpRight}
        tone="yellow"
      />
      <Kpi
        label="Closing balance"
        value={money(Math.abs(closing))}
        change={
          closing === 0 ? 'Nil at 30 Aug 2026' : `${closing >= 0 ? 'Dr' : 'Cr'} · c/f 30 Aug 2026`
        }
        icon={WalletCards}
        tone="blue"
      />
    </div>
  )
}

function BalTag({ n, side }: { n: number; side?: 'Dr' | 'Cr' }) {
  if (!n) return <span className="bal-nil">Rs 0</span>
  return (
    <b className="bal-amt">
      {money(Math.abs(n))}
      {side && <span className={`bal-side ${side === 'Dr' ? 'dr' : 'cr'}`}>{side}</span>}
    </b>
  )
}

export function LedgerBook({
  data,
  master,
  action,
}: {
  data: AppData
  master: Master
  action?: ReactNode
}) {
  const opening = master.balance || 0
  const { rows, closing, side, count } = buildLedger(data.journals, master.name, opening)
  const openSide = opening ? (master.balanceType === 'Credit' ? 'Cr' : 'Dr') : undefined
  const totals = rows.reduce((a, r) => ({ dr: a.dr + r.dr, cr: a.cr + r.cr }), { dr: 0, cr: 0 })
  return (
    <Panel
      title="Ledger statement"
      sub="Every posting in date order — Dr and Cr as posted, with a running balance after each line"
      action={action}
    >
      <div className="ledg-wrap">
        <div className="ledg">
          <div className="ledg-head">
            <span>Date</span>
            <span>Voucher</span>
            <span>Particulars</span>
            <span className="num">Debit</span>
            <span className="num">Credit</span>
            <span className="num">Balance</span>
          </div>
          {opening !== 0 && (
            <div className="ledg-row bf">
              <span className="d">01 Aug 2026</span>
              <span className="v">—</span>
              <span className="part">
                <b>Balance brought forward</b>
                <small>
                  {openSide} opening · {master.balanceType} nature
                </small>
              </span>
              <span className="num">—</span>
              <span className="num">—</span>
              <span className="num">
                <BalTag n={opening} side={openSide} />
              </span>
            </div>
          )}
          {rows.map((r, i) => (
            <div className="ledg-row" key={i}>
              <span className="d">{r.date}</span>
              <span className="v">{r.ref}</span>
              <span className="part">
                <b>{r.desc}</b>
                <small>{r.toBy}</small>
              </span>
              <span className="num">{r.dr ? money(r.dr) : '—'}</span>
              <span className="num">{r.cr ? money(r.cr) : '—'}</span>
              <span className="num">
                <BalTag n={r.running} side={r.side} />
              </span>
            </div>
          ))}
          {rows.length === 0 && opening === 0 && (
            <div className="ledg-empty">
              No postings reached this account during Aug 2026 — balance is nil.
            </div>
          )}
          <div className="ledg-row total">
            <span className="d">30 Aug 2026</span>
            <span className="v">
              {count} posting{count === 1 ? '' : 's'}
            </span>
            <span className="part">
              <b>Closing balance c/f</b>
              <small>
                Net of {count} entry{count === 1 ? '' : 'ies'} posted this period
              </small>
            </span>
            <span className="num">
              <b>{money(totals.dr)}</b>
            </span>
            <span className="num">
              <b>{money(totals.cr)}</b>
            </span>
            <span className="num">
              <BalTag n={closing} side={side} />
            </span>
          </div>
        </div>
      </div>
    </Panel>
  )
}
