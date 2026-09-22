'use client'
import { useMemo, useState } from 'react'
import { Ban, CalendarDays, Check, ChevronDown, ClipboardCheck, Download, Eye, Info, MoreVertical, Plus, Search, SquareCheck } from 'lucide-react'
import type { AppData } from '@/mocks/api'

type Tab = 'dishonored' | 'void'
type Row = { id:string; date:string; chequeNo:string; party:string; bank:string; amount:number; actionDate:string; reason:string; status:'Dishonored'|'Void'; remarks:string; createdBy:string }

const dishonorReasons=['Insufficient Funds','Account Closed','Signature Mismatch','Payment Stopped','Post Dated','Other']
const voidReasons=['Issued in Error','Spoiled Cheque','Cancelled by Request','Duplicate Entry','Other']

const seedDishonored:Row[]=[
 {id:'DH-01',date:'05 Sep 2025',chequeNo:'782345',party:'Ali Traders',bank:'HBL',amount:150000,actionDate:'08 Sep 2025',reason:'Insufficient Funds',status:'Dishonored',remarks:'Returned by bank',createdBy:'Saim'},
 {id:'DH-02',date:'28 Aug 2025',chequeNo:'778921',party:'Tech Solutions',bank:'Meezan Bank',amount:320000,actionDate:'02 Sep 2025',reason:'Account Closed',status:'Dishonored',remarks:'Account closed',createdBy:'Umer'},
 {id:'DH-03',date:'18 Aug 2025',chequeNo:'775610',party:'Green Supplies',bank:'UBL',amount:95000,actionDate:'20 Aug 2025',reason:'Signature Mismatch',status:'Dishonored',remarks:'Invalid signature',createdBy:'Ayesha'},
 {id:'DH-04',date:'10 Aug 2025',chequeNo:'772210',party:'Retail Store',bank:'Bank Alfalah',amount:210000,actionDate:'12 Aug 2025',reason:'Payment Stopped',status:'Dishonored',remarks:'Stop payment instruction',createdBy:'Saim'},
]
const seedVoid:Row[]=[
 {id:'VD-01',date:'01 Sep 2025',chequeNo:'660112',party:'Getz Pharma',bank:'HBL',amount:88000,actionDate:'03 Sep 2025',reason:'Issued in Error',status:'Void',remarks:'Wrong amount entered',createdBy:'Saim'},
 {id:'VD-02',date:'22 Aug 2025',chequeNo:'661044',party:'GlaxoSmithKline',bank:'Meezan Bank',amount:132500,actionDate:'23 Aug 2025',reason:'Spoiled Cheque',status:'Void',remarks:'Cheque leaf damaged',createdBy:'Umer'},
]

const emptyForm={bank:'',party:'',amount:'',chequeNo:'',actionDate:'',reason:'',chequeDate:'',remarks:'',reversing:false}
type Form=typeof emptyForm

function ChequeArt(){
 return <svg className="cha-art" viewBox="0 0 220 130" aria-hidden="true">
  <g transform="rotate(-8 110 65)">
   <rect x="30" y="25" width="170" height="90" rx="8" fill="#DCE9DF" stroke="#B9CDBF" strokeWidth="3"/>
   <rect x="42" y="38" width="38" height="10" rx="3" fill="#C4D6C9"/>
   <rect x="42" y="58" width="70" height="6" rx="3" fill="#C4D6C9"/>
   <rect x="42" y="72" width="90" height="6" rx="3" fill="#C4D6C9"/>
   <rect x="42" y="88" width="55" height="6" rx="3" fill="#C4D6C9"/>
  </g>
  <circle cx="165" cy="60" r="27" fill="#E8564F" opacity=".9"/>
  <path d="M153 48l24 24M177 48l-24 24" stroke="#FFF" strokeWidth="6" strokeLinecap="round"/>
 </svg>
}

function DateInput({value,onChange,placeholder='Select date'}:{value:string;onChange:(v:string)=>void;placeholder?:string}){
 return <input type={value?'date':'text'} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)} onFocus={e=>{e.target.type='date'}} onBlur={e=>{if(!e.target.value)e.target.type='text'}}/>
}

