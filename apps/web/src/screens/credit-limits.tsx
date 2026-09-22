'use client'
import { useMemo, useState } from 'react'
import { AlertTriangle, CreditCard, FileText, ShieldAlert, TrendingUp, Wallet } from 'lucide-react'
import { usePersistentData } from '@/mocks/api'
import { Badge, Button, Kpi, PageHead, Panel, Table, Modal } from '@finsoft/ui'
import { money } from '@finsoft/ui'

type CreditPolicy = {
  limit: number
  terms: string
  hold: boolean
  lastReview: string
  reviewDue: string
}

const POLICY_DEFAULTS: Record<string, CreditPolicy> = {
  'Shifa Medical Centre': { limit: 100000, terms: 'Net 45', hold: false, lastReview: '01 Aug 2026', reviewDue: '01 Nov 2026' },
  'Adeel Pharmacy': { limit: 50000, terms: 'Net 30', hold: false, lastReview: '15 Jul 2026', reviewDue: '15 Oct 2026' },
  'Al-Rahman Pharmacy': { limit: 75000, terms: 'Net 30', hold: false, lastReview: '10 Aug 2026', reviewDue: '10 Nov 2026' },
  'Mehmood Medical Store': { limit: 40000, terms: 'Net 15', hold: true, lastReview: '01 Jun 2026', reviewDue: '01 Sep 2026' },
  'Zainab Drug House': { limit: 60000, terms: 'Net 30', hold: false, lastReview: '20 Jul 2026', reviewDue: '20 Oct 2026' },
}

