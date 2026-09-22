'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { ArrowDownToLine, ArrowUpFromLine, CalendarDays, Check, CheckCircle2, ChevronDown, Copy, Download, Eye, FileText, Grid2x2, Info, Landmark, Pencil, Plus, Printer, ArrowLeftRight, RotateCcw, Save, Search, SendHorizontal, Settings2, SquarePen, Trash2, Upload, X } from 'lucide-react'
import type { AppData } from '@/mocks/api'
import { Button } from '@finsoft/ui'

type Mode = 'receive' | 'issue'
type Tab = 'single' | 'bulk'
const emptyForm = { party:'', chequeNo:'', chequeDate:'', dueDate:'', amount:'', remarks:'', bank:'', notes:'' }

type BulkRow = { code:string; name:string; chequeNo:string; chequeDate:string; dueDate:string; amount:string; remarks:string; oldNo:string }
const emptyRow = ():BulkRow=>({code:'',name:'',chequeNo:'',chequeDate:'',dueDate:'',amount:'',remarks:'',oldNo:''})
const seedRows:BulkRow[] = [
 {code:'CUST001',name:'ABC Traders Ltd.',chequeNo:'458921',chequeDate:'2026-09-09',dueDate:'2026-09-15',amount:'25000',remarks:'Payment for invoice #INV-001',oldNo:''},
 {code:'CUST002',name:'Global Mart',chequeNo:'459322',chequeDate:'2026-09-09',dueDate:'2026-09-15',amount:'75000',remarks:'Advance payment',oldNo:''},
 {code:'VEN001',name:'RA Supplies',chequeNo:'771244',chequeDate:'2026-09-09',dueDate:'2026-09-16',amount:'35000',remarks:'Payment for materials',oldNo:''},
 {code:'VEN002',name:'Office World',chequeNo:'771205',chequeDate:'2026-09-10',dueDate:'2026-09-20',amount:'50000',remarks:'Office equipment',oldNo:''},
 {code:'CUST003',name:'Metro Stores',chequeNo:'771988',chequeDate:'2026-09-10',dueDate:'2026-09-22',amount:'45000',remarks:'Against invoice #4456',oldNo:''},
]
const fmtDate=(d:Date)=>d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})

function ModeCard({active,mode,title,sub,onClick,mini}:{active:boolean;mode:Mode;title:string;sub:string;onClick:()=>void;mini?:boolean}){
 return <button type="button" className={`chq-type ${mini?'mini':''} ${active?'active':''}`} onClick={onClick} aria-pressed={active}>
  {!mini&&<span className={`chq-type-icon ${mode==='receive'?'in':'out'}`}>{mode==='receive'?<ArrowDownToLine/>:<ArrowUpFromLine/>}</span>}
  <span className="chq-type-copy"><b>{title}</b><small>{sub}</small></span>
  <span className={`chq-radio ${active?'on':''}`}/>
 </button>
}

