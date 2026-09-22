'use client'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowDownUp, ArrowUp, Banknote, CalendarDays, ChartColumn, ChevronDown, ChevronLeft, ChevronRight, FileText, Filter, Info, Landmark, LayoutGrid, Minus, MoreVertical, Paperclip, Plus, Printer, Save, Search, Settings, Tag, Upload, User, Wallet } from 'lucide-react'
import type { AppData } from '@/mocks/api'

const cur='₹'
const fmt=(n:number)=>`${cur} ${n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`

type Kind='Payment'|'Receipt'
type Tx={ id:number; no:string; type:Kind; date:string; account:string; party:string; amount:number; status:'Posted'|'Draft'; remarks:string }

const seed:Tx[]=[
 {id:1,no:'RV-2024-00018',type:'Receipt',date:'26 Apr 2024',account:'Cash in Hand',party:'Acme Corporation',amount:5000,status:'Posted',remarks:'Sales collection'},
 {id:2,no:'PV-2024-00026',type:'Payment',date:'26 Apr 2024',account:'Cash in Hand',party:'Office Supplies Mart',amount:2500,status:'Posted',remarks:'Stationery purchase'},
 {id:3,no:'RV-2024-00017',type:'Receipt',date:'25 Apr 2024',account:'Cash in Hand',party:'Rakesh Traders',amount:7500,status:'Posted',remarks:'Payment against invoice #RT-100'},
 {id:4,no:'PV-2024-00025',type:'Payment',date:'25 Apr 2024',account:'Cash in Hand',party:'Electricity Board',amount:6250,status:'Posted',remarks:'Electricity bill payment'},
 {id:5,no:'RV-2024-00016',type:'Receipt',date:'24 Apr 2024',account:'Cash in Hand',party:'Walk-in Customer',amount:3000,status:'Posted',remarks:'Misc. income'},
]

const heads=['Sales Revenue','Office Expenses','Utilities','Rent','Salaries','Other Income']
const emptyForm={date:'2024-04-26',account:'Cash in Hand',party:'',amount:'',reference:'',head:'',remarks:''}

function Field({label,required,icon,children,trail}:{label:string;required?:boolean;icon:ReactNode;children:ReactNode;trail?:ReactNode}){
 return <label className="ct-f"><span className="ct-l">{label}{required&&<em>*</em>}</span><span className="ct-in"><i>{icon}</i>{children}{trail&&<b className="ct-trail">{trail}</b>}</span></label>
}
function Seg<T extends string>({value,options,onChange,tone}:{value:T;options:readonly T[];onChange:(v:T)=>void;tone?:'green'}){
 return <div className={`ct-seg ${tone??''}`}>{options.map(o=><button type="button" key={o} className={o===value?'on':''} onClick={()=>onChange(o)}>{o}</button>)}</div>
}

