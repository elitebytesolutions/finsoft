'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { ArrowRight, ArrowUpRight, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Columns3, Download, Ellipsis, ExternalLink, FileText, Filter, Landmark, Search, SlidersHorizontal, Star, TrendingUp, X, Coins, Calculator, ArrowUpDown } from 'lucide-react'
import type { Master } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { buildLedger, exportLedgerCsv } from './ledger-data'
import { money } from '@finsoft/ui'

const typeOf=(ref:string,desc:string)=>ref.startsWith('CS')||/sale/i.test(desc)?'Sales':ref.startsWith('CRV')||/receipt/i.test(desc)?'Receipt':ref.startsWith('PV')||/payment|expense/i.test(desc)?'Payment':ref.startsWith('OB')||/opening/i.test(desc)?'Journal':'Journal'
const fmt=(n:number)=>n.toLocaleString('en-PK')

export function AccountLedger({data}:{data:AppData}){
 const navigate=useNavigate()
 const ledgers=useMemo(()=>data.masters.filter(m=>m.level===4),[data.masters])
 const [code,setCode]=useState('1110-01')
 const [query,setQuery]=useState(''),[sideQuery,setSideQuery]=useState('')
 const [vtype,setVtype]=useState('All Types'),[ttype,setTtype]=useState('All'),[amount,setAmount]=useState('Any amount'),[status,setStatus]=useState('Posted')
 const [chips,setChips]=useState<string[]>(['Date: This Month','Status: Posted'])
 const [desc,setDesc]=useState(false),[rowsPer,setRowsPer]=useState(25),[page,setPage]=useState(1)
 const [notice,setNotice]=useState('')
 const [filtersOpen,setFiltersOpen]=useState(false)
 const account=ledgers.find(m=>m.code===code)??ledgers[0]
 const parent=data.masters.find(m=>m.code===account.parent)
 const opening=account.balance||0
 const {rows,closing,count}=useMemo(()=>buildLedger(data.journals,account.name,opening),[data.journals,account.name,opening])
 const debits=rows.reduce((a,r)=>a+r.dr,0),credits=rows.reduce((a,r)=>a+r.cr,0)
 const all=[{n:0,date:rows[0]?.date??'01 Aug 2026',ref:'—',type:'Journal',desc:'Balance brought forward',toBy:`${account.balanceType==='Debit'?'Dr':'Cr'} opening · ${account.balanceType} nature`,reference:'—',dr:0,cr:0,running:opening,bf:true},...rows.map((r,i)=>({n:i+1,date:r.date,ref:r.ref,type:typeOf(r.ref,r.desc),desc:r.desc,toBy:r.toBy,reference:r.ref,dr:r.dr,cr:r.cr,running:r.running,bf:false}))]
 const filtered=all.filter(r=>r.bf||((vtype==='All Types'||r.type===vtype)&&(ttype==='All'||(ttype==='Debit'?r.dr>0:r.cr>0))&&(amount==='Any amount'||(amount==='> 100,000'?Math.max(r.dr,r.cr)>100000:Math.max(r.dr,r.cr)<=100000))&&`${r.ref} ${r.desc} ${r.toBy} ${r.dr} ${r.cr}`.toLowerCase().includes(query.toLowerCase())))
 const ordered=desc?[...filtered].reverse():filtered
 const pages=Math.max(1,Math.ceil(ordered.length/rowsPer)),cur=Math.min(page,pages),pageRows=ordered.slice((cur-1)*rowsPer,cur*rowsPer)
 const pageDr=pageRows.reduce((a,r)=>a+r.dr,0),pageCr=pageRows.reduce((a,r)=>a+r.cr,0)
 const balanceOf=(m:Master)=>{const b=buildLedger(data.journals,m.name,m.balance||0);return b.closing}
 const related=ledgers.filter(m=>`${m.code} ${m.name}`.toLowerCase().includes(sideQuery.toLowerCase())).slice(0,9)
 const clearAll=()=>{setChips([]);setStatus('All');setQuery('')}

 return <div className="al">
  <div className="al-head"><div><div className="al-crumbs"><button onClick={()=>navigate('/accounts')}>Accounting</button><ChevronRight/><span>Ledgers</span></div><h1>Account Ledger</h1><p>Detailed transactions, running balance and insights for any account.</p></div>
   <div className="al-head-actions"><button className="al-btn"><CalendarDays/><b>01 Aug 2026</b><i>–</i><b>31 Aug 2026</b><ChevronDown/></button><button className="al-btn"><Star/> Saved Views <ChevronDown/></button><button className="al-btn" onClick={()=>exportLedgerCsv(data,account)}><Download/> Export <ChevronDown/></button><button className="al-btn primary" onClick={()=>navigate(`/finance/accounts/${account.code}`)}><ExternalLink/> Open Full Page</button></div></div>

  <section className="al-card al-account"><span className="al-account-icon"><Landmark/></span><div className="al-account-text"><div><h2>{account.name}</h2><span className="al-status">{account.status}</span></div><p>{account.code} <i/> {account.type} <i/> {parent?.name??'—'} <i/> {account.balanceType}</p><small>{account.city!=='—'?`Physical cash available at the ${account.city.toLowerCase()} office`:'Ledger account'}</small></div>
   <div className="al-office"><span className="al-office-icon"><Landmark/></span><div><b>Head Office</b><small>Main Book</small></div><label className="al-select"><select aria-label="Select account" value={account.code} onChange={e=>{setCode(e.target.value);setPage(1)}}>{ledgers.map(m=><option key={m.code} value={m.code}>{m.name}</option>)}</select><span>Switch Account</span><ChevronDown/></label></div></section>

  <div className="al-stats">
   <article><span className="al-stat-icon"><Coins/></span><div><small>Opening Balance <CircleHelp/></small><b>{money(opening)}</b><em className="up"><TrendingUp/> +12% from previous period</em></div></article>
   <article><span className="al-stat-icon"><ArrowUpRight/></span><div><small>Total Debits</small><b>{money(debits)}</b><em>{rows.filter(r=>r.dr).length} transactions</em></div></article>
   <article><span className="al-stat-icon orange"><ArrowUpRight/></span><div><small>Total Credits</small><b>{money(credits)}</b><em>{rows.filter(r=>r.cr).length} transactions</em></div></article>
   <article><span className="al-stat-icon"><Calculator/></span><div><small>Closing Balance <CircleHelp/></small><b>{money(Math.abs(closing))}</b><em className="up"><TrendingUp/> +18% from previous period</em></div></article>
   <article><span className="al-stat-icon purple"><FileText/></span><div><small>Total Transactions</small><b>{count}</b><em>In this period</em></div></article>
  </div>

  <div className="al-body">
   <aside className="al-card al-side"><h3>Related Accounts</h3><label className="al-search"><Search/><input aria-label="Search accounts" value={sideQuery} onChange={e=>setSideQuery(e.target.value)} placeholder="Search accounts..."/></label>
    <ul>{related.map(m=>{const bal=balanceOf(m);return <li key={m.code}><button className={m.code===account.code?'active':''} onClick={()=>{setCode(m.code);setPage(1)}}><span className="al-side-icon"><Landmark/></span><div><b>{m.name}</b><small>{m.code} <i/> {m.type}</small></div><strong className={m.balanceType==='Credit'?'red':''}>{money(Math.abs(bal))}</strong></button></li>})}</ul>
    <button className="al-btn wide" onClick={()=>navigate('/accounts')}>View All Accounts <ArrowRight/></button></aside>

   <section className="al-card al-main">
    <div className="al-main-head"><div><h3>Ledger Transactions ({count})</h3><p>Every posting in date order with running balance after each transaction.</p></div>
     <div className="al-main-tools"><label className="al-search wide"><Search/><input aria-label="Search transactions" value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="Search by voucher, particulars, amount, or reference..."/></label><button className={`al-btn ${filtersOpen?"primary":""}`} aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(!filtersOpen)}><Filter/> Filters {chips.length>0&&<span className="al-pill">{chips.length}</span>}</button><button className="al-btn" onClick={()=>setDesc(!desc)} title={desc?"Newest first":"Oldest first"}><ArrowUpDown/> {desc?"Newest":"Oldest"} first</button><button className="al-btn icon" aria-label="Columns"><Columns3/></button></div></div>
    {filtersOpen&&<div className="al-filters">
     <div className="al-filter"><CalendarDays/><div><small>Date</small><b>01 Aug 2026 – 31 Aug 2026</b></div><ChevronDown/></div>
     <label className="al-filter"><div><small>Voucher Type</small><select aria-label="Voucher type" value={vtype} onChange={e=>setVtype(e.target.value)}>{['All Types','Journal','Sales','Receipt','Payment'].map(t=><option key={t}>{t}</option>)}</select></div><ChevronDown/></label>
     <label className="al-filter"><div><small>Transaction Type</small><select aria-label="Transaction type" value={ttype} onChange={e=>setTtype(e.target.value)}>{['All','Debit','Credit'].map(t=><option key={t}>{t}</option>)}</select></div><ChevronDown/></label>
     <label className="al-filter"><div><small>Amount</small><select aria-label="Amount" value={amount} onChange={e=>setAmount(e.target.value)}>{['Any amount','> 100,000','≤ 100,000'].map(t=><option key={t}>{t}</option>)}</select></div><ChevronDown/></label>
     <label className="al-filter grow"><div><small>Reference / Counterparty</small><select aria-label="Reference" defaultValue="All"><option>All</option></select></div><ChevronDown/></label>
     <label className="al-filter"><div><small>Status</small><select aria-label="Status" value={status} onChange={e=>setStatus(e.target.value)}>{['All','Posted','Draft'].map(t=><option key={t}>{t}</option>)}</select></div><ChevronDown/></label>
     <button className="al-btn"><SlidersHorizontal/> More Filters</button>
    </div>}
    {(chips.length>0)&&<div className="al-chips">{chips.map(c=><span key={c}>{c}<button aria-label={`Remove ${c}`} onClick={()=>setChips(chips.filter(x=>x!==c))}><X/></button></span>)}{chips.length>0&&<button className="al-link" onClick={clearAll}>Clear all</button>}<button className="al-link right" onClick={()=>setNotice('View saved.')}><Star/> Save as View</button></div>}
    {notice&&<p className="al-notice" role="status">{notice}</p>}
    <div className="table-wrap al-table"><table><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th><th className="ctr"/></tr></thead><tbody>
     {pageRows.map(r=><tr key={`${r.n}-${r.ref}`} className={r.bf?'bf':''}><td className="date">{r.date}</td><td><span className="al-ref">{r.ref}</span><span className={`al-type ${r.type.toLowerCase()}`}>{r.type}</span></td><td className="part"><b>{r.desc}</b><small>{r.toBy}</small></td><td className="num dr">{r.dr?fmt(r.dr):<i>—</i>}</td><td className="num cr">{r.cr?fmt(r.cr):<i>—</i>}</td><td className="num bal">{fmt(Math.abs(r.running))}<small>{r.running>=0?'Dr':'Cr'}</small></td><td className="ctr"><button className="al-dots" aria-label={`Actions row ${r.n}`} onClick={()=>navigate(`/finance/accounts/${account.code}`)}><Ellipsis/></button></td></tr>)}
     {!pageRows.length&&<tr><td colSpan={7}><div className="empty-state">No transactions match these filters.</div></td></tr>}
    </tbody></table></div>
    <div className="al-foot"><span>Showing {ordered.length?(cur-1)*rowsPer+1:0}–{Math.min(cur*rowsPer,ordered.length)} of {count} transactions</span><span className="al-foot-tot"><small>Page totals</small><b className="dr">{fmt(pageDr)}</b><b className="cr">{fmt(pageCr)}</b><small>Ending balance</small><b>{fmt(Math.abs(pageRows.at(-1)?.running??closing))}</b></span><span className="al-foot-rows">Rows: <label className="al-select sm"><select aria-label="Rows per page" value={rowsPer} onChange={e=>{setRowsPer(+e.target.value);setPage(1)}}>{[10,25,50].map(n=><option key={n}>{n}</option>)}</select><ChevronDown/></label></span>
     <div className="al-pager"><button aria-label="Previous page" disabled={cur===1} onClick={()=>setPage(cur-1)}><ChevronLeft/></button>{Array.from({length:pages},(_,i)=>i+1).slice(0,5).map(n=><button key={n} className={n===cur?'active':''} onClick={()=>setPage(n)}>{n}</button>)}<button aria-label="Next page" disabled={cur===pages} onClick={()=>setPage(cur+1)}><ChevronRight/></button></div></div>
   </section>
  </div>
 </div>
}
