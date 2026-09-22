'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowLeftRight, Banknote, Building2, CheckCircle2, ChevronDown, CircleSlash2, Clock3, Coins, CreditCard, Download, Edit3, Eye, Globe2, Landmark, Link2, MoreHorizontal, MoreVertical, PiggyBank, Plus, RefreshCw, Search, Settings2, Star, Users, Wallet, X } from 'lucide-react'
import type { AppData } from '@/mocks/api'
import { Badge } from '@finsoft/ui'
import { money } from '@finsoft/ui'

type BankAccount = {
 id:string; bank:string; mark:string; color:string; name:string; last4:string; tags:string[]; status:'Active'|'Needs Sync'|'Manual'|'Dormant'
 branch:string; currency:string; current:number; available:number; sync:string; syncTone:'good'|'warn'|'muted'; primary?:boolean
}

const seedAccounts:BankAccount[] = [
 {id:'BA-1',bank:'HBL',mark:'HBL',color:'#0c8a4a',name:'HBL Business Checking',last4:'1234',tags:['Checking','Primary'],status:'Active',branch:'Gulberg, Lahore',currency:'PKR',current:1240450,available:1180320,sync:'Last synced: 2 hours ago',syncTone:'good',primary:true},
 {id:'BA-2',bank:'Meezan Bank',mark:'MB',color:'#0f7a52',name:'Meezan Bank Savings',last4:'5678',tags:['Savings'],status:'Active',branch:'I.I. Chundrigar Road, Karachi',currency:'PKR',current:480200,available:480200,sync:'Last synced: 1 hour ago',syncTone:'good'},
 {id:'BA-3',bank:'UBL',mark:'UBL',color:'#0f3f7a',name:'UBL Payroll Account',last4:'9012',tags:['Payroll'],status:'Active',branch:'Blue Area, Islamabad',currency:'PKR',current:318750,available:300000,sync:'Last synced: 5 hours ago',syncTone:'good'},
 {id:'BA-4',bank:'MCB',mark:'MCB',color:'#7a1f1f',name:'MCB Operations',last4:'3456',tags:['Checking'],status:'Needs Sync',branch:'Model Town, Lahore',currency:'PKR',current:90500,available:90500,sync:'Last synced: 3 days ago',syncTone:'warn'},
 {id:'BA-5',bank:'Allied Bank',mark:'AB',color:'#8a1620',name:'Allied Bank USD Account',last4:'7788',tags:['Foreign Currency','USD'],status:'Active',branch:'Clifton, Karachi',currency:'USD',current:12450,available:12450,sync:'Last synced: 12 hours ago',syncTone:'good'},
 {id:'BA-6',bank:'Bank Alfalah',mark:'BAF',color:'#a3231f',name:'Bank Alfalah Petty Cash',last4:'1122',tags:['Petty Bank'],status:'Manual',branch:'F-7, Islamabad',currency:'PKR',current:25000,available:25000,sync:'Updated: 10 Nov 2026',syncTone:'muted'},
 {id:'BA-7',bank:'HBL',mark:'HBL',color:'#0c8a4a',name:'HBL USD Account',last4:'9987',tags:['Savings','USD'],status:'Active',branch:'Gulberg, Lahore',currency:'USD',current:8320,available:8320,sync:'Last synced: 1 day ago',syncTone:'good'},
 {id:'BA-8',bank:'Meezan Bank',mark:'MB',color:'#0f7a52',name:'Meezan Bank — Tax Payments',last4:'6677',tags:['Checking'],status:'Dormant',branch:'Saddar, Karachi',currency:'PKR',current:0,available:0,sync:'No recent activity',syncTone:'muted'},
]

const banks=['HBL','Meezan Bank','UBL','MCB','Allied Bank','Bank Alfalah']
const accountTypes=['Checking','Savings','Payroll','Petty Bank']
const currencies=[['PKR','PKR - Pakistani Rupee'],['USD','USD - US Dollar']]

const tagIcon:Record<string,typeof Wallet>={Checking:Wallet,Savings:PiggyBank,Payroll:Users,'Petty Bank':Coins,'Foreign Currency':Globe2,USD:Globe2,Primary:Star}
const TagIcon=({tag}:{tag:string})=>{const Icon=tagIcon[tag]??CreditCard;return <Icon/>}
const statusIcon:Record<BankAccount['status'],typeof CheckCircle2>={Active:CheckCircle2,'Needs Sync':Clock3,Manual:Settings2,Dormant:CircleSlash2}
const SyncIcon=({tone}:{tone:BankAccount['syncTone']})=>{const Icon=tone==='good'?CheckCircle2:tone==='warn'?Clock3:CircleSlash2;return <Icon/>}