function Field({label,required,children,span}:{label:string;required?:boolean;children:React.ReactNode;span?:boolean}){
 return <label className={`cha-fld ${span?'span':''}`}><span>{label}{required&&<em>*</em>}</span>{children}</label>
}

function ActionForm({kind,form,set,banks,parties,reasons,onSave,onCancel}:{kind:Tab;form:Form;set:(p:Partial<Form>)=>void;banks:string[];parties:string[];reasons:string[];onSave:()=>void;onCancel:()=>void}){
 const dish=kind==='dishonored'
 return <section className={`cha-form ${kind}`}>
  <div className="cha-form-head">
   <span className={`cha-form-ico ${kind}`}>{dish?<b>!</b>:<Ban/>}</span>
   <h2>{dish?'Mark Cheque as Dishonored (Received)':'Mark Cheque as Void (Issued)'}</h2>
  </div>
  <div className="cha-grid">
   <Field label="Bank Account" required><span className="cha-in sel"><select value={form.bank} onChange={e=>set({bank:e.target.value})}><option value="">Select Bank Account</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown/></span></Field>
   <Field label="Amount" required><span className="cha-in"><input type="number" min="0" step="0.01" value={form.amount} onChange={e=>set({amount:e.target.value})} placeholder="0.00"/></span></Field>
   <Field label={dish?'Customer':'Payee / Vendor'} required><span className="cha-in sel"><select value={form.party} onChange={e=>set({party:e.target.value})}><option value="">{dish?'Select Customer':'Select Vendor'}</option>{parties.map(p=><option key={p}>{p}</option>)}</select><ChevronDown/></span></Field>
   <Field label={dish?'Dishonor Date':'Void Date'} required><span className="cha-in lead"><CalendarDays/><DateInput value={form.actionDate} onChange={v=>set({actionDate:v})}/></span></Field>
   <Field label="Cheque No." required><span className="cha-in"><input value={form.chequeNo} onChange={e=>set({chequeNo:e.target.value})} placeholder="Enter cheque number"/></span></Field>
   <Field label="Reason" required><span className="cha-in sel"><select value={form.reason} onChange={e=>set({reason:e.target.value})}><option value="">Select reason</option>{reasons.map(r=><option key={r}>{r}</option>)}</select><ChevronDown/></span></Field>
   <Field label="Cheque Date"><span className="cha-in lead"><CalendarDays/><DateInput value={form.chequeDate} onChange={v=>set({chequeDate:v})}/></span></Field>
   <Field label="Remarks"><span className="cha-in area"><textarea value={form.remarks} onChange={e=>set({remarks:e.target.value})} placeholder="Enter remarks..."/></span></Field>
  </div>
  <div className="cha-form-foot">
   <label className="cha-check"><input type="checkbox" checked={form.reversing} onChange={e=>set({reversing:e.target.checked})}/>Create reversing entry</label>
   <div className="cha-form-btns">
    <button type="button" className="cha-btn ghost" onClick={onCancel}>Cancel</button>
    <button type="button" className={`cha-btn solid ${kind}`} onClick={onSave}>{dish?<SquareCheck/>:<Ban/>}{dish?'Save as Dishonored':'Save as Void'}</button>
   </div>
  </div>
 </section>
}

