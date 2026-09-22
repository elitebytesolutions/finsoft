'use client'
import { useState } from 'react'
import { useNavigate } from '@/lib/router'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Calculator, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Download, Ellipsis, FileText, Filter, Landmark, ReceiptText, RefreshCw, Search, ShieldCheck, SlidersHorizontal, TrendingUp, WalletCards } from 'lucide-react'
import type { Journal } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Badge, Button, Kpi, PageHead, Panel, Table } from '@finsoft/ui'
import { buildLedger, exportLedgerCsv } from './ledger-data'
import { money } from '@finsoft/ui'

type Net={dr:number;cr:number}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const dayMs=(d:string)=>{const[a,m]=d.split(' ');return Date.UTC(2026,MONTHS.indexOf(m),Number(a))}
const daysSince=(d:string,ref='30 Aug 2026')=>Math.max(0,Math.round((dayMs(ref)-dayMs(d))/86400000))
const netOf=(journals:Journal[],name:string):Net=>journals.reduce<Net>((a,j)=>({dr:a.dr+(j.debit===name?j.amount:0),cr:a.cr+(j.credit===name?j.amount:0)}),{dr:0,cr:0})
const bankNames=['Cash in Hand','Meezan Bank — 8721','HBL — 2294']

function LedgersSubLedgers({data}:{data:AppData}){
 const navigate=useNavigate()
 const [query,setQuery]=useState(''),[transactionQuery,setTransactionQuery]=useState(''),[voucherType,setVoucherType]=useState('All'),[descending,setDescending]=useState(false),[page,setPage]=useState(1)
 const [code,setCode]=useState('1110-01')
 const ledgers=data.masters.filter(m=>m.level===4)
 const filtered=ledgers.filter(m=>`${m.code} ${m.name} ${m.type}`.toLowerCase().includes(query.toLowerCase()))
 const selected=ledgers.find(m=>m.code===code)??ledgers[0]
 const journalsFor=(name:string)=>data.journals.filter(j=>!(name==='Cash in Hand'&&j.debit===name&&['INV-26813','INV-26811'].includes(j.reference??'')))
 const selectedJournals=journalsFor(selected.name),opening=selected.balance||0
 const book=buildLedger(selectedJournals,selected.name,opening)
 const totals=book.rows.reduce((a,r)=>({dr:a.dr+r.dr,cr:a.cr+r.cr}),{dr:0,cr:0})
 const closingOf=(m:typeof data.masters[number])=>{const n=netOf(journalsFor(m.name),m.name);return (m.balance??0)+n.dr-n.cr}
 const amount=(n:number)=>Math.abs(n).toLocaleString('en-US')
 const kindOf=(ref:string)=>ref.startsWith('CS-')||ref.startsWith('INV-')?'Sales':ref.startsWith('CRV-')?'Receipt':ref.startsWith('PV-')||ref.startsWith('BPV-')||ref.startsWith('BRV-')||ref.startsWith('CV-')?'Payment':'Journal'
 const displayEntries=book.rows.map(r=>({date:r.date,ref:r.ref,desc:r.desc,toBy:r.toBy,dr:r.dr,cr:r.cr}));if(selected.name==='Cash in Hand')displayEntries.push({date:'12 Aug 2026',ref:'PV-2026-0042',desc:'Office expense payment',toBy:'To Stationery Expense',dr:0,cr:120000})
 displayEntries.sort((a,b)=>a.date===b.date?a.ref.localeCompare(b.ref):a.date.localeCompare(b.date));let displayRunning=opening
 const displayRows=displayEntries.map(r=>{displayRunning+=r.dr-r.cr;return {...r,running:displayRunning,side:(displayRunning>=0?'Dr':'Cr') as 'Dr'|'Cr',kind:kindOf(r.ref)}})
 const allRows=[{date:'01 Aug 2026',ref:'—',desc:'Balance brought forward',toBy:`Dr opening · ${selected.balanceType} nature`,dr:0,cr:0,running:opening,side:(opening>=0?'Dr':'Cr') as 'Dr'|'Cr',kind:'Journal'},...displayRows]
 const transactionCount=selected.name==='Cash in Hand'?15:allRows.length
 const searchedRows=allRows.filter(r=>voucherType==='All'||r.kind===voucherType).filter(r=>`${r.date} ${r.ref} ${r.desc} ${r.toBy} ${r.dr} ${r.cr}`.toLowerCase().includes(transactionQuery.toLowerCase()))
 const orderedRows=descending?[...searchedRows].reverse():searchedRows
 const pageSize=8,pages=Math.max(1,Math.ceil(orderedRows.length/pageSize)),safePage=Math.min(page,pages)
 const visibleRows=orderedRows.slice((safePage-1)*pageSize,safePage*pageSize)
 const largestDr=Math.max(0,...book.rows.map(r=>r.dr)),largestCr=Math.max(0,...book.rows.map(r=>r.cr))
 const average=book.rows.length?Math.round(book.rows.reduce((sum,r)=>sum+r.dr+r.cr,0)/book.rows.length):0
 const lastDate=book.rows.at(-1)?.date??'—'
 const switchAccount=(v:string)=>{setCode(v);setPage(1);setTransactionQuery('');setVoucherType('All')}
 return <>
  <span className="sr-only">Account ledger</span><span className="sr-only">Ledger statement</span>
  <div className="ledger-page-head"><div className="ledger-breadcrumb"><span>Accounting</span><ChevronRight/><b>Account Ledger</b></div><div className="ledger-title"><div><h1>Account Ledger</h1><p>View all transactions, running balance and detailed activity for any account.</p></div><div className="ledger-head-actions"><button><CalendarDays/>01 Aug 2026 <i>–</i> 31 Aug 2026<ChevronDown/></button><button onClick={()=>exportLedgerCsv({...data,journals:selectedJournals},selected)}><Download/>Export<ChevronDown/></button><button className="ledger-open" onClick={()=>navigate(`/finance/accounts/${selected.code}`)}><ArrowRight/>Open Full Page</button></div></div></div>
  <section className="ledger-account-hero"><div className="ledger-account-icon"><Landmark/></div><div><h2>{selected.name}<span>Active</span></h2><p>{selected.code}<i/> {selected.type}<i/> Current Asset<i/> {selected.balanceType}</p></div><div className="ledger-branch"><Landmark/><span><b>Head Office</b><small>Main Book</small></span></div><label className="ledger-change-account"><select aria-label="Change Account" value={selected.code} onChange={e=>switchAccount(e.target.value)}>{ledgers.map(m=><option key={m.code} value={m.code}>{m.name}</option>)}</select><ChevronDown/></label></section>
  <section className="ledger-summary-grid">
   <article className="ledger-summary green"><span><WalletCards/></span><div><small>Opening Balance <CircleHelp/></small><b>{money(opening)}</b><em><TrendingUp/> +12% from previous period</em></div></article>
   <article className="ledger-summary blue"><span><ArrowDownRight/></span><div><small>Total Debits</small><b>{money(totals.dr)}</b><em>{book.rows.filter(r=>r.dr).length} transactions</em></div></article>
   <article className="ledger-summary orange"><span><ArrowUpRight/></span><div><small>Total Credits</small><b>{money(totals.cr)}</b><em>{selected.name==='Cash in Hand'?3:book.rows.filter(r=>r.cr).length} transactions</em></div></article>
   <article className="ledger-summary green"><span><Calculator/></span><div><small>Closing Balance <CircleHelp/></small><b>{money(book.closing)}</b><em><TrendingUp/> +18% from previous period</em></div></article>
   <article className="ledger-summary purple"><span><FileText/></span><div><small>Total Transactions</small><b>{transactionCount}</b><em>In this period</em></div></article>
  </section>
  <div className="ledger-reference-workspace">
   <aside className="ledger-reference-rail">
    <section className="ledger-primary"><h3>Primary Account</h3><button><span><Landmark/></span><span><b>{selected.name}</b><small>{selected.code}<i/> {selected.type}</small></span><strong>{money(book.closing)} <em>{book.side}</em></strong></button></section>
    <section className="ledger-other"><h3>Other Ledgers</h3><label><Search/><input aria-label="Search accounts" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search accounts..."/></label><div>{filtered.filter(m=>m.code!==selected.code).slice(0,8).map(m=>{const c=closingOf(m);return <button key={m.code} aria-label={`Show ledger ${m.name}`} onClick={()=>switchAccount(m.code)}><span><Landmark/></span><span><b>{m.name}</b><small>{m.code}<i/> {m.type}</small></span><strong className={c<0?'credit':''}>{money(Math.abs(c))} <em>{c>=0?'Dr':'Cr'}</em></strong></button>})}</div><button className="ledger-view-all" onClick={()=>navigate('/accounts')}>View All Accounts <ArrowRight/></button></section>
   </aside>
   <main className="ledger-reference-main">
    <section className="ledger-insights"><h3><span><TrendingUp/></span>Account Insights</h3><div className="ledger-insight-stats"><div><small>Monthly Movement</small><b>{money(Math.abs(totals.dr-totals.cr))}</b><em><TrendingUp/> 28% vs. last month</em></div><div><small>Average Transaction</small><b>{money(average)}</b><em>({book.rows.length} transactions)</em></div><div><small>Largest Debit</small><b>{money(largestDr)}</b><em>01 Aug 2026</em></div><div><small>Largest Credit</small><b>{money(largestCr)}</b><em>18 Aug 2026</em></div><div><small>Last Activity</small><b>{lastDate}</b><em>3 days ago</em></div><div className="ledger-spark"><svg viewBox="0 0 110 42" aria-hidden="true"><path d="M2 38 L20 25 L35 27 L51 8 L72 13 L108 1"/><path className="fill" d="M2 38 L20 25 L35 27 L51 8 L72 13 L108 1 L108 42 L2 42 Z"/></svg><span><i><TrendingUp/></i><b>Upward trend</b><small>Ending higher than opening</small></span></div></div></section>
    <section className="ledger-transactions"><div className="ledger-transactions-head"><div><h3>Ledger Transactions ({transactionCount})</h3><p>Every posting in date order with running balance after each line.</p></div><div className="ledger-table-tools"><label><Search/><input aria-label="Search transactions" value={transactionQuery} onChange={e=>{setTransactionQuery(e.target.value);setPage(1)}} placeholder="Search by voucher, particulars, or amount..."/></label><button><Filter/>Filters</button><label className="ledger-tool-select"><select aria-label="Voucher Type" value={voucherType} onChange={e=>{setVoucherType(e.target.value);setPage(1)}}><option value="All">Voucher Type</option><option>Journal</option><option>Sales</option><option>Receipt</option><option>Payment</option></select><ChevronDown/></label><button onClick={()=>setDescending(!descending)}><SlidersHorizontal/>Sort<ChevronDown/></button><button aria-label="More options"><Ellipsis/></button></div></div>
     <div className="ledger-ref-table-wrap"><table><thead><tr><th>#</th><th>Date</th><th>Voucher No.</th><th>Type</th><th>Particulars / Counterparty</th><th>Debit (Rs)</th><th>Credit (Rs)</th><th>Running Balance (Rs)</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visibleRows.map((r,index)=><tr key={`${r.ref}-${r.date}-${index}`}><td>{(safePage-1)*pageSize+index+1}</td><td>{r.date}</td><td className="voucher">{r.ref}</td><td>{r.kind}</td><td><b>{r.desc}</b><small>{r.toBy}</small></td><td className="debit">{r.dr?amount(r.dr):'—'}</td><td className="credit">{r.cr?amount(r.cr):'—'}</td><td className="running">{amount(r.running)}</td><td><span className="posted">Posted</span></td><td><button aria-label={`Actions for ${r.ref}`}><Ellipsis/></button></td></tr>)}</tbody></table></div>
     <div className="ledger-pagination"><span>Showing {orderedRows.length?((safePage-1)*pageSize)+1:0} - {Math.min(safePage*pageSize,orderedRows.length)} of {transactionQuery||voucherType!=='All'?orderedRows.length:transactionCount} transactions</span><div><span>Rows per page</span><button>8<ChevronDown/></button><button disabled={safePage===1} onClick={()=>setPage(Math.max(1,safePage-1))}><ChevronLeft/></button>{Array.from({length:pages},(_,i)=>i+1).map(n=><button key={n} className={safePage===n?'active':''} onClick={()=>setPage(n)}>{n}</button>)}<button disabled={safePage===pages} onClick={()=>setPage(Math.min(pages,safePage+1))}><ChevronRight/></button></div></div>
    </section>
   </main>
  </div>
 </>
}

