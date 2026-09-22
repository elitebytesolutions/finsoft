'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import { BookOpen, Calculator, CalendarDays, Check, ChevronDown, Coins, Ellipsis, FileText, Info, MapPin, Package, Plus, Printer, RefreshCw, Save, Search, Tag, Trash2, Truck, UserRound, Wallet, X } from 'lucide-react'
import type { Master, Product, Sale } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Line={key:number;product?:Product;name:string;pack:string;batch:string;qty:number;bonus:number;rate:number;disc:number;gst:number}
type Props={data:AppData;onAdd:(s:Sale)=>void}
const fmt=(v:number)=>v.toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2})
const packs=["10's","20's","30's","100's",'Bottle','Box']
const gross=(l:Line)=>l.qty*l.rate
const net=(l:Line)=>gross(l)*(1-l.disc/100)*(1+l.gst/100)
const netRate=(l:Line)=>l.qty?net(l)/l.qty:0
const seed=(products:Product[]):Line[]=>[[10,2,12,5],[5,1,28,0],[20,0,8.5,10],[10,1,22,5],[15,2,15,0]].map(([qty,bonus,rate,disc],i)=>{const p=products[i%products.length];return {key:i+1,product:p,name:p.name,pack:"10's",batch:p.batches[0]?.id??p.batch,qty,bonus,rate,disc,gst:7}})

function Field({label,children,required}:{label:string;children:React.ReactNode;required?:boolean}){return <label className="sav-field"><span>{label}{required&&<i>*</i>}</span>{children}</label>}
function Pick({value,onChange,options,aria}:{value:string;onChange:(v:string)=>void;options:string[];aria?:string}){return <span className="sav-input"><select aria-label={aria} value={value} onChange={e=>onChange(e.target.value)}>{options.map(o=><option key={o}>{o}</option>)}</select><ChevronDown/></span>}