const emptyForm={bank:'',title:'',type:'',number:'',currency:'PKR',opening:'',branch:'',feed:true,primary:false,notes:''}

function NewAccountDrawer({onClose,onSave}:{onClose:()=>void;onSave:(a:BankAccount)=>void}){
 const [f,setF]=useState({...emptyForm})
 const ref=useRef<HTMLDivElement>(null)
 useEffect(()=>{const key=(e:KeyboardEvent)=>e.key==='Escape'&&onClose();document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)},[onClose])
 const submit=(e:FormEvent)=>{
  e.preventDefault()
  if(!f.bank||!f.title)return
  const mark=f.bank.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase()
  onSave({id:`BA-${Date.now()}`,bank:f.bank,mark,color:'#0c8a4a',name:f.title,last4:f.number.slice(-4)||'0000',tags:[f.type||'Checking'],status:'Active',branch:f.branch||'—',currency:f.currency,current:Number(f.opening)||0,available:Number(f.opening)||0,sync:'Just added',syncTone:'good',primary:f.primary})
  onClose()
 }
 return <div className="overlay" role="presentation" onMouseDown={e=>e.target===e.currentTarget&&onClose()}>
  <aside ref={ref} role="dialog" aria-modal="true" className="ba-drawer">
   <div className="ba-drawer-head"><div><h2>Create New Bank Account</h2><p>Add a new bank account to your business.</p></div><button className="icon-btn" aria-label="Close" onClick={onClose}><X/></button></div>
   <form onSubmit={submit} className="ba-drawer-form">
    <label>Bank Name<div><Building2/><select value={f.bank} onChange={e=>setF({...f,bank:e.target.value})}><option value="">Select a bank</option>{banks.map(b=><option key={b}>{b}</option>)}</select></div></label>
    <label>Account Title<div><CreditCard/><input placeholder="e.g. Business Checking" value={f.title} onChange={e=>setF({...f,title:e.target.value})}/></div></label>
    <label>Account Type<div><Wallet/><select value={f.type} onChange={e=>setF({...f,type:e.target.value})}><option value="">Select account type</option>{accountTypes.map(t=><option key={t}>{t}</option>)}</select></div></label>
    <label>Account Number / IBAN<div><Landmark/><input placeholder="e.g. 1234 5678 9012 3456 or PK36MEZN0001..." value={f.number} onChange={e=>setF({...f,number:e.target.value})}/></div></label>
    <label>Currency<div><Globe2/><select value={f.currency} onChange={e=>setF({...f,currency:e.target.value})}>{currencies.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div></label>
    <label>Opening Balance <small>(Optional)</small><div><Coins/><input placeholder="0.00" type="number" value={f.opening} onChange={e=>setF({...f,opening:e.target.value})}/><span>{f.currency}</span></div></label>
    <label>Branch Name <small>(Optional)</small><div><Building2/><input placeholder="e.g. Gulberg, Lahore" value={f.branch} onChange={e=>setF({...f,branch:e.target.value})}/></div></label>
    <label className="ba-toggle-row"><span><b>Connect bank feed</b><small>Automatically sync balances and import statement feeds from your bank.</small></span><button type="button" aria-pressed={f.feed} className={`ba-switch ${f.feed?'on':''}`} onClick={()=>setF({...f,feed:!f.feed})}><i/></button></label>
    <label className="ba-check-row"><input type="checkbox" checked={f.primary} onChange={e=>setF({...f,primary:e.target.checked})}/><span><b>Set as primary account</b><small>Use this account as your default for payouts.</small></span></label>
    <label>Notes <small>(Optional)</small><div><textarea placeholder="Add any additional notes..." value={f.notes} onChange={e=>setF({...f,notes:e.target.value})}/></div></label>
    <div className="ba-drawer-foot"><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn primary">Create Account</button></div>
   </form>
  </aside>
 </div>
}

