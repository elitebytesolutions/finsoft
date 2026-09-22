'use client'
import { useState } from 'react'
import { useNavigate } from '@/lib/router'
import { ArrowRight, BadgeCheck, Banknote, Check, Clock3, FileText, Landmark, LayoutTemplate, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import type { BankCheque, Voucher } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Button, Kpi, PageHead, Panel, Table } from '@finsoft/ui'
import { money } from '@finsoft/ui'

const chequeTone=(s:string):'good'|'warn'|'danger'|'info'=>s==='Cleared'?'good':s==='Dishonoured'?'danger':s==='Presented'?'info':'warn'

export function ChequeClearing({data,onStatus}:{data:AppData;onStatus:(id:string,status:BankCheque['status'])=>void}){
 const navigate=useNavigate()
 const [bank,setBank]=useState('All banks')
 const rows=data.cheques.filter(c=>bank==='All banks'||c.bank===bank)
 const exposure=data.cheques.filter(c=>c.status==='In hand'||c.status==='Presented').reduce((a,c)=>a+c.amount,0)
 return <>
  <PageHead eyebrow="Accounting / Cash & bank" title="Cheque clearing" description="Track cheques from receipt to clearing — present, clear or return dishonoured instruments." actions={<Button kind="secondary" onClick={()=>navigate('/bank-book')}><ArrowRight/> Bank reconciliation</Button>}/>
  <div className="kpi-grid mini"><Kpi label="Cheques in hand" value={String(data.cheques.filter(c=>c.status==='In hand').length)} change="Awaiting presentation" icon={Banknote}/><Kpi label="In clearing" value={String(data.cheques.filter(c=>c.status==='Presented').length)} change="Presented to bank" icon={Clock3} tone="teal"/><Kpi label="Clearing exposure" value={money(exposure)} change="Not yet cleared" icon={Landmark} tone="yellow"/></div>
  <div className="toolbar"><select value={bank} onChange={e=>setBank(e.target.value)}><option>All banks</option><option>Meezan Bank — 8721</option><option>HBL — 2294</option></select><Button kind="secondary"><Banknote/> Register new cheque</Button></div>
  <Panel title="Cheque register" sub="Status is tracked against the bank book and V_CLEAR equivalent"><Table headers={['Cheque','Bank','Party','Dated','Amount','Status','']} rows={rows.map(c=>[<b>{c.no}</b>,c.bank,c.party,c.date,<b>{money(c.amount)}</b>,<Badge tone={chequeTone(c.status)}>{c.status}</Badge>,c.status==='In hand'?<button className="table-action" onClick={()=>onStatus(c.id,'Presented')}>Present <ArrowRight/></button>:c.status==='Presented'?<><button className="table-action" onClick={()=>onStatus(c.id,'Cleared')}><Check/> Clear</button><button className="table-action" style={{color:'#b45309'}} onClick={()=>onStatus(c.id,'Dishonoured')}><XCircle/> Return</button></>:c.status==='Dishonoured'?<button className="table-action" onClick={()=>onStatus(c.id,'In hand')}>Re-present <RefreshCw/></button>:<Badge>—</Badge>])}/></Panel>
 </>
}

export function ApprovalQueue({data,onVoucher,onPO,onPurchase,canPost}:{data:AppData;onVoucher:(id:string)=>void;onPO:(id:string)=>void;onPurchase:(id:string)=>void;canPost:boolean}){
 const navigate=useNavigate()
 const vouchers=data.vouchers.filter(v=>v.status==='Draft')
 const pos=data.pos.filter(p=>p.status==='Draft')
 const drafts=data.purchases.filter(p=>p.status==='Draft')
 const total=vouchers.length+pos.length+drafts.length
 return <>
  <PageHead eyebrow="Accounting / Voucher management" title="Approval queue" description="Review and post what is waiting on you — draft vouchers, purchase orders and invoices." actions={<Button kind="secondary" onClick={()=>navigate('/vouchers?type=all')}><ArrowRight/> Voucher register</Button>}/>
  <div className="kpi-grid mini"><Kpi label="Awaiting approval" value={String(total)} change="Across modules" icon={Clock3}/><Kpi label="Draft vouchers" value={String(vouchers.length)} change="Post or edit" icon={FileText} tone="teal"/><Kpi label="Draft orders & invoices" value={String(pos.length+drafts.length)} change="POs and purchases" icon={Landmark} tone="yellow"/></div>
  {vouchers.length?<Panel title="Draft vouchers" sub="Approve to post the double-entry"><Table headers={['Voucher','Date','Type','Narration','Amount','']} rows={vouchers.map(v=>[<b>{v.id}</b>,v.date,<Badge tone="info">{v.type}</Badge>,v.narration,<b>{money(v.lines.reduce((a,l)=>a+l.amount,0))}</b>,<button className="table-action" disabled={!canPost} onClick={()=>onVoucher(v.id)}><BadgeCheck/> Approve & post</button>])}/></Panel>:null}
  {pos.length?<Panel title="Draft purchase orders" sub="Approve to send to the supplier"><Table headers={['PO','Date','Supplier','Lines','Amount','']} rows={pos.map(p=>[<b>{p.id}</b>,p.date,p.supplier,String(p.lines.length),money(p.amount),<button className="table-action" disabled={!canPost} onClick={()=>onPO(p.id)}><BadgeCheck/> Send to supplier</button>])}/></Panel>:null}
  {drafts.length?<Panel title="Draft purchase invoices" sub="Approve to post stock and payables"><Table headers={['Purchase','Date','Supplier','Product','Amount','']} rows={drafts.map(p=>[<b>{p.id}</b>,p.date,p.supplier,p.product,money(p.amount),<button className="table-action" disabled={!canPost} onClick={()=>onPurchase(p.id)}><BadgeCheck/> Post invoice</button>])}/></Panel>:null}
  {!total&&<Panel title="Approval queue"><div className="empty-state">Nothing waiting for approval — all entries are posted.</div></Panel>}
 </>
}

