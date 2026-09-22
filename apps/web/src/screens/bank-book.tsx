'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { AlertCircle, ArrowDown, ArrowUp, Banknote, BookOpen, CalendarDays, ChevronDown, ChevronRight, CreditCard, Database, Download, Ellipsis, FileText, Info, Landmark, Leaf, Lightbulb, Receipt, RefreshCw, Search, Send, Wallet, type LucideIcon } from 'lucide-react'

type Kind='opening'|'cheque'|'deposit'|'transfer'|'receipt'|'atm'|'loan'|'charges'
type Tx={id:number;date:string;kind:Kind;title:string;sub:string;out:number;in:number;status?:'Uncleared'|'Pending';matched:boolean}
const accounts=[{name:'HBL - Main Account',ccy:'PKR',no:'1234 5678 9012',opening:1250000},{name:'MCB - Operations',ccy:'PKR',no:'0098 7654 3210',opening:412500},{name:'UBL - USD Account',ccy:'USD',no:'5566 7788 9900',opening:18200}]
const seed:Tx[]=[
 {id:1,date:'2026-09-01',kind:'opening',title:'Opening Balance',sub:'Balance brought forward',out:0,in:0,matched:true},
 {id:2,date:'2026-09-01',kind:'cheque',title:'Cheque Issued',sub:'Chq # 001234 - ABC Suppliers',out:45000,in:0,matched:true},
 {id:3,date:'2026-09-02',kind:'deposit',title:'Cash Deposit',sub:'Branch Deposit',out:0,in:200000,matched:true},
 {id:4,date:'2026-09-05',kind:'transfer',title:'Online Transfer',sub:'Utility Bills - KE',out:12500,in:0,matched:true},
 {id:5,date:'2026-09-05',kind:'receipt',title:'Customer Payment',sub:'Al-Fatah Traders',out:0,in:350000,matched:true},
 {id:6,date:'2026-09-08',kind:'atm',title:'ATM Withdrawal',sub:'Cash Withdrawal',out:20000,in:0,matched:false},
 {id:7,date:'2026-09-10',kind:'cheque',title:'Cheque Issued',sub:'Chq # 001235 - Office Rent',out:150000,in:0,status:'Uncleared',matched:false},
 {id:8,date:'2026-09-15',kind:'loan',title:'Loan Received',sub:'Short Term Loan',out:0,in:300000,matched:true},
 {id:9,date:'2026-09-18',kind:'charges',title:'Bank Charges',sub:'Monthly Charges',out:2350,in:0,matched:true},
 {id:10,date:'2026-09-20',kind:'transfer',title:'Online Transfer',sub:'Vendor Payment - Tech Solutions',out:280000,in:0,status:'Pending',matched:false},
]
const icons:Record<Kind,[LucideIcon,string]>={opening:[Database,'grey'],cheque:[CreditCard,'red'],deposit:[ArrowDown,'green'],transfer:[Send,'red'],receipt:[Wallet,'green'],atm:[Banknote,'red'],loan:[Wallet,'green'],charges:[Landmark,'red']}
const rs=(v:number)=>`Rs ${v.toLocaleString('en-PK')}`
const d=(iso:string)=>new Date(`${iso}T12:00:00`)
const weekday=(iso:string)=>d(iso).toLocaleDateString('en-GB',{weekday:'long'})