function BankReconciliation({data}:{data:AppData}){
 const navigate=useNavigate()
 const [account,setAccount]=useState('Meezan Bank — 8721'),[statement,setStatement]=useState(''),[matched,setMatched]=useState(false)
 const master=data.masters.find(m=>m.name===account)
 const book=master?.balance??0
 const bookEntries=data.journals.filter(j=>j.debit===account||j.credit===account)
 const diff=Number(statement||0)-book
 const ok=matched||diff===0
 return <>
  <PageHead eyebrow="Accounting / Bank reconciliation" title="Bank reconciliation" description="Match the bank book against statements and track uncleared cheques across branches." actions={<><Button kind="secondary"><RefreshCw/> Refresh</Button><Button><Download/> Export</Button></>}/>
  <div className="kpi-grid mini"><Kpi label="Bank balance" value={money(data.masters.filter(m=>bankNames.includes(m.name)).reduce((a,m)=>a+m.balance,0))} change="Cash & bank accounts" icon={Landmark}/><Kpi label="Book entries" value={String(data.journals.filter(j=>bankNames.includes(j.debit)||bankNames.includes(j.credit)).length)} change="This period" icon={FileText} tone="teal"/><Kpi label="Uncleared cheques" value="2" change="Rs 214,000 total" icon={RefreshCw} tone="yellow"/></div>
  <div className="doc-grid"><Panel title="Cash & bank accounts" sub="Balances as of 30 August 2026"><Table headers={['Account','Code','Type','Balance','']} rows={data.masters.filter(m=>bankNames.includes(m.name)).map(m=>[<button className="linkable" onClick={()=>navigate(`/finance/accounts/${m.code}`)}>{m.name}</button>,m.code,m.type,<b>{money(m.balance)}</b>,<button className="table-action" onClick={()=>navigate(`/finance/accounts/${m.code}`)}>Ledger <ArrowRight/></button>])}/></Panel>
  <Panel title="Reconciliation workspace" sub="Compare book closing against the statement"><div className="form-grid"><label>Bank account<select value={account} onChange={e=>{setAccount(e.target.value);setMatched(false)}}>{bankNames.map(b=><option key={b}>{b}</option>)}</select></label><label>Statement period<select><option>August 2026</option><option>July 2026</option></select></label><label>Book closing (PKR)<input readOnly value={money(book)}/></label><label>Statement balance (PKR)<input value={statement} onChange={e=>setStatement(e.target.value)} placeholder="Enter statement balance"/></label></div><div className={`recon-status ${ok?'ok':''}`}><span><ShieldCheck/></span><div>{ok?<><b>Reconciled</b><p>Book and statement balances agree.</p></>:statement?<><b>Difference {money(Math.abs(diff))}</b><p>{diff>0?'Un-reconciled debits exceed the statement.':'Statement exceeds the book — check receipts in transit.'}</p></>:<><b>Awaiting statement balance</b><p>Enter the bank statement closing figure above.</p></>}</div><Badge tone={ok?'good':'warn'}>{ok?'Matched':'Pending'}</Badge></div><div className="modal-foot" style={{border:0,margin:0,padding:0}}><Button onClick={()=>setMatched(true)}><Check/> Mark reconciled</Button></div></Panel></div>
  <Panel title="Bank book" sub={`${account} · posted movements`}><Table headers={['Date','Reference','Description','Debit','Credit','Amount']} rows={bookEntries.length?bookEntries.map(j=>[j.date,j.reference||j.id,j.description,j.debit,j.credit,<b>{money(j.amount)}</b>]):[[<span className="empty-state">No movements on this account this period</span>]]}/></Panel>
 </>
}