export function ChequeVoucher({data}:{data:AppData}){
 const navigate=useNavigate()
 const [tab,setTab]=useState<Tab>('single')
 const [mode,setMode]=useState<Mode>('receive')
 const [form,setForm]=useState({...emptyForm})
 const [saved,setSaved]=useState<string|null>(null)
 const set=(p:Partial<typeof form>)=>{setForm(f=>({...f,...p}));setSaved(null)}

 const banks=useMemo(()=>data.masters.filter(m=>m.type==='Bank').map(m=>m.name),[data])
 const parties=useMemo(()=>data.masters.filter(m=>m.type===(mode==='receive'?'Customer':'Supplier')).map(m=>m.name),[data,mode])
 const seq=String(data.cheques.length+1).padStart(4,'0')
 const voucherNo=`${mode==='receive'?'R':'I'}-CHQ-${seq}`
 const today=fmtDate(new Date())
 const postedAmount=form.amount?Number(form.amount).toLocaleString('en-PK',{minimumFractionDigits:2}):'0.00'

 const clear=()=>{setForm({...emptyForm});setSaved(null)}
 const save=()=>{
  if(!form.party||!form.chequeNo||!form.chequeDate||!form.amount||!form.bank){setSaved('error');return}
  setSaved(voucherNo);setForm({...emptyForm})
 }
 const switchMode=(m:Mode)=>{setMode(m);setForm({...emptyForm});setSaved(null)}

 // ---- bulk sheet entry ----
 const [bMode,setBMode]=useState<Mode>('receive')
 const [bDate,setBDate]=useState(new Date().toISOString().slice(0,10))
 const [bBank,setBBank]=useState('')
 const [bOldNoRule,setBOldNoRule]=useState('Auto if new')
 const [bPrefix,setBPrefix]=useState('R-Chq # -')
 const [rows,setRows]=useState<BulkRow[]>(seedRows)
 const [checked,setChecked]=useState<Set<number>>(new Set())
 const setRow=(i:number,p:Partial<BulkRow>)=>setRows(rs=>rs.map((r,j)=>j===i?{...r,...p}:r))
 const addRow=()=>setRows(rs=>[...rs,emptyRow()])
 const deleteRow=(i:number)=>{setRows(rs=>rs.filter((_,j)=>j!==i));setChecked(new Set())}
 const duplicateRow=(i:number)=>setRows(rs=>[...rs.slice(0,i+1),{...rs[i]},...rs.slice(i+1)])
 const toggleRow=(i:number)=>setChecked(s=>{const n=new Set(s);if(n.has(i))n.delete(i);else n.add(i);return n})
 const toggleAll=()=>setChecked(s=>s.size===rows.length?new Set():new Set(rows.map((_,i)=>i)))
 const duplicateSelected=()=>{const picked=[...checked].sort((a,b)=>a-b).map(i=>({...rows[i]}));if(picked.length)setRows(rs=>[...rs,...picked]);setChecked(new Set())}
 const deleteSelected=()=>{setRows(rs=>rs.filter((_,i)=>!checked.has(i)));setChecked(new Set())}
 const validRows=rows.filter(r=>r.code&&r.chequeNo&&r.chequeDate&&r.amount)
 const switchBMode=(m:Mode)=>{setBMode(m);setBPrefix(m==='receive'?'R-Chq # -':'I-Chq # -')}
 const bParties=useMemo(()=>data.masters.filter(m=>m.type===(bMode==='receive'?'Customer':'Supplier')),[data,bMode])
 const amt=(v:string)=>v?Number(v).toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2}):''

 return <div className="chq-page">
  <header className="chq-head">
   <span className="chq-head-icon"><SquarePen/></span>
   <div className="chq-head-copy"><h1>Cheque Voucher</h1><p>{tab==='single'?'Create a single cheque voucher for receipt or issuance.':'Create multiple cheque vouchers in bulk. Enter rows directly on screen or use Excel to populate.'}</p></div>
   <div className="chq-head-actions">
    <Button kind="secondary" onClick={()=>window.print()}><Printer/> Print</Button>
    <Button kind="secondary" onClick={clear}><FileText/> New</Button>
    <Button onClick={tab==='single'?save:()=>undefined}><Save/> Save</Button>
    <Button kind="secondary" onClick={clear}><RotateCcw/> Clear</Button>
    <Button kind="secondary" onClick={()=>navigate(-1)}><X/> Exit</Button>
   </div>
  </header>

  <div className="chq-toptabs" role="tablist">
   <button role="tab" aria-selected={tab==='single'} className={tab==='single'?'active':''} onClick={()=>setTab('single')}><Pencil/> Single Entry</button>
   <button role="tab" aria-selected={tab==='bulk'} className={tab==='bulk'?'active':''} onClick={()=>setTab('bulk')}><Grid2x2/> Bulk Sheet Entry</button>
  </div>

  {tab==='single'?<>
   <section className="chq-typecard">
    <div className="chq-typecard-head"><span className="chq-card-icon"><ArrowLeftRight/></span><div><h2>Voucher Type</h2><p>Select whether you are receiving a cheque from a customer or issuing a cheque to a vendor.</p></div></div>
    <div className="chq-type-grid">
     <ModeCard active={mode==='receive'} mode="receive" title="Receive Cheque" sub="Incoming cheque from customer" onClick={()=>switchMode('receive')}/>
     <ModeCard active={mode==='issue'} mode="issue" title="Issue Cheque" sub="Outgoing cheque to vendor" onClick={()=>switchMode('issue')}/>
    </div>
   </section>

   {saved==='error'&&<div className="chq-alert error"><Info size={15}/> Fill in party, cheque number, cheque date, amount and bank account before saving.</div>}
   {saved&&saved!=='error'&&<div className="chq-alert ok"><Check size={15}/> Cheque voucher <b>&nbsp;{saved}&nbsp;</b> saved successfully.</div>}

   <section className="chq-card">
    <div className="chq-card-head"><span className="chq-card-icon"><FileText/></span><div><h2>Voucher Information</h2><p>Basic information for this cheque voucher.</p></div></div>
    <div className="chq-info-grid">
     <label><span>Old No.</span><input value="" readOnly placeholder="Auto if new"/></label>
     <label><span>Voucher No.</span><input value={voucherNo} readOnly className="locked"/></label>
     <label><span>Voucher Date</span><span className="chq-field datebox"><span><CalendarDays/></span><input value={today} readOnly/></span></label>
    </div>
   </section>

   <div className="chq-cols">
    <section className="chq-card">
     <div className="chq-card-head"><span className="chq-card-icon"><SquarePen/></span><div><h2>Cheque Details</h2><p>Enter the cheque information {mode==='receive'?'received from the customer.':'used to pay the vendor.'}</p></div></div>
     <div className="chq-form">
      <label><span>Party / Account <em>*</em></span><span className="chq-field trail split"><input list="chq-parties" value={form.party} onChange={e=>set({party:e.target.value})} placeholder={mode==='receive'?'Select Customer / Account':'Select Vendor / Account'}/><Search/></span></label>
      <label><span>Cheque No. <em>*</em></span><input value={form.chequeNo} onChange={e=>set({chequeNo:e.target.value})} placeholder="Enter cheque number"/></label>
      <label><span>Cheque Date <em>*</em></span><span className="chq-field date"><input type="date" value={form.chequeDate} onChange={e=>set({chequeDate:e.target.value})}/><CalendarDays/></span></label>
      <label><span>Due Date</span><span className="chq-field date"><input type="date" value={form.dueDate} onChange={e=>set({dueDate:e.target.value})}/><CalendarDays/></span></label>
      <label><span>Amount <em>*</em></span><span className="chq-field money"><span className="chq-rs">Rs.</span><input type="number" min="0" step="0.01" value={form.amount} onChange={e=>set({amount:e.target.value})} placeholder="0.00"/></span></label>
      <label className="chq-top"><span>Remarks</span><span className="chq-field area"><textarea maxLength={500} value={form.remarks} onChange={e=>set({remarks:e.target.value})} placeholder="e.g. Invoice reference, payment notes etc."/><small>{form.remarks.length}/500</small></span></label>
     </div>
     <datalist id="chq-parties">{parties.map(p=><option key={p} value={p}/>)}</datalist>
    </section>

    <section className="chq-card">
     <div className="chq-card-head"><span className="chq-card-icon"><Landmark/></span><div><h2>Bank &amp; Posting Information</h2><p>Select bank account and view posting information.</p></div></div>
     <div className="chq-banner"><span className="chq-banner-icon"><Info/></span><div><b>{mode==='receive'?'Receive Mode: Deposit in Bank':'Issue Mode: From Bank'}</b><p>{mode==='receive'?'In receive mode, the cheque amount will be posted as credit to the selected bank account.':'In issue mode, the cheque amount will be posted as debit from the selected bank account.'}</p></div></div>
     <div className="chq-form">
      <label><span>Bank Account <em>*</em></span><span className="chq-field sel"><select value={form.bank} onChange={e=>set({bank:e.target.value})}><option value="">Select Bank Account</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown/></span></label>
     </div>
     <div className="chq-posting">
      <h4>Posting Information</h4>
      <div className="chq-form">
       <label><span>Credit / Debit Amount</span><span className="chq-field money locked"><span className="chq-rs">Rs.</span><input readOnly value={postedAmount}/></span></label>
      </div>
     </div>
     <div className="chq-banner soft"><span className="chq-banner-icon"><Info/></span><p>{mode==='receive'?'The amount will be posted as credit to the selected bank account.':'The amount will be posted as debit from the selected bank account.'}</p></div>
    </section>
   </div>

   <section className="chq-card chq-notes-card">
    <div className="chq-notes-head">
     <div className="chq-card-head"><span className="chq-card-icon"><FileText/></span><div><h2>Additional Notes</h2><p>Any additional remarks or narration (optional).</p></div></div>
     <small>{form.notes.length}/500</small>
    </div>
    <input className="chq-input" maxLength={500} value={form.notes} onChange={e=>set({notes:e.target.value})} placeholder="Enter additional notes, if any..."/>
   </section>

   <div className="chq-footer">
    <Button onClick={save}><Check/> OK</Button>
    <Button kind="secondary" onClick={()=>navigate(-1)}><X/> Cancel</Button>
   </div>
  </>:<>
   <div className="chq-steps">
    <div className="chq-step active"><span>1</span><div><b>Voucher Fields</b><small>Set common fields for all vouchers</small></div></div>
    <i className="chq-step-line"/>
    <div className="chq-step"><span>2</span><div><b>Sheet Population <i>(Optional)</i></b><small>Use Excel to populate rows (optional)</small></div></div>
    <div className="chq-step-note"><span className="chq-banner-icon"><Info/></span>Enter multiple voucher rows below. Sheet population is optional and can be used to fill rows faster.</div>
   </div>

   <section className="chq-card">
    <div className="chq-card-head"><span className="chq-card-icon"><Settings2/></span><div><h2>Bulk Voucher Setup</h2><p>These values will be applied to all voucher rows unless overridden in the individual rows below.</p></div></div>
    <div className="chq-setup-row1">
     <div className="chq-setup-type">
      <span className="chq-setup-label">Voucher Type <em className="chq-req">*</em></span>
      <div className="chq-type-mini-grid">
       <ModeCard mini active={bMode==='receive'} mode="receive" title="Receive Cheque" sub="Cheque received from customer" onClick={()=>switchBMode('receive')}/>
       <ModeCard mini active={bMode==='issue'} mode="issue" title="Issue Cheque" sub="Cheque issued to vendor" onClick={()=>switchBMode('issue')}/>
      </div>
     </div>
     <label className="chq-setup-field"><span>Voucher Date <em className="chq-req">*</em></span><span className="chq-field datebox"><span><CalendarDays/></span><input type="date" value={bDate} onChange={e=>setBDate(e.target.value)}/></span></label>
     <label className="chq-setup-field"><span>Bank Account <em className="chq-req">*</em></span><span className="chq-field datebox sel"><span><Landmark/></span><select value={bBank} onChange={e=>setBBank(e.target.value)}><option value="">Select Bank Account</option>{banks.map(b=><option key={b}>{b}</option>)}</select><ChevronDown/></span></label>
     <label className="chq-setup-field"><span>Posting Mode</span><span className="chq-field sel"><select value={bMode} onChange={e=>switchBMode(e.target.value as Mode)}><option value="receive">Deposit in Bank</option><option value="issue">Pay from Bank</option></select><ChevronDown/></span></label>
    </div>
    <div className="chq-setup-row2">
     <div className="chq-setup-col">
      <span>Old No. Rule</span>
      <span className="chq-field sel"><select value={bOldNoRule} onChange={e=>setBOldNoRule(e.target.value)}><option>Auto if new</option><option>Manual entry</option></select><ChevronDown/></span>
      <small className="chq-setup-hint">Set how old voucher numbers should be assigned.</small>
     </div>
     <div className="chq-setup-col">
      <span>Default Remarks Prefix</span>
      <input value={bPrefix} onChange={e=>setBPrefix(e.target.value)}/>
      <small className="chq-setup-hint">This prefix will be added to remarks for all vouchers.</small>
     </div>
     <div className="chq-banner"><span className="chq-banner-icon"><Info/></span><p>These setup values will be applied to all voucher rows below unless you override them in the individual row fields.</p></div>
    </div>
   </section>

   <section className="chq-card chq-bulk-rows">
    <div className="chq-card-head between">
     <div className="chq-head-left"><span className="chq-card-icon"><Grid2x2/></span><div><h2>Bulk Entry Rows</h2><p>Enter multiple voucher rows directly on screen. Each row will create one voucher.</p></div></div>
     <div className="chq-bulk-actions">
      <span className="chq-total-rows">Total Rows: {rows.length}</span>
      <button className="chq-addrow-btn" onClick={addRow}><Plus/> Add Row</button>
      <Button kind="secondary" onClick={duplicateSelected}><Copy/> Duplicate Selected</Button>
      <button className="chq-danger-btn" onClick={deleteSelected}><Trash2/> Delete Selected</button>
     </div>
    </div>
    <div className="chq-bulk-table">
     <table>
      <colgroup><col className="c-chk"/><col className="c-idx"/><col className="c-code"/><col className="c-name"/><col className="c-chq"/><col className="c-date"/><col className="c-date"/><col className="c-amt"/><col/><col className="c-old"/><col className="c-act"/></colgroup>
      <thead><tr>
       <th className="chk"><input type="checkbox" aria-label="Select all rows" checked={checked.size===rows.length&&rows.length>0} onChange={toggleAll}/></th>
       <th>#</th><th>Party / Account Code <em>*</em></th><th>Party Name <em>*</em></th><th>Cheque No. <em>*</em></th><th>Cheque Date <em>*</em></th><th>Due Date</th><th>Amount <em>*</em></th><th>Remarks</th><th>Old No.</th><th>Actions</th>
      </tr></thead>
      <tbody>
       {rows.map((r,i)=><tr key={i} className={checked.has(i)?'sel':''}>
        <td className="chk"><input type="checkbox" aria-label={`Select row ${i+1}`} checked={checked.has(i)} onChange={()=>toggleRow(i)}/></td>
        <td className="idx">{i+1}</td>
        <td><span className="chq-field trail sm"><input list="chq-bulk-parties" value={r.code} onChange={e=>{const v=e.target.value;const m=bParties.find(p=>p.code===v);setRow(i,{code:v,name:m?m.name:r.name})}} placeholder="CUST001"/><Search/></span></td>
        <td><input value={r.name} onChange={e=>setRow(i,{name:e.target.value})} placeholder="Party name"/></td>
        <td><input value={r.chequeNo} onChange={e=>setRow(i,{chequeNo:e.target.value})} placeholder="Cheque no."/></td>
        <td><span className="chq-field lead sm"><CalendarDays/><input type="date" value={r.chequeDate} onChange={e=>setRow(i,{chequeDate:e.target.value})}/></span></td>
        <td><span className="chq-field lead sm"><CalendarDays/><input type="date" value={r.dueDate} onChange={e=>setRow(i,{dueDate:e.target.value})}/></span></td>
        <td className="num"><input inputMode="decimal" value={amt(r.amount)} onChange={e=>setRow(i,{amount:e.target.value.replace(/[^\d.]/g,'')})} placeholder="0.00"/></td>
        <td><input value={r.remarks} onChange={e=>setRow(i,{remarks:e.target.value})} placeholder="Remarks"/></td>
        <td><input value={r.oldNo} onChange={e=>setRow(i,{oldNo:e.target.value})} placeholder="-"/></td>
        <td><div className="chq-row-actions"><button aria-label="Duplicate row" onClick={()=>duplicateRow(i)}><Copy/></button><button aria-label="Delete row" className="danger" onClick={()=>deleteRow(i)}><Trash2/></button></div></td>
       </tr>)}
      </tbody>
     </table>
    </div>
    <datalist id="chq-bulk-parties">{bParties.map(p=><option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
   </section>

   <section className="chq-card chq-sheet-pop">
    <div className="chq-sheet-left">
     <div className="chq-card-head"><span className="chq-card-icon"><Upload/></span><div><h2>Sheet Population (Optional)</h2><p>Use Excel only if you want to populate rows faster; you can also enter rows directly on screen.</p></div></div>
     <div className="chq-sheet-actions">
      <Button onClick={()=>undefined}><Download/> Download Excel Template</Button>
      <Button kind="secondary" onClick={()=>undefined}><Upload/> Upload Populated Sheet</Button>
      <button className="chq-ghost-btn" disabled><Eye/> Preview Import</button>
     </div>
    </div>
    <div className="chq-sheet-how">
     <span className="chq-banner-icon"><Info/></span>
     <div>
      <b>How it works?</b>
      <div className="chq-howsteps">
       <span><i>1</i>Download the Excel template</span>
       <span><i>2</i>Fill in your data and upload the file</span>
       <span><i>3</i>Preview and import to populate the rows above</span>
      </div>
     </div>
    </div>
    <div className="chq-sheet-fmt"><FileText/><span>Supported format: .xlsx, .xls<br/>Maximum 1,000 records per file</span></div>
   </section>

   <div className="chq-footer between">
    <span className="chq-total-rows"><CheckCircle2 size={15}/> {validRows.length} of {rows.length} rows ready</span>
    <div style={{display:'flex',gap:10}}>
     <Button kind="secondary" onClick={()=>navigate(-1)}>Cancel</Button>
     <button className="btn outline-green" onClick={()=>undefined}><CheckCircle2/> Validate Rows</button>
     <Button onClick={()=>undefined}><SendHorizontal/> Generate Vouchers</Button>
    </div>
   </div>
  </>}
 </div>
}