export function BankBook(){
 const navigate=useNavigate()
 const [acct,setAcct]=useState(0),[q,setQ]=useState(''),[menu,setMenu]=useState<number|null>(null),[txs,setTxs]=useState(seed),[toast,setToast]=useState('')
 const a=accounts[acct]
 const rows=useMemo(()=>{const out:(Tx&{bal:number})[]=[];for(const t of txs){const prev=out.length?out[out.length-1].bal:a.opening;out.push({...t,bal:t.kind==='opening'?a.opening:prev-t.out+t.in})}return out},[txs,a])
 const shown=useMemo(()=>{const qq=q.trim().toLowerCase();return rows.filter(r=>!qq||r.title.toLowerCase().includes(qq)||r.sub.toLowerCase().includes(qq)||r.kind.includes(qq))},[rows,q])
 const groups=useMemo(()=>{const m=new Map<string,typeof shown>();for(const r of shown){const g=m.get(r.date)??[];g.push(r);m.set(r.date,g)}return [...m.entries()]},[shown])
 const totals=useMemo(()=>({out:rows.reduce((s,r)=>s+r.out,0),outN:rows.filter(r=>r.out&&r.kind!=='charges').length,inn:rows.reduce((s,r)=>s+r.in,0),inN:rows.filter(r=>r.in).length,closing:rows.at(-1)?.bal??a.opening}),[rows,a])
 const matched=txs.filter(t=>t.matched).length,pendingCheques=txs.filter(t=>!t.matched&&(t.kind==='cheque'||t.kind==='transfer')).length,unresolved=txs.filter(t=>!t.matched&&t.kind!=='cheque'&&t.kind!=='transfer').length
 const pct=Math.round(matched/txs.length*100),statement=totals.closing+9850
 const ring=2*Math.PI*30
 const mark=(id:number)=>{setTxs(p=>p.map(t=>t.id===id?{...t,matched:true,status:undefined}:t));setMenu(null);setToast('Entry marked as cleared')}
 const reconcile=()=>{setTxs(p=>p.map(t=>({...t,matched:true,status:undefined})));setToast('All entries reconciled with the August statement')}
 return <div className="bb-page" onClick={()=>menu!==null&&setMenu(null)}>
  <div className="bb-head"><span className="bb-logo"><BookOpen/></span><div><h1>Bank Book</h1><p>Track and review your bank transactions with running balance</p></div><div className="bb-quote"><Leaf/><em>“Clear books. Confident business.”</em></div></div>
  {toast&&<div className="bb-toast" role="status"><RefreshCw/>{toast}</div>}
  <div className="bb-grid">
   <section className="bb-main">
    <div className="bb-tools"><label className="bb-acct"><span>Bank Account</span><span className="bb-acct-box"><Landmark/><select aria-label="Bank account" value={acct} onChange={e=>setAcct(Number(e.target.value))}>{accounts.map((x,i)=><option key={x.name} value={i}>{x.name}</option>)}</select><small>{a.ccy} • {a.no}</small><ChevronDown/></span></label>
     <div className="bb-search-wrap"><label className="bb-search"><Search/><input aria-label="Search transactions" placeholder="Search transactions by description, cheque no, reference..." value={q} onChange={e=>setQ(e.target.value)}/></label><small>Try: cheque, deposit, transfer, supplier, rent...</small></div>
     <button type="button" className="bb-range"><CalendarDays/><span>01 Sep 2026 - 21 Sep 2026</span><ChevronDown/></button></div>
    <div className="bb-kpis">
     <div><span className="green"><Wallet/></span><div><small>Opening Balance</small><b>{rs(a.opening)}</b><em>1 Sep 2026</em></div></div>
     <div><span className="red"><ArrowDown/></span><div><small>Total Withdrawals</small><b className="red">{rs(totals.out)}</b><em>{totals.outN} transactions</em></div></div>
     <div><span className="green"><ArrowUp/></span><div><small>Total Deposits</small><b className="green">{rs(totals.inn)}</b><em>{totals.inN} transactions</em></div></div>
     <div><span className="green"><Database/></span><div><small>Closing Balance</small><b>{rs(totals.closing)}</b><em>21 Sep 2026</em></div></div></div>
    <div className="bb-ledger">{groups.map(([date,list],gi)=><div className="bb-day" key={date}>
     <div className="bb-daycol"><div className="bb-date"><b>{d(date).getDate().toString().padStart(2,'0')}</b><span>{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d(date).getMonth()]} {d(date).getFullYear()}</span><small>{weekday(date)}</small></div>{gi===0&&<div className="bb-open-chip"><small>Opening Balance</small><b>{rs(a.opening)}</b></div>}<i className="bb-node"/></div>
     <div className="bb-daycard">{list.map((r,ri)=>{const [I,tone]=icons[r.kind];return <div className={`bb-row ${r.kind}`} key={r.id}><span className={`bb-row-icon ${tone}`}><I/></span><div className="bb-row-text"><b>{r.title}</b><small>{r.sub}</small></div>
      <div className="bb-col">{gi===0&&ri===0&&<small>Withdrawals (-)</small>}<b className={r.out?'red':'dash'}>{r.out?rs(r.out):'–'}</b></div><div className="bb-col">{gi===0&&ri===0&&<small>Deposits (+)</small>}<b className={r.in?'green':'dash'}>{r.in?rs(r.in):'–'}</b></div>
      <div className="bb-col bal"><small>Running Balance</small><b>{rs(r.bal)}</b></div>
      <div className="bb-tag-slot">{r.status&&<span className={`bb-tag ${r.status.toLowerCase()}`}>{r.status}</span>}</div>
      <div className="bb-menu-wrap"><button type="button" className="bb-more" aria-label={`Actions for ${r.title} ${r.sub}`} aria-expanded={menu===r.id} onClick={e=>{e.stopPropagation();setMenu(menu===r.id?null:r.id)}}><Ellipsis/></button>{menu===r.id&&<div className="bb-menu" onClick={e=>e.stopPropagation()}><button type="button" onClick={()=>{setMenu(null);navigate('/vouchers')}}>View voucher</button>{!r.matched&&<button type="button" onClick={()=>mark(r.id)}>Mark as cleared</button>}<button type="button" onClick={()=>{setMenu(null);navigate('/cheque-clearing')}}>Open cheque register</button></div>}</div></div>})}</div>
    </div>)}{!groups.length&&<div className="bb-empty">No transactions match “{q}”.</div>}</div>
    <div className="bb-foot"><div className="bb-tip"><Lightbulb/><span><b>Tip:</b> Keep your bank book updated regularly and reconcile with your bank statement monthly.</span></div><button type="button" className="bb-export" onClick={()=>navigate('/reports')}><Download/> Export Bank Book <ChevronDown/></button></div>
   </section>
   <aside className="bb-side">
    <section className="bb-card"><h2>Reconciliation Progress</h2>
     <div className="bb-progress"><div className="bb-ring"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" fill="none" stroke="#DCEFE3" strokeWidth="7"/><circle cx="36" cy="36" r="30" fill="none" stroke="#12A64C" strokeWidth="7" strokeLinecap="round" strokeDasharray={ring} strokeDashoffset={ring*(1-pct/100)} transform="rotate(-90 36 36)"/></svg><b>{pct}%</b></div><div className="bb-progress-text"><span>{matched} of {txs.length} transactions matched</span><i><i style={{width:`${pct}%`}}/></i></div></div>
     <div className="bb-issues"><button type="button" onClick={()=>navigate('/cheque-clearing')}><span className="red"><CreditCard/></span><div><b>{pendingCheques}</b><small>Pending Cheques</small></div><ChevronRight/></button><button type="button" onClick={()=>navigate('/cheque-actions')}><span className="amber"><AlertCircle/></span><div><b>{unresolved}</b><small>Unresolved Entries</small></div><ChevronRight/></button></div>
     <button type="button" className="bb-reconcile" onClick={reconcile} disabled={pct===100}><RefreshCw/> {pct===100?'Fully Reconciled':'Reconcile with Statement'}</button>
     <div className="bb-stmt-foot"><span>Last statement: Aug 2026</span><button type="button" className="bb-link" onClick={()=>navigate('/reports')}>View Statement</button></div></section>
    <section className="bb-card"><h2><span className="bb-h2-icon"><FileText/></span>Recent Statement Activity</h2>
     <ul className="bb-stmt"><li><span><Database/></span><div><small>Statement Balance</small><b>{rs(statement)}</b><em>as of 21 Sep 2026</em></div></li><li><span><Receipt/></span><div><small>Book Balance</small><b>{rs(totals.closing)}</b><em>as of 21 Sep 2026</em></div></li></ul>
     <div className="bb-diff"><Info/><div><small>Difference</small><b>{rs(statement-totals.closing)}</b></div></div>
     <div className="bb-note"><Lightbulb/><span>You have {pendingCheques} pending cheque{pendingCheques===1?'':'s'} and {unresolved} unresolved entr{unresolved===1?'y':'ies'} causing the difference.</span></div></section>
   </aside>
  </div>
 </div>
}