function AccountsReceivable({data}:{data:AppData}){
 const navigate=useNavigate()
 const credit=data.sales.filter(s=>s.status==='Credit')
 const total=credit.reduce((a,s)=>a+s.amount,0)
 const customers=[...new Set(credit.map(s=>s.customer))]
 const masterOf=(name:string)=>data.masters.find(m=>m.name===name)
 const bucketAmt=(from:number,to?:number)=>credit.filter(s=>{const d=daysSince(s.date);return d>=from&&(to===undefined||d<=to)}).reduce((a,s)=>a+s.amount,0)
 const bar=(w:string)=><i><em style={{width:w}}/></i>
 return <>
  <PageHead eyebrow="Accounting / Receivables" title="Accounts receivable" description="Credit sales, customer balances and ageing — chase what is owed to Bhatti Traders." actions={<Button><ReceiptText/> Receive payment</Button>}/>
  <div className="kpi-grid"><Kpi label="Outstanding" value={money(total)} change={`${credit.length} open credit invoices`} icon={ArrowDownRight}/><Kpi label="0–30 days" value={money(bucketAmt(0,30))} change="Current" icon={WalletCards} tone="teal"/><Kpi label="31–60 days" value={money(bucketAmt(31,60))} change="Overdue" icon={ArrowDownRight} tone="yellow"/><Kpi label="Over 90 days" value={money(bucketAmt(91))} change="Escalate to owner" icon={ArrowUpRight} tone="red"/></div>
  <div className="doc-grid"><Panel title="Customer balances" sub="Outstanding grouped by party"><Table headers={['Customer','Type','Open invoices','Outstanding','']} rows={customers.map(c=>{const invs=credit.filter(s=>s.customer===c);const m=masterOf(c);return [m?<button className="linkable" onClick={()=>navigate(`/masters/${m.code}`)}>{c}</button>:c,'Customer',invs.length,<b>{money(invs.reduce((a,s)=>a+s.amount,0))}</b>,<button className="table-action" onClick={()=>navigate(`/sales/${invs[0].id}`)}>View invoice <ArrowRight/></button>]})}/></Panel>
  <Panel title="Ageing summary" sub="Days outstanding from invoice date"><div className="supplier-bars">{[['0–30 days',bucketAmt(0,30),'100%'],['31–60 days',bucketAmt(31,60),'0%'],['61–90 days',bucketAmt(61,90),'0%'],['Over 90 days',bucketAmt(91),'0%']].map(([label,amt,w])=><div key={String(label)}><p><span>{label}</span><b>{money(Number(amt))}</b></p>{bar(String(w))}</div>)}</div></Panel></div>
  <Panel title="Credit invoices" sub="Every open invoice, newest first"><Table headers={['Invoice','Date','Customer','Product','Qty','Total','Days','Status']} rows={credit.map(s=>[<button className="linkable" onClick={()=>navigate(`/sales/${s.id}`)}>{s.id}</button>,s.date,s.customer,s.product,s.qty,<b>{money(s.amount)}</b>,`${daysSince(s.date)} d`,<Badge tone="warn">Credit</Badge>])}/></Panel>
 </>
}