export function BankAccounts({data}:{data:AppData}){
 const [accounts,setAccounts]=useState<BankAccount[]>(seedAccounts)
 const [search,setSearch]=useState('')
 const [bankFilter,setBankFilter]=useState('All Banks')
 const [typeFilter,setTypeFilter]=useState('All Account Types')
 const [statusFilter,setStatusFilter]=useState('All Statuses')
 const [scope,setScope]=useState<'All'|'Connected'|'Manual'>('All')
 const [open,setOpen]=useState(false)
 void data

 const filtered=accounts.filter(a=>
  (bankFilter==='All Banks'||a.bank===bankFilter)&&
  (typeFilter==='All Account Types'||a.tags.includes(typeFilter))&&
  (statusFilter==='All Statuses'||a.status===statusFilter)&&
  (scope==='All'||(scope==='Manual'?a.status==='Manual':a.status!=='Manual'))&&
  `${a.name} ${a.bank} ${a.branch}`.toLowerCase().includes(search.toLowerCase())
 )
 const connected=accounts.filter(a=>a.status!=='Manual').length
 const attention=accounts.filter(a=>a.status==='Needs Sync'||a.status==='Dormant').length
 const combinedPkr=accounts.filter(a=>a.currency==='PKR').reduce((s,a)=>s+a.current,0)

 const statusTone=(s:BankAccount['status'])=>s==='Active'?'good':s==='Needs Sync'?'warn':s==='Dormant'?'neutral':'info'

 return <>
  <div className="ba-head"><span className="ba-head-icon"><Building2/></span><div><h1>Bank Accounts</h1><p>Manage connected and manual bank accounts across your business.</p></div></div>

  <div className="ba-kpis">
   <article><span><Landmark/></span><div><small>Total Bank Accounts</small><b>{accounts.length}</b><em>Across all currencies</em></div></article>
   <article><span className="tone-green"><Link2/></span><div><small>Connected Accounts</small><b>{connected}</b><em>Auto-syncing with banks</em></div></article>
   <article><span className="tone-green"><Coins/></span><div><small>Total Combined Balance</small><b>{money(combinedPkr)}</b><em>Across all bank accounts</em></div></article>
   <article><span className="tone-red"><AlertTriangle/></span><div><small>Accounts Needing Attention</small><b>{attention}</b><em>1 needs sync · 1 dormant</em></div></article>
  </div>

  <div className="ba-toolbar">
   <label className="ba-search"><Search/><input placeholder="Search bank accounts..." value={search} onChange={e=>setSearch(e.target.value)}/></label>
   <div className="ba-selects">
    <label><select value={bankFilter} onChange={e=>setBankFilter(e.target.value)}><option>All Banks</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown/></label>
    <label><select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option>All Account Types</option>{accountTypes.map(t=><option key={t}>{t}</option>)}</select><ChevronDown/></label>
    <label><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option>All Statuses</option><option>Active</option><option>Needs Sync</option><option>Manual</option><option>Dormant</option></select><ChevronDown/></label>
   </div>
   <div className="ba-scope">{(['All','Connected','Manual'] as const).map(s=><button key={s} className={scope===s?'active':''} onClick={()=>setScope(s)}>{s}</button>)}</div>
   <button className="btn secondary"><Download/> Import Accounts</button>
   <button className="btn primary" onClick={()=>setOpen(true)}><Plus/> New Bank Account</button>
  </div>

  <div className="ba-grid">
   {filtered.map(a=>{const StatusIcon=statusIcon[a.status];return <article className="ba-card" key={a.id}>
    <div className="ba-card-top"><span className="ba-mark" style={{background:a.color}}><Landmark/></span><div className="ba-card-title"><b>{a.name}</b><small>{a.bank} · •••• {a.last4}</small></div><Badge tone={statusTone(a.status)}><StatusIcon/> {a.status}</Badge><button className="icon-btn" aria-label="More options"><MoreVertical/></button></div>
    <div className="ba-tags">{a.tags.map(t=><span key={t} className="ba-tag"><TagIcon tag={t}/>{t}</span>)}</div>
    <div className="ba-branch"><Building2/>Branch: {a.branch}</div>
    <div className="ba-balances"><div><b>{a.currency==='USD'?'USD':'PKR'} {a.current.toLocaleString()}</b><small>Current Balance</small></div><div><b>{a.currency==='USD'?'USD':'PKR'} {a.available.toLocaleString()}</b><small>Available Balance</small></div></div>
    <div className={`ba-sync tone-${a.syncTone}`}><SyncIcon tone={a.syncTone}/>{a.sync}</div>
    <div className="ba-actions"><button><Eye/> View</button><button><Edit3/> Edit</button><button>{a.status==='Needs Sync'?<><RefreshCw/> Sync Now</>:<><ArrowLeftRight/> Transactions</>}</button><button className="ba-more"><MoreHorizontal/> More</button></div>
   </article>})}
   <button className="ba-add-card" onClick={()=>setOpen(true)} type="button"><span><Plus/></span><b>Add Another Bank Account</b><small>Connect your bank or add a manual account</small><span className="ba-add-btn"><Plus/> New Bank Account</span></button>
  </div>

  <div className="ba-tip"><span><Banknote/></span><div><b>Connect your banks for automatic sync</b><p>Connected accounts automatically sync balances and import statement feeds, saving you time and keeping your records up to date.</p></div><a href="#" onClick={e=>e.preventDefault()}>Learn More ↗</a></div>

  {open&&<NewAccountDrawer onClose={()=>setOpen(false)} onSave={a=>setAccounts(list=>[...list,a])}/>}
 </>
}
