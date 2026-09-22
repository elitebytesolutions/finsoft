'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { BarChart3, Boxes, Building2, CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardList, CreditCard, FileText, Info, Package, Percent, PieChart, Plus, Printer, QrCode, Receipt, Save, ScanBarcode, Search, Settings2, ShoppingBag, Store, Trash2, TrendingUp, Upload, Warehouse, X, Zap } from 'lucide-react'
import type { Product, Purchase } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Line={key:number;upc:string;name:string;product?:Product;ls:number;shelf:number;sw:number;pur:number;sale:number;psQty:number;bns:number;brk:number;tQty:number;tQty2:number;gst:number;disc:number}
type Props={data:AppData;onAdd:(p:Purchase)=>void}
const suppliers=['Medico Distributors','GlaxoSmithKline','Abbott Laboratories','Getz Pharma','Sami Pharmaceuticals']
const salesmen=['SM-001','SM-002','SM-003','SM-004']
const fmt=(v:number)=>v.toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2})
const rs=(v:number)=>`₨ ${fmt(v)}`
const barcode=(id:string)=>'8901234'+(id.replace(/\D/g,'').padStart(6,'0')).slice(-6)
const seedLines=(products:Product[]):Line[]=>[
 ['Paracetamol 500mg Tablet',10,5,0,12,18,10,0,0,10,10],
 ['Vitamin C 1000mg Tablet',2,8,1,25,35,5,1,0,6,5],
 ['Surgical Mask (Box)',5,3,0,50,75,2,0,1,3,0],
 ['Hand Sanitizer 100ml',0,2,0,22,30,10,0,0,10,5],
].map((r,i)=>({key:i+1,upc:barcode(`MED-10${i+1}`),name:r[0] as string,product:products[i],ls:r[1] as number,shelf:r[2] as number,sw:r[3] as number,pur:r[4] as number,sale:r[5] as number,psQty:r[6] as number,bns:r[7] as number,brk:r[8] as number,tQty:r[9] as number,tQty2:r[10] as number,gst:0,disc:0}))
const cost=(l:Line)=>l.pur*l.psQty
const amount=(l:Line)=>cost(l)*(1-l.disc/100)*(1+l.gst/100)