export function CreditLimitsTerms() {
  const { data } = usePersistentData()
  const [policy, setPolicy] = useState<Record<string, CreditPolicy>>(() => ({ ...POLICY_DEFAULTS }))
  const [open, setOpen] = useState<string | null>(null)

  const customers = useMemo(() => data.masters.filter(m => m.type === 'Customer' && m.status === 'Active'), [data.masters])
  const creditSales = useMemo(() => data.sales.filter(s => s.status === 'Credit'), [data.sales])

  const rows = useMemo(() => {
    return customers.map(m => {
      const outstanding = creditSales.filter(s => s.customer === m.name).reduce((a, s) => a + s.amount, 0)
      const p = policy[m.name] || { limit: 50000, terms: 'Net 30', hold: false, lastReview: '—', reviewDue: '—' }
      const utilization = p.limit ? outstanding / p.limit : 0
      const available = Math.max(0, p.limit - outstanding)
      const risk = utilization >= 0.9 || p.hold || outstanding > p.limit
      return { master: m, outstanding, limit: p.limit, terms: p.terms, hold: p.hold, utilization, available, risk, lastReview: p.lastReview, reviewDue: p.reviewDue }
    })
  }, [customers, creditSales, policy])

  const totalExposure = rows.reduce((a, r) => a + r.outstanding, 0)
  const atLimit = rows.filter(r => r.utilization >= 0.9).length
  const onHold = rows.filter(r => r.hold).length
  const avgUtil = rows.length ? rows.reduce((a, r) => a + r.utilization, 0) / rows.length : 0

  const editing = rows.find(r => r.master.name === open) || null

  const savePolicy = (customer: string, upd: Partial<CreditPolicy>) => {
    setPolicy(p => ({ ...p, [customer]: { ...(p[customer] || { limit: 50000, terms: 'Net 30', hold: false, lastReview: '', reviewDue: '' }), ...upd } }))
    setOpen(null)
  }

  return (
    <>
      <PageHead
        eyebrow="Receivables / Customer credit"
        title="Credit limits & terms"
        description="Set limits, payment terms and hold status per customer to control exposure and cash conversion."
        actions={<Button kind="secondary"><FileText/> Export report</Button>}
      />
      <div className="kpi-grid">
        <Kpi label="Total credit exposure" value={money(totalExposure)} change={`${customers.length} active customers`} icon={Wallet} />
        <Kpi label="Average utilization" value={`${Math.round(avgUtil * 100)}%`} change="Across portfolio" icon={TrendingUp} tone="teal" />
        <Kpi label="At / over limit" value={String(atLimit)} change={`${onHold} on credit hold`} icon={ShieldAlert} tone="yellow" />
        <Kpi label="Policy reviews due" value={String(rows.filter(r => r.reviewDue.includes('Sep') || r.reviewDue.includes('Oct')).length)} change="Next 60 days" icon={CreditCard} tone="blue" />
      </div>

      <div className="doc-grid">
        <Panel title="Customer credit ledger" sub="Limits, outstanding and available credit by party" action={<Badge tone="info">{rows.length} customers</Badge>}>
          <Table
            headers={['Customer','Limit','Outstanding','Available','Utilization','Terms','Hold','Review','']}
            rows={rows.map(r => [
              <button className="linkable" key={r.master.code} onClick={() => window.location.assign(`/masters/${r.master.code}`)}>{r.master.name}</button>,
              money(r.limit),
              <b>{money(r.outstanding)}</b>,
              money(r.available),
              <span title={`${Math.round(r.utilization * 100)}%`}>
                <span style={{display:'inline-block',width:72,height:8,background:'#e7ecf2',borderRadius:4,overflow:'hidden'}}><i style={{display:'block',height:'100%',width:`${Math.min(100,r.utilization*100)}%`,background:r.utilization>=0.9?'#dd6d72':r.utilization>=0.7?'#f0be65':'#1d9c52'}}/></span>
                {Math.round(r.utilization*100)}%
              </span>,
              <Badge tone="info">{r.terms}</Badge>,
              r.hold ? <Badge tone="danger">Hold</Badge> : <Badge tone="good">Clear</Badge>,
              <small>{r.reviewDue}</small>,
              <button className="table-action" onClick={() => setOpen(r.master.name)}>Edit policy</button>
            ])}
          />
        </Panel>

        <Panel title="Risk highlights" sub="Customers requiring immediate attention">
          <Table
            headers={['Customer','Exposure','Limit','Utilization','Action']}
            rows={rows.filter(r => r.risk).map(r => [
              r.master.name,
              money(r.outstanding),
              money(r.limit),
              `${Math.round(r.utilization*100)}%`,
              <button className="table-action" onClick={() => setOpen(r.master.name)}><AlertTriangle/> Review</button>
            ])}
          />
          {rows.filter(r => r.risk).length === 0 && <div className="empty-state">No customers currently at risk.</div>}
        </Panel>
      </div>

      {open && editing && (
        <Modal title={`Credit policy — ${editing.master.name}`} onClose={() => setOpen(null)} wide>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget as HTMLFormElement)
              savePolicy(editing.master.name, {
                limit: Number(fd.get('limit') || 0),
                terms: String(fd.get('terms') || 'Net 30'),
                hold: fd.get('hold') === 'on',
                lastReview: String(fd.get('lastReview') || ''),
                reviewDue: String(fd.get('reviewDue') || ''),
              })
            }}
          >
            <div className="form-grid">
              <label>Credit limit (PKR)
                <input name="limit" type="number" defaultValue={editing.limit} min={0} required />
              </label>
              <label>Payment terms
                <select name="terms" defaultValue={editing.terms}>
                  <option>Net 15</option>
                  <option>Net 30</option>
                  <option>Net 45</option>
                  <option>Net 60</option>
                  <option>Cash on Delivery</option>
                </select>
              </label>
              <label>Last review
                <input name="lastReview" type="text" defaultValue={editing.lastReview} placeholder="01 Aug 2026" />
              </label>
              <label>Next review due
                <input name="reviewDue" type="text" defaultValue={editing.reviewDue} placeholder="01 Nov 2026" />
              </label>
              <div className="span-2" style={{display:'flex',alignItems:'center',gap:8}}>
                <input id="hold" name="hold" type="checkbox" defaultChecked={editing.hold} />
                <label htmlFor="hold" style={{fontSize:12}}>Place customer on credit hold</label>
              </div>
            </div>
            <div className="summary-strip">
              <span>Current outstanding <b>{money(editing.outstanding)}</b></span>
              <span>Available <b>{money(editing.available)}</b></span>
              <span>Utilization <b>{Math.round(editing.utilization*100)}%</b></span>
            </div>
            <div className="modal-foot">
              <Button kind="secondary" onClick={() => setOpen(null)} type="button">Cancel</Button>
              <Button type="submit"><CreditCard/> Save policy</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