const recurringDefs=[{id:'RENT',name:'Office rent',amount:15000,debit:'Rent Expense',credit:'Meezan Bank — 8721',day:1},{id:'SAL',name:'Staff salaries',amount:45000,debit:'Salaries Expense',credit:'Meezan Bank — 8721',day:28},{id:'ELEC',name:'Electricity (LESCO)',amount:3250,debit:'Electricity Expense',credit:'Meezan Bank — 8721',day:5},{id:'BANK',name:'Bank charges',amount:480,debit:'Bank Charges',credit:'Meezan Bank — 8721',day:25}]
export function RecurringTemplates({data,onRun}:{data:AppData;onRun:(v:Voucher)=>void}){
 const [done,setDone]=useState<string|null>(null)
 const run=(def:typeof recurringDefs[number])=>{const max=Math.max(0,...data.vouchers.filter(v=>v.type==='JV').map(v=>parseInt(v.id.split('-').at(-1)??'0',10)||0))+1;onRun({id:`JV-2026-${String(max).padStart(4,'0')}`,date:'01 Sep 2026',type:'JV',narration:`Recurring — ${def.name}`,reference:`REC-${def.id}`,status:'Posted',posting:'Posted',createdBy:'Ahmed Raza',branch:'Lahore Main',department:'Accounts',lines:[{debit:def.debit,credit:def.credit,amount:def.amount,remark:'Monthly recurring template'}]});setDone(def.id)}
 return <>
  <PageHead eyebrow="Accounting / Voucher management" title="Voucher templates" description="Standing vouchers — rent, salaries, utilities and charges posted automatically each cycle." actions={<Button kind="secondary"><LayoutTemplate/> Manage templates</Button>}/>
  <div className="report-grid">{recurringDefs.map(d=><article className="report-card" key={d.id}><span className="report-icon"><LayoutTemplate/></span><Badge tone="info">Monthly</Badge><h3>{d.name}</h3><p>{money(d.amount)} · {d.debit} → {d.credit}</p><p>Runs on the {d.day} of every month</p><div style={{display:'flex',justifyContent:'space-between',marginTop:12}}><span style={{fontSize:9,color:'#64748B'}}>Next: 01 Sep 2026</span>{done===d.id?<Badge tone="good">Posted ✓</Badge>:<button className="table-action" onClick={()=>run(d)}><Check/> Create voucher</button>}</div></article>)}</div>
 </>
}

export function SettingsPage(){
 return <>
  <PageHead eyebrow="Administration / Settings" title="Settings & control" description="Organisation profile, financial year, document numbering and preferences." actions={<Button><ShieldCheck/> Save changes</Button>}/>
  <div className="doc-grid"><Panel title="Company profile" sub="Shown on invoices, vouchers and statements"><div className="form-grid"><label>Company name<input defaultValue="Bhatti Traders (Pvt) Ltd"/></label><label>Legal name<input defaultValue="Bhatti Traders — Pharmacy & General Trading"/></label><label>NTN<input defaultValue="1234567-8"/></label><label>GST / STRN<input defaultValue="12-3456789-0"/></label><label>City<input defaultValue="Lahore"/></label><label>Phone<input defaultValue="+92 42 3571 8840"/></label></div></Panel>
   <Panel title="Financial year & periods" sub="Current period drives posting locks"><Table headers={['Period','Status','Opened','Closed']} rows={[['FY 2026-27 · August 2026',<Badge tone="good">Open</Badge>,'01 Aug 2026','—'],['FY 2025-26',<Badge>Closed</Badge>,'01 Jul 2025','30 Jun 2026']]}/></Panel></div>
  <div className="lower-grid"><Panel title="Document numbering" sub="Per-type sequences are generated inside the posting transaction"><div className="summary-strip"><span>Vouchers<b>JV / CRV / CPV / BRV / BPV / CV</b></span><span>Invoices<b>INV-2026-xxxx</b></span><span>Purchases<b>PUR-2026-xxxx</b></span><span>Cheques<b>CHQ-xxxx</b></span></div></Panel>
   <Panel title="Preferences" sub="Defaults for entry screens"><div className="tag-list"><Badge tone="info">Currency PKR</Badge><Badge tone="info">GST 17%</Badge><Badge tone="info">Credit terms Net 30</Badge><Badge tone="info">FEFO stock picking</Badge><Badge tone="good">Auto voucher numbering</Badge></div></Panel></div>
 </>
}
