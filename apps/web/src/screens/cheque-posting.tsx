'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpDown, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, CircleCheck, CreditCard, Filter, Info, Landmark, ListChecks, Printer, RefreshCw, RotateCw, Save, Search, UserRound } from 'lucide-react'
import type { AppData } from '@/mocks/api'

type Mode='posted'|'reversal'
type Kind='received'|'issued'
type Entry={ id:string; dueDate:string; bank:string; receivedDate:string; voucherNo:string; party:string; credit:number; debit:number; salesman:string; remarks:string; status:'Posted'|'Unposted' }

const seed:Record<Kind,Entry[]>={
 received:[
  {id:'r1',dueDate:'05/01/2025',bank:'HDFC Bank',receivedDate:'02/01/2025',voucherNo:'RV-000125',party:'ABC Traders',credit:25000,debit:0,salesman:'Ramesh',remarks:'Payment towards invoice #123',status:'Posted'},
  {id:'r2',dueDate:'10/01/2025',bank:'ICICI Bank',receivedDate:'08/01/2025',voucherNo:'RV-000126',party:'Shree Enterprises',credit:50000,debit:0,salesman:'Suresh',remarks:'Advance payment',status:'Posted'},
  {id:'r3',dueDate:'15/01/2025',bank:'State Bank of India',receivedDate:'12/01/2025',voucherNo:'RV-000127',party:'Global Solutions',credit:0,debit:0,salesman:'Amit',remarks:'Cheque returned',status:'Posted'},
  {id:'r4',dueDate:'20/01/2025',bank:'Axis Bank',receivedDate:'18/01/2025',voucherNo:'RV-000128',party:'Kumar & Co.',credit:75000,debit:0,salesman:'Vijay',remarks:'Against PO #556',status:'Posted'},
  {id:'r5',dueDate:'22/01/2025',bank:'Canara Bank',receivedDate:'20/01/2025',voucherNo:'RV-000129',party:'Om Sai Traders',credit:0,debit:0,salesman:'Ramesh',remarks:'Part payment',status:'Posted'},
 ],
 issued:[
  {id:'i1',dueDate:'06/01/2025',bank:'HDFC Bank',receivedDate:'03/01/2025',voucherNo:'PV-000310',party:'Getz Pharma',credit:0,debit:42000,salesman:'Ramesh',remarks:'Supplier bill #GP-221',status:'Posted'},
  {id:'i2',dueDate:'12/01/2025',bank:'ICICI Bank',receivedDate:'09/01/2025',voucherNo:'PV-000311',party:'GlaxoSmithKline',credit:0,debit:88000,salesman:'Suresh',remarks:'Monthly settlement',status:'Posted'},
  {id:'i3',dueDate:'18/01/2025',bank:'Axis Bank',receivedDate:'15/01/2025',voucherNo:'PV-000312',party:'The Searle Company',credit:0,debit:36500,salesman:'Amit',remarks:'Against PO #781',status:'Posted'},
 ],
}

const fmt=(n:number)=>n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})