export function SalesVoucher({data,onAdd}:Props){
 const navigate=useNavigate()
 const customers=data.masters.filter((m:Master)=>m.type==='Customer')
 const [customer,setCustomer]=useState(customers[0]?.name??'')
 const cust=customers.find(c=>c.name===customer)
 const [area,setArea]=useState(cust?.extra?.area??'Gulberg'),[city,setCity]=useState(cust?.city??'Lahore')
 const pickCustomer=(n:string)=>{setCustomer(n);const c=customers.find(x=>x.name===n);if(c){setArea(c.extra?.area??area);setCity(c.city||city)}}
 const [saleDate,setSaleDate]=useState('2026-09-13'),[po,setPo]=useState('PO-78956'),[poDate,setPoDate]=useState('2026-09-12')
 const [booker,setBooker]=useState('Ahmed Khan'),[delivery,setDelivery]=useState('Rafiq Shah'),[salesman,setSalesman]=useState('Tanvir Hasan'),[doctor,setDoctor]=useState('Dr. Rashid Ahmed'),[supervisor,setSupervisor]=useState('Salma Akter'),[saleType,setSaleType]=useState('Regular'),[place,setPlace]=useState('Main Warehouse'),[remarks,setRemarks]=useState('Urgent delivery requested.')
 const [lines,setLines]=useState<Line[]>(()=>seed(data.products)),[query,setQuery]=useState(''),[toast,setToast]=useState(''),[status,setStatus]=useState<'Draft'|'Posted'>('Draft')
 const saleNo=`SV-2026-${String(123+data.sales.length).padStart(6,'0')}`,invNo=`INV-${String(8912+data.sales.length).padStart(6,'0')}`
 const totals=useMemo(()=>{const g=lines.reduce((a,l)=>a+gross(l),0);const d=lines.reduce((a,l)=>a+gross(l)*l.disc/100,0);const t=lines.reduce((a,l)=>a+gross(l)*(1-l.disc/100)*l.gst/100,0);return {items:lines.length,qty:lines.reduce((a,l)=>a+l.qty+l.bonus,0),gross:g,disc:d,gst:t,net:g-d+t}},[lines])
 const patch=(k:number,p:Partial<Line>)=>setLines(ls=>ls.map(l=>l.key===k?{...l,...p}:l))
 const setProduct=(k:number,name:string)=>{const p=data.products.find(x=>x.name===name);patch(k,{name,product:p,batch:p?.batches[0]?.id??p?.batch??'',rate:p?.price??0})}
 const addRow=(name='')=>{const p=name?data.products.find(x=>x.name===name):undefined;setLines(ls=>[...ls,{key:Date.now(),product:p,name:p?.name??'',pack:"10's",batch:p?.batches[0]?.id??'',qty:1,bonus:0,rate:p?.price??0,disc:0,gst:7}]);setQuery('')}
 const findProduct=()=>{const q=query.trim().toLowerCase();if(!q)return;const p=data.products.find(x=>x.name.toLowerCase().includes(q)||x.id.toLowerCase().includes(q)||x.generic.toLowerCase().includes(q));if(p)addRow(p.name);else setToast(`No product matches "${query}"`)}
 const post=()=>{if(status==='Posted'||!lines.length)return;lines.filter(l=>l.name&&l.qty>0).forEach((l,i)=>onAdd({id:`${invNo}${i?`-${i+1}`:''}`,date:'13 Sep 2026',customer,product:l.name,qty:l.qty,amount:Math.round(net(l)),mode:saleType,status:'Credit',batch:l.batch,unitCost:l.product?.cost??0}));setStatus('Posted');setToast(`${saleNo} posted — ${totals.items} items, net ₨ ${fmt(totals.net)}`)}
 const num=(l:Line,k:'qty'|'bonus'|'rate'|'disc',cls='')=><input aria-label={`${k} ${l.name||l.key}`} className={`sav-num ${cls}`} type="number" min={0} step={k==='rate'?'0.01':'1'} value={l[k]} onChange={e=>patch(l.key,{[k]:Number(e.target.value)} as Partial<Line>)}/>

 return <div className="sav-page">
  <header className="sav-head"><span className="sav-head-icon"><FileText/></span><div><h1>Sales Voucher</h1><p>Create and record a sales invoice with customer, order and item details.</p></div>
   <div className="sav-head-btns"><button type="button" className="sav-btn" onClick={()=>{setStatus('Draft');setToast(`${saleNo} saved as draft`)}}><Save/> Save Draft</button><button type="button" className="sav-btn solid" disabled={status==='Posted'||!lines.length} onClick={post}><Check/> Save &amp; Post</button><button type="button" className="sav-btn" onClick={()=>window.print()}><Printer/> Print</button><button type="button" className="sav-btn"><FileText/> Estimate</button><button type="button" className="sav-btn"><Ellipsis/> More <ChevronDown/></button></div></header>
  {toast&&<div className="sav-toast" role="status"><Check/>{toast}<button aria-label="Dismiss" onClick={()=>setToast('')}><X/></button></div>}

  <div className="sav-refs">
   <div className="sav-ref"><span><FileText/></span><div><small>Sale No</small><b>{saleNo}</b></div></div>
   <div className="sav-ref"><span><CalendarDays/></span><div><small>Sale Date</small><label className="sav-date"><input type="date" aria-label="Sale date" value={saleDate} onChange={e=>setSaleDate(e.target.value)}/></label></div></div>
   <div className="sav-ref"><span><FileText/></span><div><small>Purchase Order No</small><input className="sav-plain" aria-label="Purchase order no" value={po} onChange={e=>setPo(e.target.value)}/></div></div>
   <div className="sav-ref"><span><CalendarDays/></span><div><small>Purchase Order Date</small><label className="sav-date"><input type="date" aria-label="Purchase order date" value={poDate} onChange={e=>setPoDate(e.target.value)}/></label></div></div>
   <div className="sav-ref"><span><FileText/></span><div><small>Invoice No</small><b>{invNo}</b></div></div>
   <div className="sav-ref"><span><BookOpen/></span><div><small>Bill Book No</small><b>BB-01</b></div></div>
  </div>

  <div className="sav-grid">
   <section className="sav-card">
    <div className="sav-card-head"><UserRound/><h2>Order &amp; Customer Information</h2><span className="sav-hint"><Info/> Select a customer to auto-fill customer details.</span></div>
    <div className="sav-form two">
     <Field label="Customer / Party" required><Pick aria="Customer" value={customer} onChange={pickCustomer} options={customers.map(c=>c.name)}/></Field>
     <Field label="Customer Name"><span className="sav-input ro"><input readOnly value={customer}/></span></Field>
     <div className="sav-address span-2"><MapPin/><b>Address:</b><span>{cust?`${cust.extra?.area??''}${cust.extra?.area?', ':''}${cust.city}`:'—'}<br/>{cust?.contact}</span></div>
     <Field label="Area"><Pick aria="Area" value={area} onChange={setArea} options={[...new Set([area,'Gulberg','Johar Town','Shadman','Clifton','DHA'])]}/></Field>
     <Field label="City"><Pick aria="City" value={city} onChange={setCity} options={[...new Set([city,'Lahore','Karachi','Islamabad','Rawalpindi'])]}/></Field>
    </div>
   </section>
   <section className="sav-card">
    <div className="sav-card-head"><Truck/><h2>Fulfillment &amp; Sales Team</h2></div>
    <div className="sav-form three">
     <Field label="Booker Name"><Pick aria="Booker" value={booker} onChange={setBooker} options={['Ahmed Khan','Bilal Saeed','Kashif Ali']}/></Field>
     <Field label="Deliveryman"><Pick aria="Deliveryman" value={delivery} onChange={setDelivery} options={['Rafiq Shah','Naeem Butt','Arif Khan']}/></Field>
     <Field label="Salesman"><Pick aria="Salesman" value={salesman} onChange={setSalesman} options={['Tanvir Hasan','Usman Ali','Hamza Tariq']}/></Field>
     <Field label="Doctor"><Pick aria="Doctor" value={doctor} onChange={setDoctor} options={['Dr. Rashid Ahmed','Dr. Sana Iqbal','None']}/></Field>
     <Field label="Supervisor"><Pick aria="Supervisor" value={supervisor} onChange={setSupervisor} options={['Salma Akter','Fahad Mir']}/></Field>
     <Field label="Sale Type"><Pick aria="Sale type" value={saleType} onChange={setSaleType} options={['Regular','Retail','Wholesale','Hospital','Clinic']}/></Field>
     <Field label="Place / Warehouse"><Pick aria="Warehouse" value={place} onChange={setPlace} options={['Main Warehouse','Shop DHA','Shop Johar Town']}/></Field>
     <label className="sav-field span-2"><span>Remarks</span><span className="sav-input"><input value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="Add remarks (optional)"/></span></label>
    </div>
   </section>
  </div>

  <section className="sav-card sav-items">
   <div className="sav-card-head"><span className="sav-ico"><Package/></span><h2>Item Entry</h2><p>Select a product to auto-fill pack, batch, rate and tax details.</p>
    <div className="sav-tools"><label className="sav-search"><Search/><input aria-label="Search product" placeholder="Search product by name, code or generic..." value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&findProduct()} list="sav-products"/></label><datalist id="sav-products">{data.products.map(p=><option key={p.id} value={p.name}/>)}</datalist>
     <button type="button" className="sav-btn solid" onClick={findProduct}><Search/> Find Product</button><button type="button" className="sav-btn green" onClick={()=>addRow()}><Plus/> Add Product</button><button type="button" className="sav-btn green"><RefreshCw/> Product Change</button><button type="button" className="sav-btn green" onClick={()=>navigate('/products')}><Plus/> New Product</button></div></div>
   <div className="sav-table-wrap"><table className="sav-table">
    <thead><tr><th>#</th><th>Product Name <i>*</i></th><th>Pack</th><th>Batch / Expiry</th><th>Qty</th><th>Bonus</th><th>Sale Rate</th><th>Gross Amount</th><th>Disc %</th><th>GST %</th><th>Net Rate</th><th>Net Amount</th><th>Action</th></tr></thead>
    <tbody>{lines.map((l,i)=><tr key={l.key}>
     <td className="sav-idx">{i+1}</td>
     <td><span className="sav-input"><select aria-label={`Product ${i+1}`} value={l.name} onChange={e=>setProduct(l.key,e.target.value)}><option value="">Select product</option>{data.products.map(p=><option key={p.id}>{p.name}</option>)}</select><ChevronDown/></span></td>
     <td><Pick aria={`Pack ${i+1}`} value={l.pack} onChange={v=>patch(l.key,{pack:v})} options={packs}/></td>
     <td><span className="sav-input"><select aria-label={`Batch ${i+1}`} value={l.batch} onChange={e=>patch(l.key,{batch:e.target.value})}>{(l.product?.batches??[]).map(b=><option key={b.id} value={b.id}>{b.id}  |  {b.expiry.slice(5,7)}/{b.expiry.slice(0,4)}</option>)}{!l.product&&<option value="">—</option>}</select><ChevronDown/></span></td>
     <td>{num(l,'qty')}</td><td>{num(l,'bonus')}</td><td>{num(l,'rate','money')}</td>
     <td><output className="sav-num ro">{fmt(gross(l))}</output></td>
     <td>{num(l,'disc')}</td>
     <td><span className="sav-input sm"><select aria-label={`GST ${i+1}`} value={l.gst} onChange={e=>patch(l.key,{gst:Number(e.target.value)})}>{[0,5,7,17,18].map(g=><option key={g} value={g}>{g}</option>)}</select><ChevronDown/></span></td>
     <td className="sav-money">{fmt(netRate(l))}</td>
     <td><output className="sav-num ro money">{fmt(net(l))}</output></td>
     <td><button type="button" className="sav-del" aria-label={`Remove row ${i+1}`} onClick={()=>setLines(ls=>ls.filter(x=>x.key!==l.key))}><Trash2/></button></td>
    </tr>)}</tbody></table></div>
   <div className="sav-table-foot"><button type="button" className="sav-btn green" onClick={()=>addRow()}><Plus/> Add Row</button><button type="button" className="sav-link" onClick={()=>setLines([])}><Trash2/> Clear All Items</button><span className="sav-hint plain"><Info/> Selecting a product will auto-populate pack, batch, rate and tax details.</span></div>
  </section>

  <footer className="sav-foot">
   <div><span><Package/></span><div><small>Total Items</small><b>{totals.items}</b></div></div>
   <div><span><FileText/></span><div><small>Total Qty</small><b>{totals.qty}</b></div></div>
   <div><span><Calculator/></span><div><small>Gross Amount</small><b>{fmt(totals.gross)}</b></div></div>
   <div><span><Tag/></span><div><small>Discount</small><b>{fmt(totals.disc)}</b></div></div>
   <div><span><Coins/></span><div><small>GST Amount</small><b>{fmt(totals.gst)}</b></div></div>
   <div className="net"><span><Wallet/></span><div><small>Net Amount</small><b>{fmt(totals.net)}</b></div></div>
  </footer>
 </div>
}