export function CashTransactions({data}:{data:AppData}){
 const [kind,setKind]=useState<Kind>('Payment')
 const [tab,setTab]=useState<'Reports'|'Transaction History'>('Reports')
 const [txType,setTxType]=useState<'Payments'|'Receipts'|'All Transactions'>('Payments')
 const [dateMode,setDateMode]=useState<'One (Date Wise)'|'All (Date Wise)'>('One (Date Wise)')
 const [numMode,setNumMode]=useState<'One (Number Wise)'|'All (Number Wise)'>('One (Number Wise)')
 const [fromNo,setFromNo]=useState('PV-2024-00001'),[toNo,setToNo]=useState('PV-2024-00050')
 const [rows,setRows]=useState<Tx[]>(seed)
 const [q,setQ]=useState('')
 const [form,setForm]=useState(emptyForm)
 const set=(p:Partial<typeof form>)=>setForm(f=>({...f,...p}))
 const out=kind==='Payment'
 const seqNo=useMemo(()=>{const pre=out?'PV':'RV';const n=rows.filter(r=>r.type===kind).length+(out?24:15)+1;return `${pre}-2024-${String(n).padStart(5,'0')}`},[rows,kind,out])
 const parties=useMemo(()=>data.masters.filter(m=>m.type===(out?'Supplier':'Customer')).map(m=>m.name),[data,out])

 const receipts=rows.filter(r=>r.type==='Receipt'&&r.date==='26 Apr 2024'), payments=rows.filter(r=>r.type==='Payment'&&r.date==='26 Apr 2024')
 const sum=(l:Tx[])=>l.reduce((a,r)=>a+r.amount,0)
 const opening=125000, closing=opening+sum(receipts)-sum(payments)

 const save=(e:FormEvent)=>{e.preventDefault();const amt=Number(form.amount);if(!form.party||!amt||!form.head)return
  const [y,m,d]=form.date.split('-');const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  setRows(l=>[{id:l.length+1,no:seqNo,type:kind,date:`${d} ${months[Number(m)-1]} ${y}`,account:form.account,party:form.party,amount:amt,status:'Posted',remarks:form.remarks||'—'},...l]);setForm(emptyForm)}

 const shown=rows.filter(r=>!q||[r.no,r.party,r.remarks,r.account].some(s=>s.toLowerCase().includes(q.toLowerCase())))

 return <div className="ct-page">
  <header className="ct-head">
   <span className="ct-head-icon"><Banknote/></span>
   <div><h1>Cash Transactions</h1><p>Create cash receipts and payments, monitor activity, and access transaction records.</p></div>
   <div className="ct-head-actions">
    <button className="ct-btn primary" onClick={()=>setKind('Payment')}><Minus/> New Payment</button>
    <button className="ct-btn outline" onClick={()=>setKind('Receipt')}><Plus/> New Receipt</button>
    <span className="ct-split"><button className="ct-btn ghost" onClick={()=>window.print()}><Printer/> Print</button><button className="ct-btn ghost caret" aria-label="Print options"><ChevronDown/></button></span>
   </div>
  </header>

  <section className="ct-kpis">
   <article><span className="ico blue"><Landmark/></span><div><small>Opening Balance</small><b>{fmt(opening)}</b><em>As on 01 Apr 2024</em></div></article>
   <article><span className="ico green"><ArrowDown/></span><div><small>Total Receipts Today</small><b>{fmt(sum(receipts))}</b><em>{receipts.length} transactions</em></div><i className="ct-bars green"><u style={{height:'40%'}}/><u style={{height:'60%'}}/><u style={{height:'50%'}}/><u style={{height:'80%'}}/><u style={{height:'100%'}}/></i></article>
   <article><span className="ico red"><ArrowUp/></span><div><small>Total Payments Today</small><b>{fmt(sum(payments))}</b><em>{payments.length} transactions</em></div><i className="ct-bars red"><u style={{height:'30%'}}/><u style={{height:'55%'}}/><u style={{height:'40%'}}/><u style={{height:'75%'}}/><u style={{height:'100%'}}/></i></article>
   <article><span className="ico mint"><Wallet/></span><div><small>Closing Balance</small><b>{fmt(closing)}</b><em>As on 26 Apr 2024</em></div></article>
  </section>

  <section className="ct-mid">
   <form className="ct-card ct-create" onSubmit={save}>
    <div className="ct-card-head">
     <span className="ct-title-icon"><FileText/></span><h2>Create Transaction</h2>
     <div className="ct-kind">
      <button type="button" className={out?'on':''} onClick={()=>setKind('Payment')}><ArrowUp/> Payment Voucher</button>
      <button type="button" className={!out?'on':''} onClick={()=>setKind('Receipt')}><ArrowDown/> Receipt Voucher</button>
     </div>
     <span className={`ct-flow ${out?'out':'in'}`}>{out?<ArrowUp/>:<ArrowDown/>} {out?'Cash Outflow':'Cash Inflow'}</span>
    </div>
    <div className="ct-grid">
     <Field label="Voucher No." required icon={null} trail={<Settings/>}><input value={seqNo} readOnly className="noicon"/></Field>
     <Field label="Date" required icon={<CalendarDays/>} trail={<CalendarDays/>}><input type="date" value={form.date} onChange={e=>set({date:e.target.value})}/></Field>
     <Field label="Account (Cash Account)" required icon={<Landmark/>} trail={<ChevronDown/>}><select value={form.account} onChange={e=>set({account:e.target.value})}>{['Cash in Hand','Petty Cash','Main Cash Drawer'].map(a=><option key={a}>{a}</option>)}</select></Field>
     <Field label="Amount" required icon={<b className="ct-rs">{cur}</b>}><input type="number" min="0" step="0.01" value={form.amount} onChange={e=>set({amount:e.target.value})} placeholder="0.00"/></Field>
     <Field label={out?'Paid To':'Received From'} required icon={<User/>} trail={<ChevronDown/>}><input list="ct-parties" value={form.party} onChange={e=>set({party:e.target.value})} placeholder="Select or enter payee"/><datalist id="ct-parties">{parties.map(p=><option key={p} value={p}/>)}</datalist></Field>
     <Field label="Reference No." icon={<Tag/>}><input value={form.reference} onChange={e=>set({reference:e.target.value})} placeholder="Enter reference no."/></Field>
     <Field label="Category / Head" required icon={<LayoutGrid/>} trail={<ChevronDown/>}><select value={form.head} onChange={e=>set({head:e.target.value})}><option value="">Select account head</option>{heads.map(h=><option key={h}>{h}</option>)}</select></Field>
     <Field label="Remarks / Notes" icon={<FileText/>}><input value={form.remarks} onChange={e=>set({remarks:e.target.value})} placeholder="Enter remarks (optional)"/></Field>
    </div>
    <div className="ct-form-foot">
     <label className="ct-btn outline attach"><Paperclip/> Attach File<input type="file" hidden/></label><small>Max file size 5 MB (PDF, JPG, PNG)</small>
     <button type="button" className="ct-btn ghost" onClick={()=>setForm(emptyForm)}>Clear</button>
     <button type="submit" className="ct-btn primary"><Save/> Save {kind}</button>
    </div>
   </form>

   <aside className="ct-card ct-reports">
    <div className="ct-card-head">
     <span className="ct-title-icon"><ChartColumn/></span><div><h2>Reports &amp; Filters</h2><p>View and print payment &amp; receipt reports</p></div>
     <Seg value={tab} options={['Reports','Transaction History'] as const} onChange={setTab} tone="green"/>
    </div>
    <div className="ct-filter">
     <span className="ct-step">1</span><b>Transaction Type</b>
     <Seg value={txType} options={['Payments','Receipts','All Transactions'] as const} onChange={setTxType} tone="green"/>
    </div>
    <div className="ct-filter box">
     <div className="ct-filter-row"><span className="ct-step ico"><CalendarDays/></span><b>Date Filter</b><Seg value={dateMode} options={['One (Date Wise)','All (Date Wise)'] as const} onChange={setDateMode} tone="green"/></div>
     <div className="ct-filter-row"><b className="plain">Date Range</b><span className="ct-range"><i><CalendarDays/></i><span>26 Apr 2024</span><em>–</em><span>26 Apr 2024</span><ChevronDown className="ct-trail"/></span></div>
    </div>
    <div className="ct-filter box">
     <div className="ct-filter-row"><span className="ct-step">3</span><b>Number Filter</b><Seg value={numMode} options={['One (Number Wise)','All (Number Wise)'] as const} onChange={setNumMode} tone="green"/></div>
     <div className="ct-vrange">
      <div className="ct-vrange-head"><b>Voucher Number Range</b><Info/><small>Filter by voucher number range (can be combined with date range)</small></div>
      <div className="ct-vrange-grid">
       <label><span>From No.</span><span className="ct-in"><i><FileText/></i><input value={fromNo} onChange={e=>setFromNo(e.target.value)}/></span></label>
       <label><span>To No.</span><span className="ct-in"><i><FileText/></i><input value={toNo} onChange={e=>setToNo(e.target.value)}/></span></label>
      </div>
     </div>
    </div>
    <div className="ct-report-actions">
     <button type="button" className="ct-btn primary big"><ChartColumn/> Generate Report</button>
     <button type="button" className="ct-btn ghost big"><Upload/> Export <ChevronDown className="ct-caret"/></button>
    </div>
   </aside>
  </section>

  <section className="ct-card ct-recent">
   <div className="ct-card-head">
    <span className="ct-title-icon"><FileText/></span><div><h2>Recent Cash Transactions</h2><p>Latest payment and receipt vouchers</p></div>
    <label className="ct-search"><Search/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search transactions..."/></label>
    <button type="button" className="ct-btn ghost"><Filter/> Filter</button>
    <button type="button" className="ct-btn ghost"><ArrowDownUp/> Sort: Date (Newest) <ChevronDown className="ct-caret"/></button>
   </div>
   <div className="ct-table-wrap"><table className="ct-table">
    <thead><tr><th>#</th><th>Voucher No.</th><th>Type</th><th>Date <ArrowDownUp className="ct-sort"/></th><th>Account Name</th><th>Counterparty</th><th className="r">Amount</th><th>Status</th><th>Remarks</th><th className="r"><MoreVertical/></th></tr></thead>
    <tbody>{shown.map((r,i)=><tr key={r.no+i}>
     <td>{i+1}</td><td className="mono">{r.no}</td>
     <td><span className={`ct-type ${r.type==='Receipt'?'in':'out'}`}>{r.type==='Receipt'?<ArrowDown/>:<ArrowUp/>} {r.type}</span></td>
     <td>{r.date}</td><td>{r.account}</td><td>{r.party}</td>
     <td className={`r amt ${r.type==='Receipt'?'in':'out'}`}>{fmt(r.amount)}</td>
     <td><span className="ct-status"><u/>{r.status}</span></td>
     <td>{r.remarks}</td>
     <td className="r"><button type="button" className="ct-more" aria-label="Row actions"><MoreVertical/></button></td>
    </tr>)}</tbody>
   </table></div>
   <div className="ct-foot"><span>Showing 1 to {shown.length} of {shown.length} transactions</span><div className="ct-pager"><button type="button" aria-label="Previous"><ChevronLeft/></button><button type="button" className="on">1</button><button type="button" aria-label="Next"><ChevronRight/></button></div></div>
  </section>
 </div>
}
