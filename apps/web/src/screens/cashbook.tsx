'use client'
import { useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, Banknote, CalendarDays, ChevronDown, ChevronRight, Clock3, CloudUpload, Coins, CreditCard, FileText, Landmark, MessageSquareText, Save, Tag, User, Users, Wallet, WalletCards } from 'lucide-react'
import type { AppData } from '@/mocks/api'
const money=(n:number)=>'Rs '+n.toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2})

type Kind = 'In' | 'Out'
type Entry = { id:string; kind:Kind; account:string; amount:number }
const emptyForm = { date:'2026-08-30', time:'14:30', party:'', partyPick:'', category:'', account:'Main Cash Drawer', mode:'Cash', reference:'', amount:'', notes:'' }

function Field({label,required,icon,children,full,extra}:{label:string;required?:boolean;icon:ReactNode;children:ReactNode;full?:boolean;extra?:string}){
 return <label className={`cb-f${full?' full':''}${extra?' '+extra:''}`}><span className="cb-l">{label}{required&&<em>*</em>}</span><span className="cb-in"><i>{icon}</i>{children}</span></label>
}
function GroupLabel({label,first}:{label:string;first?:boolean}){
 return <div className={`cb-group-label${first?' first':''}`}>{label}</div>
}

export function CashBook({data}:{data:AppData}){
 const [quick,setQuick]=useState('Cash Only')
 const [entries,setEntries]=useState<Entry[]>([])
 const [fin,setFin]=useState({...emptyForm,party:'Walk-in Customer',category:'Sales Revenue'})
 const [fout,setFout]=useState({...emptyForm,party:'Office Mart Sdn Bhd',category:'Office Supplies'})
 const [inDragOver,setInDragOver]=useState(false)
 const base={drawer:12480,bank:24300,petty:2700}
 const delta=(acct:string)=>entries.filter(e=>e.account===acct).reduce((a,e)=>a+(e.kind==='In'?e.amount:-e.amount),0)
 const drawer=base.drawer+delta('Main Cash Drawer'), bank=base.bank+delta('Bank Account'), petty=base.petty+delta('Petty Cash')
 const total=drawer+bank+petty
 const customers=data.masters.filter(m=>m.type==='Customer').map(m=>m.name)
 const vendors=data.masters.filter(m=>m.type==='Supplier').map(m=>m.name)
 const accounts=['Main Cash Drawer','Bank Account','Petty Cash']

 const submit=(kind:Kind)=>(e:FormEvent)=>{
  e.preventDefault()
  const f=kind==='In'?fin:fout; const amt=Number(f.amount)
  if(!f.party||!amt||!f.category)return
  setEntries(l=>[{id:`CB-${l.length+1}`,kind,account:f.account,amount:amt},...l])
  if(kind==='In')setFin({...emptyForm,party:'Walk-in Customer',category:'Sales Revenue'}); else setFout({...emptyForm,party:'Office Mart Sdn Bhd',category:'Office Supplies'})
 }

 const renderPanel=(kind:Kind)=>{
  const f=kind==='In'?fin:fout, set=(p:Partial<typeof f>)=>kind==='In'?setFin(x=>({...x,...p})):setFout(x=>({...x,...p}))
  const out=kind==='Out'
  return <form className={`cb-panel ${out?'out':'in'}`} onSubmit={submit(kind)}>
   <div className="cb-ph">
    <span className="cb-ph-icon">{out?<ArrowUpFromLine/>:<ArrowDownToLine/>}</span>
    <div><h2>{out?'Cash Out':'Cash In'}</h2><p>{out?'Record money paid out from your business':'Record money received into your business'}</p></div>
    <span className="cb-ph-badge">{out?'Manage your expenses':'Increase your cash flow'}</span>
   </div>
   <div className="cb-grid">
    <GroupLabel label="When" first/>
    <Field label="Date" required icon={<CalendarDays/>}><input type="date" value={f.date} onChange={e=>set({date:e.target.value})}/><CalendarDays className="cb-trail"/></Field>
    <Field label="Time" required icon={<Clock3/>}><input type="time" value={f.time} onChange={e=>set({time:e.target.value})}/></Field>
    <GroupLabel label="Who"/>
    <Field label={out?'Paid To / Party':'Received From / Party'} required icon={<User/>} full><input value={f.party} onChange={e=>set({party:e.target.value})} placeholder={out?'Office Mart Sdn Bhd':'Walk-in Customer'}/><ChevronRight className="cb-trail"/></Field>
    <Field label={out?'Vendor':'Customer'} required={out} icon={<Users/>} full><select value={f.partyPick} onChange={e=>set({partyPick:e.target.value,party:e.target.value||f.party})}><option value="">{out?'Select a vendor (e.g. Office Mart Sdn Bhd)':'Select a customer (e.g. ABC Sdn Bhd)'}</option>{(out?vendors:customers).map(c=><option key={c}>{c}</option>)}</select><ChevronDown className="cb-trail"/></Field>
    <GroupLabel label="What"/>
    <Field label="Category" required icon={<Tag/>}><select value={f.category} onChange={e=>set({category:e.target.value})}>{(out?['Office Supplies','Accounts Payable','Rent Expense','Utilities','Salaries']:['Sales Revenue','Accounts Receivable','Other Income']).map(c=><option key={c}>{c}</option>)}</select><ChevronDown className="cb-trail"/></Field>
    <Field label="Account" required icon={<WalletCards/>}><select value={f.account} onChange={e=>set({account:e.target.value})}>{accounts.map(a=><option key={a}>{a}</option>)}</select><ChevronDown className="cb-trail"/></Field>
    <Field label="Payment Mode" required icon={<CreditCard/>}><select value={f.mode} onChange={e=>set({mode:e.target.value})}>{['Cash','Cheque','Bank transfer','Card'].map(m=><option key={m}>{m}</option>)}</select><ChevronDown className="cb-trail"/></Field>
    <Field label="Reference No." icon={<FileText/>}><input value={f.reference} onChange={e=>set({reference:e.target.value})} placeholder={out?'e.g. BILL-2045':'e.g. INV-1042'}/></Field>
    <GroupLabel label="Amount"/>
    <Field label="Amount" required icon={<b className="cb-rs">Rs</b>} full extra="amount-f"><input type="number" min="0" step="0.01" value={f.amount} onChange={e=>set({amount:e.target.value})} placeholder="0.00"/></Field>
    <GroupLabel label="Notes"/>
    <Field label="Notes / Narration" icon={<MessageSquareText/>} full><input value={f.notes} onChange={e=>set({notes:e.target.value})} placeholder={out?'e.g. Office supplies purchase, invoice no., etc.':'e.g. Payment for invoice, customer name, etc.'}/></Field>
   </div>
   <div className="cb-attach"><span className="cb-l">Receipt / Attachment</span><label className="cb-drop"><div className="cb-drop-icon"><CloudUpload/></div><div className="cb-drop-body"><b>Drop your receipt here, or <u>browse</u></b><small>PDF · JPG · PNG &nbsp;·&nbsp; Max 5 MB</small></div><input type="file" hidden/></label></div>
   <button className="cb-save" type="submit"><Save/> {out?'Save Cash Out':'Save Cash In'}</button>
  </form>
 }

 return <div className="cb-page">
  <div className="cb-head"><div><h1>Cash Book Entry</h1><p>Record cash movement quickly and keep your books up to date</p></div><span className="cb-tag">Simple Accounting<br/>for a Brighter Tomorrow.</span></div>

  <div className="cb-kpis">
   <article className="main"><span><Wallet/></span><div><small>Total Liquid Cash</small><b>{money(total)}</b><em>↑ +12.5% from last month</em></div><i className="cb-bars"><u/><u/><u/></i></article>
   <article><span className="g"><Banknote/></span><div><small>Main Cash Drawer</small><b>{money(drawer)}</b></div></article>
   <article><span className="b"><Landmark/></span><div><small>Bank Account</small><b>{money(bank)}</b></div></article>
   <article><span className="y"><Coins/></span><div><small>Petty Cash</small><b>{money(petty)}</b></div></article>
  </div>

  <div className="cb-quick">
   <b>Quick Entry:</b>
   {([['Cash Only',ArrowLeftRight],['Bank Only',Landmark],['Transfer',ArrowLeftRight],['Cheque',WalletCards]] as const).map(([l,I])=><button type="button" key={l} className={quick===l?'active':''} onClick={()=>setQuick(l)}><I/> {l}</button>)}
   <span className="cb-tip">💡 <b>Tip:</b> Use quick entry options for faster data entry.</span>
  </div>

  <div className="cb-panels">{renderPanel('In')}{renderPanel('Out')}</div>
 </div>
}