export function PurchaseVoucher({data,onAdd}:Props){
 const navigate=useNavigate()
 const [step,setStep]=useState(1),[open,setOpen]=useState(true)
 const [ref,setRef]=useState('PV-2024-0001'),[ptype,setPtype]=useState<'Shop'|'Warehouse'>('Shop'),[retail,setRetail]=useState(0),[deal,setDeal]=useState(''),[supplier,setSupplier]=useState(suppliers[0]),[bill,setBill]=useState('SB-45872'),[salesman,setSalesman]=useState(salesmen[0]),[due,setDue]=useState('2024-03-01'),[credit,setCredit]=useState(false),[notes,setNotes]=useState('')
 const [lines,setLines]=useState<Line[]>(()=>seedLines(data.products)),[sel,setSel]=useState<Set<number>>(new Set()),[query,setQuery]=useState(''),[markup,setMarkup]=useState(0),[advTax,setAdvTax]=useState(0),[status,setStatus]=useState<'Draft'|'Posted'>('Draft'),[toast,setToast]=useState('')
 const totals=useMemo(()=>{const gross=lines.reduce((a,l)=>a+cost(l),0);const discount=lines.reduce((a,l)=>a+cost(l)*l.disc/100,0);const tax=lines.reduce((a,l)=>a+cost(l)*(1-l.disc/100)*l.gst/100,0);return {items:lines.length,qty:lines.reduce((a,l)=>a+l.tQty,0),gross,discount,tax,net:gross-discount+tax+advTax}},[lines,advTax])
 const patch=(key:number,p:Partial<Line>)=>setLines(prev=>prev.map(l=>l.key===key?{...l,...p}:l))
 const addRow=()=>{const q=query.trim().toLowerCase();const p=q?data.products.find(x=>x.name.toLowerCase().includes(q)||x.id.toLowerCase().includes(q)||barcode(x.id).includes(q)):undefined
  setLines(prev=>[...prev,{key:Date.now(),upc:p?barcode(p.id):'',name:p?.name??'',product:p,ls:0,shelf:0,sw:0,pur:p?.cost??0,sale:p?Math.round(p.cost*(1+markup/100))||p.price:0,psQty:1,bns:0,brk:0,tQty:1,tQty2:0,gst:0,disc:0}]);setQuery('')}
 const remove=(keys:number[])=>{setLines(prev=>prev.filter(l=>!keys.includes(l.key)));setSel(new Set())}
 const toggle=(k:number)=>setSel(prev=>{const n=new Set(prev);if(n.has(k))n.delete(k);else n.add(k);return n})
 const applyMarkup=(v:number)=>{setMarkup(v);if(v>0)setLines(prev=>prev.map(l=>({...l,sale:Math.round(l.pur*(1+v/100)*100)/100})))}
 const post=()=>{if(!lines.length||status==='Posted')return;for(const l of lines){if(!l.name)continue;onAdd({id:`${ref}-${l.key}`,date:'20 Feb 2024',supplier,product:l.name,qty:l.tQty,amount:amount(l),status:'Posted',batch:l.product?.batch??`PV-${l.key}`,expiry:l.product?.expiry??'2027-12-31',unitCost:l.pur})}setStatus('Posted');setToast(`${ref} posted — inventory and supplier ledger updated`)}
 const steps=[['Voucher Details','Basic information'],['Items','Add products to purchase'],['Payments & Tax','Add payments and tax details'],['Review & Post','Verify and post voucher']]
 const num=(l:Line,k:keyof Line,w='')=><input aria-label={`${k} ${l.name||l.key}`} className={`pv-num ${w}`} type="number" min={0} value={l[k] as number} onChange={e=>patch(l.key,{[k]:Number(e.target.value)} as Partial<Line>)}/>
 return <div className="pv-page">
  <nav className="pv-crumb"><span>Purchase</span><ChevronRight/><span>Purchase Voucher</span><ChevronRight/><b>New</b></nav>
  <div className="pv-head"><span className="pv-head-icon"><Save/></span><div><h1>Create Purchase Voucher</h1><p>Record your purchase, update inventory and make payments.</p></div>
   <div className="pv-head-btns"><button type="button" className="pv-btn soft" onClick={()=>{setStatus('Draft');setToast(`${ref} saved as draft`)}}><Save/> Save as Draft</button><button type="button" className="pv-btn solid" disabled={status==='Posted'||!lines.length} onClick={post}><Check/> Save &amp; Post</button><button type="button" className="pv-btn soft" onClick={()=>window.print()}><Printer/> Print</button><button type="button" className="pv-btn soft" onClick={()=>navigate('/purchasing')}><X/> Close</button></div></div>
  {toast&&<div className="pv-toast" role="status"><Check/>{toast}</div>}
  <div className="pv-steps">{steps.map(([t,s],i)=><button type="button" key={t} className={`pv-step ${step>i?'done':''} ${step===i+1?'active':''}`} onClick={()=>setStep(i+1)}><span>{i+1}</span><div><b>{t}</b><small>{s}</small></div>{i<3&&<i/>}</button>)}</div>
  <div className="pv-grid">
   <div className="pv-main">
    <section className="pv-card"><button type="button" className="pv-card-head toggle" onClick={()=>setOpen(o=>!o)} aria-expanded={open}><span className="pv-ico"><FileText/></span><h2>Voucher Information</h2>{open?<ChevronUp/>:<ChevronDown/>}</button>
     {open&&<div className="pv-form">
      <label><span>Ref. No. <i>*</i></span><span className="pv-input"><input value={ref} onChange={e=>setRef(e.target.value)}/><Settings2/></span></label>
      <div className="pv-field"><span>Purchase Type <i>*</i></span><div className="pv-radios">{(['Shop','Warehouse'] as const).map(t=><button type="button" key={t} className={ptype===t?'active':''} onClick={()=>setPtype(t)} aria-pressed={ptype===t}><i/>{t}</button>)}</div></div>
      <label><span>Product Purchase on Retail Price</span><span className="pv-input"><input type="number" min={0} value={retail} onChange={e=>setRetail(Number(e.target.value))}/><Info/></span></label>
      <label><span>Deal on Supply</span><span className="pv-input"><input placeholder="Enter deal or remarks (optional)..." value={deal} onChange={e=>setDeal(e.target.value)}/></span></label>
      <div className="pv-field pv-supplier"><span>Supplier <i>*</i></span><div><span className="pv-input"><Building2/><select aria-label="Supplier" value={supplier} onChange={e=>setSupplier(e.target.value)}>{suppliers.map(s=><option key={s}>{s}</option>)}</select><ChevronDown/></span><button type="button" className="pv-plus" aria-label="Add supplier" onClick={()=>navigate('/vendors')}><Plus/></button></div></div>
      <label><span>Supplier Bill #</span><span className="pv-input"><input value={bill} onChange={e=>setBill(e.target.value)}/></span></label>
      <label><span>Salesman Code</span><span className="pv-input"><select aria-label="Salesman code" value={salesman} onChange={e=>setSalesman(e.target.value)}>{salesmen.map(s=><option key={s}>{s}</option>)}</select><ChevronDown/></span></label>
      <label><span>Due Date</span><span className="pv-input"><CalendarDays/><input type="date" value={due} onChange={e=>setDue(e.target.value)}/></span></label>
      <div className="pv-field"><span>If Credit</span><label className="pv-switch"><input type="checkbox" checked={credit} onChange={e=>setCredit(e.target.checked)}/><i/><em>{credit?'Yes':'Yes'} (This is a credit purchase)</em></label></div>
     </div>}
    </section>
    <section className="pv-card"><div className="pv-card-head"><span className="pv-ico"><Package/></span><div><h2>Purchase Items</h2><p>Add products to this purchase voucher. Search by product name, UPC or scan barcode.</p></div>
      <div className="pv-item-tools"><label className="pv-search"><Search/><input aria-label="Search product" placeholder="Search product by name, UPC or scan barcode..." value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addRow()} list="pv-products"/></label><datalist id="pv-products">{data.products.map(p=><option key={p.id} value={p.name}/>)}</datalist><button type="button" className="pv-btn soft icon" aria-label="Scan barcode"><ScanBarcode/></button><button type="button" className="pv-btn soft"><Upload/> Import</button><button type="button" className="pv-btn solid" onClick={addRow}><Plus/> Add Row</button></div></div>
     <div className="pv-table-wrap"><table className="pv-table"><thead><tr><th>#</th><th>UPC</th><th>Product Name <i>*</i></th><th>LS</th><th>Shelf</th><th>S/W</th><th>Pur. Price</th><th>Sale Price</th><th>Ps-Qty</th><th>Bns</th><th>Brk.</th><th>T-Qty</th><th>T-Qty</th><th>%Gst</th><th>%Disc.</th><th>Cost</th><th>Amount</th><th>Action</th></tr></thead>
      <tbody>{lines.map((l,i)=><tr key={l.key} className={sel.has(l.key)?'sel':''}><td><label className="pv-check"><input type="checkbox" aria-label={`Select row ${i+1}`} checked={sel.has(l.key)} onChange={()=>toggle(l.key)}/><span>{i+1}</span></label></td><td><input aria-label={`UPC ${i+1}`} className="pv-text" value={l.upc} onChange={e=>patch(l.key,{upc:e.target.value})}/></td><td><input aria-label={`Product ${i+1}`} className="pv-text wide" list="pv-products" value={l.name} onChange={e=>{const p=data.products.find(x=>x.name===e.target.value);patch(l.key,{name:e.target.value,...(p?{product:p,upc:barcode(p.id),pur:p.cost,sale:p.price}:{})})}}/></td>
       <td>{num(l,'ls')}</td><td>{num(l,'shelf')}</td><td>{num(l,'sw')}</td><td>{num(l,'pur','money')}</td><td>{num(l,'sale','money')}</td><td>{num(l,'psQty')}</td><td>{num(l,'bns')}</td><td>{num(l,'brk')}</td><td>{num(l,'tQty')}</td><td>{num(l,'tQty2')}</td><td>{num(l,'gst')}</td><td>{num(l,'disc')}</td><td className="pv-money">{fmt(cost(l))}</td><td className="pv-money">{fmt(amount(l))}</td><td><button type="button" className="pv-del" aria-label={`Remove row ${i+1}`} onClick={()=>remove([l.key])}><Trash2/></button></td></tr>)}
      {!lines.length&&<tr><td colSpan={18} className="pv-empty">No items yet — search a product above and click <b>Add Row</b>.</td></tr>}</tbody></table></div>
     <div className="pv-table-foot"><span className="pv-count">Total Items: {lines.length}</span><div><button type="button" className="pv-btn soft sm" onClick={()=>remove(lines.map(l=>l.key))} disabled={!lines.length}><Trash2/> Clear All</button><button type="button" className="pv-btn soft sm" disabled={!sel.size} onClick={()=>remove([...sel])}><Trash2/> Remove Selected</button></div></div>
     <div className="pv-markup"><TrendingUp/><span>Sale Price is</span><input aria-label="Sale price markup" type="number" min={0} value={markup} onChange={e=>applyMarkup(Number(e.target.value))}/><span>% greater than Purchase Price</span><Info/></div>
    </section>
    <section className="pv-card"><div className="pv-card-head"><span className="pv-ico"><Zap/></span><div><h2>More Information &amp; Actions</h2><p>View sales history, stock information and quick actions for this purchase.</p></div></div>
     <div className="pv-info-grid">
      <div className="pv-info"><div className="pv-info-head"><span><BarChart3/></span><div><b>Previous Sale</b><small>View the latest sale price and details for selected product.</small></div><button type="button" className="pv-btn soft xs" onClick={()=>navigate('/sales')}>View All</button></div><table><thead><tr><th>Date</th><th>UPC</th><th>Product</th><th>Sale Price</th></tr></thead><tbody>{lines.slice(0,3).map((l,i)=><tr key={l.key}><td>{['12 Feb 2024','10 Feb 2024','05 Feb 2024'][i]}</td><td>{l.upc}</td><td>{l.name.split(' ').slice(0,2).join(' ')}</td><td>{fmt(l.sale)}</td></tr>)}</tbody></table></div>
      <div className="pv-info"><div className="pv-info-head"><span><ClipboardList/></span><div><b>History</b><small>View purchase history from this supplier.</small></div><button type="button" className="pv-btn soft xs" onClick={()=>navigate('/purchasing')}>View All</button></div><table><thead><tr><th>Date</th><th>Invoice #</th><th>Amount</th></tr></thead><tbody>{data.purchases.slice(0,3).map(p=><tr key={p.id}><td>{p.date}</td><td>{p.id}</td><td>{fmt(p.amount)}</td></tr>)}</tbody></table></div>
      <div className="pv-info"><div className="pv-info-head"><span><Boxes/></span><div><b>Available Stock</b><small>Check current stock in all locations.</small></div></div><table><thead><tr><th>Location</th><th>Stock Qty</th><th>Reserved</th><th>Available</th></tr></thead><tbody>{[['Main Warehouse',1250,120],['Main Shop',532,25],['Secondary Shop',180,15]].map(([n,q,r])=><tr key={n}><td>{n}</td><td>{Number(q).toLocaleString()}</td><td>{r}</td><td>{(Number(q)-Number(r)).toLocaleString()}</td></tr>)}</tbody></table></div>
      <div className="pv-info"><div className="pv-info-head"><span><Zap/></span><div><b>Quick Actions</b><small>Common tasks and shortcuts.</small></div></div><div className="pv-quick">{([['First Receipt',Receipt,'/purchasing'],['New Product',Plus,'/products'],['Bulk Payment',CreditCard,'/payments'],['Cash Payment',CreditCard,'/cash-transactions'],['Price Comparison',BarChart3,'/product-reports'],['Pending PO',ClipboardList,'/po']] as const).map(([l,I,p])=><button type="button" key={l} onClick={()=>navigate(p)}><I/>{l}</button>)}</div></div>
     </div></section>
   </div>
   <aside className="pv-side">
    <div className="pv-ticket"><div className="pv-ticket-top"><span className="pv-ico"><FileText/></span><small>PURCHASE VOUCHER</small><span className={`pv-status ${status.toLowerCase()}`}><i/>{status.toUpperCase()}</span></div><div className="pv-ticket-no"><b>{ref}</b><QrCode/></div>
     <dl><div><dt>Supplier</dt><dd>{supplier}</dd></div><div><dt>Supplier Bill #</dt><dd>{bill||'—'}</dd></div><div><dt>Date</dt><dd>20 Feb 2024</dd></div><div><dt>Due Date</dt><dd>{new Date(`${due}T12:00:00`).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</dd></div><div><dt>Purchase Type</dt><dd className="pv-type">{ptype==='Shop'?<Store/>:<Warehouse/>}{ptype}</dd></div></dl>
     <div className="pv-ticket-total"><span>Total Amount</span><b>{rs(totals.net)}</b></div></div>
    <section className="pv-card side"><h3><span className="pv-ico"><PieChart/></span>Totals &amp; Summary</h3>
     <dl className="pv-sum"><div><dt>Total Items</dt><dd>{totals.items}</dd></div><div><dt>Total Quantity</dt><dd>{totals.qty}</dd></div><div><dt>Stock After Posting</dt><dd>{status==='Posted'?totals.qty:0} Items</dd></div></dl>
     <dl className="pv-sum"><div><dt>Gross Amount</dt><dd>{rs(totals.gross)}</dd></div><div><dt>Total Discount</dt><dd>{rs(totals.discount)}</dd></div><div><dt>Advance Tax</dt><dd><input aria-label="Advance tax" type="number" min={0} className="pv-num money inline" value={advTax} onChange={e=>setAdvTax(Number(e.target.value))}/></dd></div></dl>
     <div className="pv-net"><span>Net Amount</span><b>{rs(totals.net)}</b></div></section>
    <section className="pv-card side"><h3><span className="pv-ico"><Percent/></span>Tax Summary</h3>
     <dl className="pv-sum"><div><dt>Taxable Amount</dt><dd>{rs(totals.gross-totals.discount)}</dd></div><div><dt>CGST (0%)</dt><dd>{rs(0)}</dd></div><div><dt>SGST (0%)</dt><dd>{rs(0)}</dd></div><div><dt>IGST (0%)</dt><dd>{rs(totals.tax)}</dd></div></dl>
     <div className="pv-net plain"><span>Total Tax</span><b>{rs(totals.tax)}</b></div></section>
    <section className="pv-card side"><h3><span className="pv-ico"><FileText/></span>Notes <small>(Optional)</small></h3><textarea aria-label="Notes" rows={2} placeholder="Add notes or remarks..." value={notes} onChange={e=>setNotes(e.target.value)}/></section>
    <button type="button" className="pv-btn soft full" onClick={()=>navigate('/purchasing')}><ShoppingBag/> Open purchase register</button>
   </aside>
  </div>
 </div>
}