export function ChequePosting({data}:{data:AppData}){
 const navigate=useNavigate()
 const [mode,setMode]=useState<Mode>('reversal')
 const [kind,setKind]=useState<Kind>('received')
 const [from,setFrom]=useState('2025-01-01')
 const [to,setTo]=useState('2025-01-31')
 const [bank,setBank]=useState('All Banks')
 const [voucher,setVoucher]=useState('')
 const [party,setParty]=useState('')
 const [status,setStatus]=useState('Posted Only')
 const [salesman,setSalesman]=useState('All Salesmen')
 const [page,setPage]=useState(1)
 const [rows,setRows]=useState(seed)
 const [checked,setChecked]=useState<Set<string>>(new Set(['r1','r2','r3']))
 const [notice,setNotice]=useState<string|null>(null)

 const banks=useMemo(()=>data.masters.filter(m=>m.type==='Bank').map(m=>m.name),[data])
 const salesmen=['Ramesh','Suresh','Amit','Vijay']

 const wantStatus=mode==='posted'?'Unposted':'Posted'
 const list=rows[kind].filter(r=>
  (bank==='All Banks'||r.bank===bank)&&
  (!voucher||r.voucherNo.toLowerCase().includes(voucher.toLowerCase()))&&
  (!party||r.party.toLowerCase().includes(party.toLowerCase()))&&
  (salesman==='All Salesmen'||r.salesman===salesman)&&
  (status==='All'||r.status===wantStatus))
 const totalCredit=list.reduce((a,r)=>a+r.credit,0)
 const totalDebit=list.reduce((a,r)=>a+r.debit,0)
 const allChecked=list.length>0&&list.every(r=>checked.has(r.id))

 const toggle=(id:string)=>setChecked(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n})
 const toggleAll=()=>setChecked(allChecked?new Set():new Set(list.map(r=>r.id)))
 const reset=()=>{setFrom('2025-01-01');setTo('2025-01-31');setBank('All Banks');setVoucher('');setParty('');setStatus('Posted Only');setSalesman('All Salesmen');setNotice(null)}
 const switchMode=(m:Mode)=>{setMode(m);setStatus(m==='posted'?'Unposted Only':'Posted Only');setChecked(new Set());setNotice(null)}
 const switchKind=(k:Kind)=>{setKind(k);setChecked(new Set());setNotice(null)}

 const process=()=>{
  const ids=list.filter(r=>checked.has(r.id)).map(r=>r.id)
  if(!ids.length){setNotice('Select at least one cheque row to process.');return}
  const next=mode==='posted'?'Posted':'Unposted'
  setRows(rs=>({...rs,[kind]:rs[kind].map(r=>ids.includes(r.id)?{...r,status:next}:r)}))
  setChecked(new Set())
  setNotice(`${ids.length} cheque${ids.length>1?'s':''} ${mode==='posted'?'posted to ledger':'reversed (unposted)'} successfully.`)
 }

 const filtersApplied=[mode,kind,from,to,bank!=='All Banks',voucher,party,status,salesman!=='All Salesmen'].filter(Boolean).length
 const modeLabel=mode==='posted'?'Posted':'Reversal (Unposted)'
 const kindLabel=kind==='received'?'Received Cheques':'Issued Cheques'

 return <div className="chp-page">
  <header className="chp-hero">
   <span className="chp-hero-ico"><CreditCard/></span>
   <div><h1>Cheque Posting &amp; Reversal</h1><p>Post or reverse received and issued cheques</p></div>
   <span className="chp-tagline">Simple Accounting<br/>Stronger Business</span>
  </header>

  <div className="chp-body">
   <section className="chp-card">
    <div className="chp-card-head">
     <span className="chp-card-ico"><Filter/></span>
     <div><h2>Filter / Search</h2><p>Find cheques to post or reverse based on your selected criteria</p></div>
     <span className="chp-hint"><Info/>Use the filters below to find cheques for posting or reversal.</span>
    </div>

    <div className="chp-label">Process Mode</div>
    <div className="chp-modes">
     <button type="button" className={`chp-mode ${mode==='posted'?'on':''}`} onClick={()=>switchMode('posted')}><CircleCheck/><span><b>Posted</b><small>Post cheques (update ledger)</small></span></button>
     <button type="button" className={`chp-mode ${mode==='reversal'?'on':''}`} onClick={()=>switchMode('reversal')}><RefreshCw/><span><b>Reversal (Unposted)</b><small>Undo posted cheques</small></span></button>
     <i className="chp-vsep"/>
     <button type="button" className={`chp-mode kind ${kind==='received'?'on':''}`} onClick={()=>switchKind('received')}><ArrowDownToLine/><span><b>Received Cheques</b><small>Customer receipts</small></span></button>
     <button type="button" className={`chp-mode kind ${kind==='issued'?'on':''}`} onClick={()=>switchKind('issued')}><ArrowUpFromLine/><span><b>Issued Cheques</b><small>Supplier / Payment cheques</small></span></button>
    </div>

    <div className="chp-grid5">
     <label className="chp-fld"><span>From Date</span><span className="chp-in ico"><i><CalendarDays/></i><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></span></label>
     <label className="chp-fld"><span>To Date</span><span className="chp-in ico"><i><CalendarDays/></i><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></span></label>
     <label className="chp-fld"><span>Bank</span><span className="chp-in ico sel"><i><Landmark/></i><select value={bank} onChange={e=>setBank(e.target.value)}><option>All Banks</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown className="chev"/></span></label>
     <label className="chp-fld"><span>Voucher No.</span><span className="chp-in ico"><i><Search/></i><input value={voucher} onChange={e=>setVoucher(e.target.value)} placeholder="Search voucher no..."/></span></label>
     <label className="chp-fld"><span>Account / Party</span><span className="chp-in ico"><i><Search/></i><input value={party} onChange={e=>setParty(e.target.value)} placeholder="Search account or party..."/></span></label>
    </div>
    <div className="chp-row2">
     <label className="chp-fld"><span>Status</span><span className="chp-in sel"><select value={status} onChange={e=>setStatus(e.target.value)}><option>Posted Only</option><option>Unposted Only</option><option>All</option></select><ChevronDown className="chev"/></span></label>
     <label className="chp-fld"><span>Salesman</span><span className="chp-in ico sel"><i><UserRound/></i><select value={salesman} onChange={e=>setSalesman(e.target.value)}><option>All Salesmen</option>{salesmen.map(s=><option key={s}>{s}</option>)}</select><ChevronDown className="chev"/></span></label>
     <div className="chp-filter-btns">
      <button type="button" className="chp-btn solid" onClick={()=>setPage(1)}><Search/>Apply Filters</button>
      <button type="button" className="chp-btn ghost" onClick={reset}><RotateCw/>Reset</button>
     </div>
    </div>

    <div className="chp-active">
     <Filter/><b>Active Filters:</b>
     <span className="chp-chip">Mode: <b>{modeLabel}</b></span>
     <span className="chp-chip">Type: <b>{kindLabel}</b></span>
     <i className="chp-chip-sep"/>
     <span className="chp-chip">Status: <b>{status}</b></span>
     <span className="chp-active-n">{filtersApplied} filters applied</span>
    </div>
   </section>

   <section className="chp-card">
    <div className="chp-card-head">
     <span className="chp-card-ico"><ListChecks/></span>
     <div><h2>Cheque Entries</h2><p>Cheques matching your filter criteria. Select one or more rows for processing.</p></div>
     <div className="chp-pager">
      <span>Showing 1 - {list.length} of {list.length} entries</span>
      <button type="button" aria-label="First page" onClick={()=>setPage(1)}><ChevronsLeft/></button>
      <button type="button" aria-label="Previous page" onClick={()=>setPage(p=>Math.max(1,p-1))}><ChevronLeft/></button>
      {[1,2,3].map(n=><button type="button" key={n} className={page===n?'on':''} onClick={()=>setPage(n)}>{n}</button>)}
      <button type="button" aria-label="Next page" onClick={()=>setPage(p=>Math.min(3,p+1))}><ChevronRight/></button>
     </div>
    </div>

    {notice&&<div className="chp-notice"><CheckCircle2/>{notice}</div>}

    <div className="chp-table-wrap">
     <table className="chp-table">
      <thead><tr>
       <th className="chk"><input type="checkbox" checked={allChecked} onChange={toggleAll}/></th>
       <th>Due Date<ArrowUpDown/></th><th>Bank<ArrowUpDown/></th><th>{kind==='received'?'Received Dt.':'Issued Dt.'}<ArrowUpDown/></th><th>Voucher No.<ArrowUpDown/></th><th>Account / Party<ArrowUpDown/></th>
       <th className="num">Credit (Rs)<ArrowUpDown/></th><th className="num">Debit (Rs)<ArrowUpDown/></th><th>Salesman<ArrowUpDown/></th><th>Remarks<ArrowUpDown/></th><th>Status<ArrowUpDown/></th>
      </tr></thead>
      <tbody>
       {list.map(r=><tr key={r.id} className={checked.has(r.id)?'sel':''}>
        <td className="chk"><input type="checkbox" checked={checked.has(r.id)} onChange={()=>toggle(r.id)}/></td>
        <td>{r.dueDate}</td><td>{r.bank}</td><td>{r.receivedDate}</td><td>{r.voucherNo}</td><td>{r.party}</td>
        <td className="num">{fmt(r.credit)}</td><td className="num">{fmt(r.debit)}</td>
        <td>{r.salesman}</td><td>{r.remarks}</td>
        <td><span className={`chp-status ${r.status==='Posted'?'ok':'off'}`}><i/>{r.status}</span></td>
       </tr>)}
       {!list.length&&<tr><td colSpan={11} className="chp-empty">No cheques match the selected filters.</td></tr>}
      </tbody>
      <tfoot><tr>
       <td colSpan={6} className="num"><b>Total</b></td>
       <td className="num"><b>{fmt(totalCredit)}</b></td><td className="num"><b>{fmt(totalDebit)}</b></td>
       <td colSpan={3}/>
      </tr></tfoot>
     </table>
    </div>
    <div className="chp-foot-note"><Info/>The selected rows will be processed based on the filters above (e.g., will be {mode==='posted'?'posted':'unposted'} in {modeLabel.split(' ')[0]} mode).</div>
   </section>

   <div className="chp-actions">
    <button type="button" className="chp-btn ghost" onClick={()=>window.print()}><Printer/>Print</button>
    <div className="chp-actions-right">
     <button type="button" className="chp-btn ghost" onClick={()=>navigate(-1)}>Cancel</button>
     <button type="button" className="chp-btn solid" onClick={process}><Save/>{mode==='posted'?'Save & Post':'Save & Unpost'}</button>
    </div>
   </div>
  </div>
 </div>
}