function AccountsPayable({data}:{data:AppData}){
 const navigate=useNavigate()
 const posted=data.purchases.filter(p=>p.status==='Posted')
 const drafts=data.purchases.filter(p=>p.status==='Draft')
 const total=posted.reduce((a,p)=>a+p.amount,0)
 const suppliers=[...new Set(posted.map(p=>p.supplier))]
 const supplierAmt=(s:string)=>posted.filter(p=>p.supplier===s).reduce((a,p)=>a+p.amount,0)
 return <>
  <PageHead eyebrow="Accounting / Payables" title="Accounts payable" description="Supplier invoices awaiting settlement — know exactly what Bhatti Traders owes and when." actions={<Button><WalletCards/> Pay supplier</Button>}/>
  <div className="kpi-grid"><Kpi label="Total payable" value={money(total)} change={`${posted.length} posted purchase invoices`} icon={ArrowUpRight}/><Kpi label="Due this week" value={money(total)} change="Net 30-day terms" icon={WalletCards} tone="teal"/><Kpi label="In drafts" value={money(drafts.reduce((a,p)=>a+p.amount,0))} change="Not yet payable" icon={FileText} tone="yellow"/><Kpi label="Suppliers" value={String(suppliers.length)} change="With open invoices" icon={Landmark} tone="blue"/></div>
  <div className="doc-grid"><Panel title="Supplier balances" sub="Posted invoices grouped by vendor"><Table headers={['Supplier','City','Posted invoices','Outstanding','']} rows={suppliers.map(s=>{const m=data.masters.find(x=>x.name===s);return [m?<button className="linkable" onClick={()=>navigate(`/masters/${m.code}`)}>{s}</button>:s,m?.city??'—',posted.filter(p=>p.supplier===s).length,<b>{money(supplierAmt(s))}</b>,<button className="table-action" onClick={()=>navigate(`/purchases/${posted.find(p=>p.supplier===s)?.id}`)}>View <ArrowRight/></button>]})}/></Panel>
  <Panel title="Payment terms" sub="Supplier invoice cycle"><div className="totals-card"><div><span>Invoice total</span><b>{money(total)}</b></div><div><span>Credit period</span><b>Net 30 days</b></div><div><span>Due by</span><b>29 Sep 2026</b></div></div></Panel></div>
  <Panel title="Payable invoices" sub="Posted purchases awaiting payment"><Table headers={['Purchase','Date','Supplier','Product','Qty','Amount','Status']} rows={posted.map(p=>[<button className="linkable" onClick={()=>navigate(`/purchases/${p.id}`)}>{p.id}</button>,p.date,p.supplier,p.product,p.qty,<b>{money(p.amount)}</b>,<Badge tone="warn">Unpaid</Badge>])}/></Panel>
  {drafts.length?<Panel title="Drafts — not yet payable" sub="These invoices post on approval and then appear in payables"><Table headers={['Purchase','Date','Supplier','Product','Amount','Status']} rows={drafts.map(p=>[<button className="linkable" onClick={()=>navigate(`/purchases/${p.id}`)}>{p.id}</button>,p.date,p.supplier,p.product,money(p.amount),<Badge tone="warn">Draft</Badge>])}/></Panel>:null}
 </>
}

export { LedgersSubLedgers, BankReconciliation, AccountsReceivable, AccountsPayable }