export function ChequeActions({data}:{data:AppData}){
 const [tab,setTab]=useState<Tab>('dishonored')
 const [rows,setRows]=useState<Row[]>(seedDishonored)
 const [voidRows,setVoidRows]=useState<Row[]>(seedVoid)
 const [checked,setChecked]=useState<Set<string>>(new Set())

 const [fBank,setFBank]=useState('All Bank Accounts')
 const [fParty,setFParty]=useState('')
 const [fChequeNo,setFChequeNo]=useState('')
 const [fFrom,setFFrom]=useState('')
 const [fTo,setFTo]=useState('')
 const [fStatus,setFStatus]=useState('All')

 const [dForm,setDForm]=useState<Form>({...emptyForm})
 const [vForm,setVForm]=useState<Form>({...emptyForm})
 const [saved,setSaved]=useState<{id:string;kind:Tab}|'error'|null>(null)

 const banks=useMemo(()=>data.masters.filter(m=>m.type==='Bank').map(m=>m.name),[data])
 const customers=useMemo(()=>data.masters.filter(m=>m.type==='Customer').map(m=>m.name),[data])
 const vendors=useMemo(()=>data.masters.filter(m=>m.type==='Supplier').map(m=>m.name),[data])

 const active=tab==='dishonored'?rows:voidRows
 const filtered=active.filter(r=>
  (fBank==='All Bank Accounts'||r.bank===fBank)&&
  (!fParty||r.party.toLowerCase().includes(fParty.toLowerCase()))&&
  (!fChequeNo||r.chequeNo.includes(fChequeNo))&&
  (fStatus==='All'||r.status===fStatus))
 const clearFilters=()=>{setFBank('All Bank Accounts');setFParty('');setFChequeNo('');setFFrom('');setFTo('');setFStatus('All')}
 const switchTab=(t:Tab)=>{setTab(t);setFStatus('All');setChecked(new Set());setSaved(null)}
 const toggle=(id:string)=>setChecked(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n})
 const toggleAll=()=>setChecked(s=>s.size===filtered.length?new Set():new Set(filtered.map(r=>r.id)))

 const today=new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
 const fmtDate=(iso:string)=>iso?new Date(iso+'T00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):''
 const valid=(f:Form)=>f.bank&&f.party&&f.amount&&f.chequeNo&&f.actionDate&&f.reason

 const saveDishonor=()=>{
  if(!valid(dForm)){setSaved('error');return}
  const id=`DH-${String(rows.length+1).padStart(2,'0')}`
  setRows(rs=>[{id,date:dForm.chequeDate?fmtDate(dForm.chequeDate):today,chequeNo:dForm.chequeNo,party:dForm.party,bank:dForm.bank,amount:Number(dForm.amount),actionDate:fmtDate(dForm.actionDate),reason:dForm.reason,status:'Dishonored',remarks:dForm.remarks,createdBy:'You'},...rs])
  setDForm({...emptyForm});setSaved({id,kind:'dishonored'});setTab('dishonored')
 }
 const saveVoid=()=>{
  if(!valid(vForm)){setSaved('error');return}
  const id=`VD-${String(voidRows.length+1).padStart(2,'0')}`
  setVoidRows(rs=>[{id,date:vForm.chequeDate?fmtDate(vForm.chequeDate):today,chequeNo:vForm.chequeNo,party:vForm.party,bank:vForm.bank,amount:Number(vForm.amount),actionDate:fmtDate(vForm.actionDate),reason:vForm.reason,status:'Void',remarks:vForm.remarks,createdBy:'You'},...rs])
  setVForm({...emptyForm});setSaved({id,kind:'void'});setTab('void')
 }

 const dish=tab==='dishonored'

 return <div className="cha-page">
  <header className="cha-hero">
   <div className="cha-hero-left">
    <h1>Cheque Actions</h1>
    <p>Manage dishonored (received) and void (issued) cheques</p>
    <div className="cha-tabs">
     <button type="button" className={dish?'active':''} onClick={()=>switchTab('dishonored')}><span className="cha-tab-ico red"><b>!</b><i><Plus/></i></span>Dishonored Received Cheques</button>
     <button type="button" className={!dish?'active':''} onClick={()=>switchTab('void')}><span className="cha-tab-ico green"><ClipboardCheck/></span>Void Issued Cheques</button>
    </div>
   </div>
   <div className="cha-hero-right">
    <ChequeArt/>
    <p className="cha-quote">&ldquo;Keep your<br/>bank records accurate<br/>and up to date.&rdquo;</p>
   </div>
   <div className="cha-split">
    <button type="button" onClick={dish?saveDishonor:saveVoid}><Plus/>New Action</button>
    <button type="button" aria-label="More actions"><ChevronDown/></button>
   </div>
  </header>

  <div className="cha-body">
   {saved==='error'&&<div className="cha-alert error"><Info/>Fill in bank account, party, amount, cheque number, date and reason before saving.</div>}
   {saved&&saved!=='error'&&<div className="cha-alert ok"><Check/>Cheque <b>{saved.id}</b> marked as {saved.kind==='dishonored'?'dishonored':'void'} successfully.</div>}

   <section className="cha-card cha-filters">
    <label className="cha-fld"><span>Bank Account</span><span className="cha-in sel"><select value={fBank} onChange={e=>setFBank(e.target.value)}><option>All Bank Accounts</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown/></span></label>
    <label className="cha-fld"><span>{dish?'Customer':'Payee / Vendor'}</span><span className="cha-in lead"><Search/><input value={fParty} onChange={e=>setFParty(e.target.value)} placeholder={dish?'Search customer...':'Search vendor...'}/></span></label>
    <label className="cha-fld"><span>Cheque No.</span><span className="cha-in lead"><Search/><input value={fChequeNo} onChange={e=>setFChequeNo(e.target.value)} placeholder="Search cheque no..."/></span></label>
    <label className="cha-fld"><span>Date Range</span><span className="cha-in lead range"><CalendarDays/><DateInput value={fFrom} onChange={setFFrom} placeholder="From Date"/><i>→</i><DateInput value={fTo} onChange={setFTo} placeholder="To Date"/></span></label>
    <label className="cha-fld"><span>Status</span><span className="cha-in sel"><select value={fStatus} onChange={e=>setFStatus(e.target.value)}><option>All</option><option>{dish?'Dishonored':'Void'}</option></select><ChevronDown/></span></label>
    <div className="cha-filter-btns"><button type="button" className="cha-btn solid green"><Search/>Search</button><button type="button" className="cha-btn ghost" onClick={clearFilters}>Clear</button></div>
   </section>

   <section className="cha-card cha-list">
    <div className="cha-list-head">
     <span className={`cha-dot ${dish?'red':'orange'}`}>{dish?<b>!</b>:<Ban/>}</span>
     <h2>{dish?'Dishonored Received Cheques':'Void Issued Cheques'}</h2>
     <span className="cha-count">{filtered.length}</span>
     <button type="button" className="cha-btn ghost sm"><Download/>Export</button>
    </div>
    <div className="cha-table-wrap">
     <table className="cha-table">
      <thead><tr>
       <th className="chk"><input type="checkbox" checked={filtered.length>0&&checked.size===filtered.length} onChange={toggleAll}/></th>
       <th>Date</th><th>Cheque No.</th><th>{dish?'Customer':'Payee / Vendor'}</th><th>Bank</th><th>Amount</th><th>{dish?'Dishonor Date':'Void Date'}</th><th>Reason</th><th>Status</th><th>Remarks</th><th>Created By</th><th className="act"/>
      </tr></thead>
      <tbody>
       {filtered.map(r=><tr key={r.id} className={checked.has(r.id)?'sel':''}>
        <td className="chk"><input type="checkbox" checked={checked.has(r.id)} onChange={()=>toggle(r.id)}/></td>
        <td>{r.date}</td><td>{r.chequeNo}</td><td>{r.party}</td><td>{r.bank}</td>
        <td>PKR {r.amount.toLocaleString('en-PK')}</td>
        <td>{r.actionDate}</td><td>{r.reason}</td>
        <td><span className={`cha-pill ${r.status==='Dishonored'?'red':'orange'}`}>{r.status}</span></td>
        <td>{r.remarks}</td><td>{r.createdBy}</td>
        <td className="act"><button type="button" aria-label="View"><Eye/></button><button type="button" aria-label="More"><MoreVertical/></button></td>
       </tr>)}
       {!filtered.length&&<tr><td colSpan={12} className="cha-empty">No records match the selected filters.</td></tr>}
      </tbody>
     </table>
    </div>
   </section>

   <div className="cha-forms">
    <ActionForm kind="dishonored" form={dForm} set={p=>{setDForm(f=>({...f,...p}));setSaved(null)}} banks={banks} parties={customers} reasons={dishonorReasons} onSave={saveDishonor} onCancel={()=>setDForm({...emptyForm})}/>
    <ActionForm kind="void" form={vForm} set={p=>{setVForm(f=>({...f,...p}));setSaved(null)}} banks={banks} parties={vendors} reasons={voidReasons} onSave={saveVoid} onCancel={()=>setVForm({...emptyForm})}/>
   </div>

   <div className="cha-tip"><span><Info/></span><p><b>Tip:</b> Dishonored cheques (received) will create a reversal entry and mark the cheque as dishonored. Void cheques (issued) will cancel the cheque and create a reversal entry.</p></div>
  </div>
 </div>
}
