'use client'
import { useMemo, useState } from 'react'
import { ArrowRight, Barcode, Boxes, Building2, Calendar, CalendarDays, Check, ChevronDown, ChevronRight, CircleDollarSign, FileText, History, Layers, Leaf, MapPin, Package, PackagePlus, Plus, Printer, ScanLine, Search, Send, Store, Trash2, Truck, UserRound, Warehouse, Wallet } from 'lucide-react'
import type { Product, StockMovement } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Location={name:string;kind:'Warehouse'|'Shop';address:string;stock:number;active:number}
const locations:Location[]=[
 {name:'Main Warehouse',kind:'Warehouse',address:'123 Industrial Estate, Lahore',stock:12450,active:1250},
 {name:'Karachi Warehouse',kind:'Warehouse',address:'SITE Area, Karachi',stock:8120,active:940},
 {name:'Shop DHA',kind:'Shop',address:'Phase 6, DHA, Lahore',stock:3210,active:980},
 {name:'Shop Johar Town',kind:'Shop',address:'Block G, Johar Town, Lahore',stock:2740,active:860},
]
type Line={product:Product;batchId:string;qty:number;loose:number;narcotic:boolean}
const recent=[
 {id:'TR-000123',route:'Warehouse → Shop DHA',items:120,value:22560,date:'14 Sep 2026',time:'10:24 AM',status:'Draft'},
 {id:'TR-000122',route:'Shop → Warehouse',items:75,value:18750,date:'12 Sep 2026',time:'02:15 PM',status:'Posted'},
 {id:'TR-000121',route:'Warehouse → Shop Johar Town',items:200,value:34000,date:'10 Sep 2026',time:'11:40 AM',status:'Posted'},
 {id:'TR-000120',route:'Shop → Warehouse',items:50,value:9600,date:'08 Sep 2026',time:'04:22 PM',status:'Pending'},
 {id:'TR-000119',route:'Warehouse → Shop DHA',items:95,value:16150,date:'05 Sep 2026',time:'12:10 PM',status:'Posted'},
]
const rs=(n:number)=>'Rs. '+n.toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2})
const code=(p:Product)=>p.name.split(' ')[0].slice(0,3).toUpperCase()+'-'+(p.name.match(/\d+/)?.[0]??p.id.slice(-3))
const expiryLabel=(iso:string)=>new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB',{month:'short',year:'numeric'})
const isNarcotic=(p:Product)=>/opioid|sedat|narc|tramadol|codeine/i.test(`${p.category} ${p.generic}`)
const ean=(i:number)=>`8961100${String(12345+i*54546).padStart(5,'0')}`

/* ---------- inline illustrations (warehouse / shop / truck) ---------- */
function WarehouseArt(){return <svg viewBox="0 0 200 150" aria-hidden="true" className="st-art"><ellipse cx="100" cy="132" rx="92" ry="12" fill="#d9ebe0"/><path d="M28 62 L100 28 L172 62 V122 H28 Z" fill="#f2f4f3" stroke="#c9d6ce"/><path d="M22 64 L100 26 L178 64 L172 70 L100 36 L28 70 Z" fill="#1f8a4c"/><rect x="82" y="80" width="36" height="42" fill="#3d4a55"/><rect x="86" y="84" width="28" height="34" fill="#8fa6b8"/><rect x="40" y="76" width="22" height="16" fill="#c9d6ce"/><rect x="138" y="76" width="22" height="16" fill="#c9d6ce"/><rect x="150" y="104" width="18" height="18" fill="#d4a462"/><rect x="132" y="104" width="18" height="18" fill="#e0b271"/><rect x="141" y="86" width="18" height="18" fill="#d4a462"/><rect x="30" y="112" width="30" height="10" fill="#1f8a4c"/><rect x="36" y="96" width="10" height="16" fill="#1f8a4c"/><circle cx="36" cy="126" r="5" fill="#3d4a55"/><circle cx="56" cy="126" r="5" fill="#3d4a55"/></svg>}
function ShopArt(){return <svg viewBox="0 0 200 150" aria-hidden="true" className="st-art"><ellipse cx="100" cy="132" rx="92" ry="12" fill="#d9ebe0"/><rect x="34" y="56" width="132" height="66" fill="#f2f4f3" stroke="#c9d6ce"/><rect x="60" y="32" width="80" height="20" rx="3" fill="#1f8a4c"/><text x="100" y="47" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Inter,sans-serif">SHOP</text><path d="M28 58 H172 L164 78 H36 Z" fill="#1f8a4c"/><path d="M45 58 L52 78 M62 58 L69 78 M79 58 L86 78 M96 58 L103 78 M113 58 L120 78 M130 58 L137 78 M147 58 L154 78" stroke="#fff" strokeWidth="6"/><rect x="86" y="84" width="28" height="38" fill="#3d4a55"/><rect x="90" y="88" width="20" height="30" fill="#8fa6b8"/><rect x="44" y="86" width="30" height="24" fill="#8fa6b8" stroke="#c9d6ce"/><rect x="126" y="86" width="30" height="24" fill="#8fa6b8" stroke="#c9d6ce"/><rect x="150" y="106" width="16" height="16" fill="#d4a462"/><rect x="36" y="106" width="16" height="16" fill="#e0b271"/><circle cx="24" cy="100" r="12" fill="#5fb277"/><rect x="22" y="108" width="4" height="14" fill="#6b5a3a"/><circle cx="178" cy="98" r="14" fill="#5fb277"/><rect x="176" y="108" width="4" height="14" fill="#6b5a3a"/></svg>}
function TruckArt(){return <svg viewBox="0 0 120 70" aria-hidden="true" className="st-truck-art"><rect x="6" y="14" width="66" height="38" rx="3" fill="#1f8a4c"/><path d="M72 26 H96 L110 40 V52 H72 Z" fill="#1f8a4c"/><rect x="78" y="30" width="16" height="12" rx="2" fill="#cfe8d7"/><rect x="6" y="52" width="104" height="4" fill="#166b3c"/><circle cx="26" cy="58" r="8" fill="#2b3640"/><circle cx="26" cy="58" r="3.5" fill="#9aa5ad"/><circle cx="92" cy="58" r="8" fill="#2b3640"/><circle cx="92" cy="58" r="3.5" fill="#9aa5ad"/></svg>}

function LocationCard({side,loc,onPick}:{side:'From'|'To';loc:Location;onPick:(name:string)=>void}){
 const Kind=loc.kind==='Warehouse'?Warehouse:Store
 return <section className={`st-loc ${side==='From'?'from':'to'}`}>
  <div className="st-loc-top"><div className="st-loc-art">{loc.kind==='Warehouse'?<WarehouseArt/>:<ShopArt/>}</div>
   <div className="st-loc-main"><span className="st-chip">{side}</span><label className="st-loc-pick"><b>{loc.name}</b><ChevronDown/><select aria-label={`${side} location`} value={loc.name} onChange={e=>onPick(e.target.value)}>{locations.map(l=><option key={l.name}>{l.name}</option>)}</select></label><small>{side==='From'?'Source':'Destination'} Location</small><p><span><MapPin/></span>{loc.address}</p></div>
   <span className={`st-kind ${loc.kind.toLowerCase()}`}><Kind/>{loc.kind}</span></div>
  <div className="st-loc-stats"><div><span><Boxes/></span><div><small>Current Stock</small><b>{loc.stock.toLocaleString()} <em>items</em></b></div></div><div><span><Building2/></span><div><small>Location Type</small><b>{loc.kind}</b></div></div><div><span><Layers/></span><div><small>Active Products</small><b>{loc.active.toLocaleString()}</b></div></div></div>
 </section>
}

export function StockTransferPage({data,onPost}:{data:AppData;onPost:(m:StockMovement)=>void}){
 const [from,setFrom]=useState('Main Warehouse'),[to,setTo]=useState('Shop DHA')
 const [remarks,setRemarks]=useState(''),[query,setQuery]=useState('')
 const [lines,setLines]=useState<Line[]>(()=>data.products.slice(0,3).map((p,i)=>({product:p,batchId:p.batches[0].id,qty:Math.min([50,40,30][i]??10,p.batches[0].stock),loose:0,narcotic:isNarcotic(p)})))
 const [posted,setPosted]=useState<{ref:string;draft:boolean}|null>(null)
 const src=locations.find(l=>l.name===from)!,dst=locations.find(l=>l.name===to)!
 const ref='TR-000124'
 const rows=lines.map(l=>{const b=l.product.batches.find(x=>x.id===l.batchId)??l.product.batches[0];return {...l,batch:b,value:l.qty*b.cost}})
 const totals={items:rows.length,qty:rows.reduce((a,r)=>a+r.qty,0),loose:rows.reduce((a,r)=>a+r.loose,0),value:rows.reduce((a,r)=>a+r.value,0)}
 const patch=(i:number,p:Partial<Line>)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,...p}:l))
 const remove=(i:number)=>setLines(ls=>ls.filter((_,j)=>j!==i))
 const suggestions=useMemo(()=>query?data.products.filter(p=>`${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase())&&!lines.some(l=>l.product.id===p.id)).slice(0,5):[],[query,data.products,lines])
 const add=(p:Product)=>{setLines(ls=>[...ls,{product:p,batchId:p.batches[0].id,qty:1,loose:0,narcotic:isNarcotic(p)}]);setQuery('')}
 const invalid=from===to||!rows.length||rows.some(r=>r.qty<1||r.qty>r.batch.stock)
 const post=(draft:boolean)=>{if(invalid)return;if(!draft)rows.forEach((r,i)=>onPost({id:`MOV-${Date.now()}-${i}`,date:'14 Sep 2026',product:r.product.name,batch:r.batch.id,type:'Transfer',qty:-r.qty,reference:ref,from,to,note:remarks||`Transfer from ${from} to ${to}`}));setPosted({ref,draft})}

 if(posted)return <div className="st-page"><div className="st-done"><span><Check/></span><h2>{posted.draft?'Draft saved':'Transfer posted'}</h2><p>{posted.ref} · {from} → {to} · {totals.qty} units · {rs(totals.value)}</p><button className="st-btn primary" onClick={()=>setPosted(null)}><Plus/> New transfer</button></div></div>

 return <div className="st-page">
  <div className="st-head">
   <div className="st-title"><span className="st-title-ico"><Package/></span><div><h1>Stock transfer</h1><p>Move stock between your warehouses and shops</p></div></div>
   <div className="st-meta">
    <label><span>Transfer No.</span><div className="st-field ro"><b>{ref}</b><FileText/></div></label>
    <label><span>Date &amp; Time</span><div className="st-field"><CalendarDays/><b>14 Sep 2026 10:24 AM</b></div></label>
    <label><span>Prepared By</span><div className="st-field"><UserRound/><select defaultValue="Saim Javed" aria-label="Prepared by"><option>Saim Javed</option><option>Ahmed Raza</option><option>Usman Ali</option></select><ChevronDown/></div></label>
    <label className="grow"><span>Remarks (Optional)</span><div className="st-field"><input value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="e.g. Replenishment for DHA shop"/></div></label>
   </div>
   <div className="st-head-actions"><button className="st-btn ghost" onClick={()=>post(true)} disabled={invalid}><FileText/> Save Draft</button><button className="st-btn primary" onClick={()=>post(false)} disabled={invalid}><Send/> Save &amp; Post</button></div>
  </div>

  <div className="st-route">
   <LocationCard side="From" loc={src} onPick={setFrom}/>
   <div className="st-truck"><div className="st-track"><i/><TruckArt/><ArrowRight/></div><b>Transfering Stock</b><small>From {src.kind} to {dst.kind}</small>{from===to&&<em>Source and destination must differ</em>}</div>
   <LocationCard side="To" loc={dst} onPick={setTo}/>
  </div>

  <div className="st-body">
   <section className="st-panel st-manifest">
    <div className="st-manifest-head">
     <span className="st-panel-ico"><Package/></span><div><h2>Transfer Manifest</h2><p>Add products to transfer from the source to destination</p></div>
     <div className="st-manifest-tools"><button className="st-btn outline" onClick={()=>document.getElementById('st-search')?.focus()}><Plus/> Add Product</button><label className="st-search"><Search/><input id="st-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search product by code or name..."/>{suggestions.length>0&&<div className="st-suggest">{suggestions.map(p=><button key={p.id} type="button" onClick={()=>add(p)}><b>{code(p)}</b> {p.name}<small>{p.stock} in stock</small></button>)}</div>}</label><button className="st-btn outline"><ScanLine/> Scan</button></div>
    </div>
    <div className="st-lines">
     {rows.map((r,i)=><article className="st-line" key={r.product.id}>
      <span className="st-no">{i+1}</span>
      <div className="st-thumb"><Package/></div>
      <div className="st-prod"><b>{code(r.product)}</b><span>{r.product.name}</span>
       <div className="st-prod-meta"><div><small>Batch</small><label className="st-batch"><select aria-label={`Batch ${r.product.name}`} value={r.batchId} onChange={e=>patch(i,{batchId:e.target.value})}>{r.product.batches.map(b=><option key={b.id}>{b.id}</option>)}</select></label></div><div><small>Expiry</small><b><Calendar/> {expiryLabel(r.batch.expiry)}</b></div><div><small>Company</small><b title={r.product.supplier}>{r.product.supplier.replace(/ (Pharma|Pharmaceuticals|Laboratories|Labs|Company|Ltd\.?|Limited|Pakistan)\b.*$/i,'').split(' ')[0].slice(0,10)}</b></div></div>
      </div>
      <div className="st-nums">
       <div><small>Available</small><b>{r.batch.stock.toLocaleString()}</b></div>
       <div><small>Transfer Qty</small><input aria-label={`Transfer quantity ${r.product.name}`} type="number" min={1} max={r.batch.stock} value={r.qty} className={r.qty>r.batch.stock?'bad':''} onChange={e=>patch(i,{qty:Number(e.target.value)})}/></div>
       <div><small>Loose Qty</small><input aria-label={`Loose quantity ${r.product.name}`} type="number" min={0} value={r.loose} onChange={e=>patch(i,{loose:Number(e.target.value)})}/></div>
       <div><small>Cost (Rs.)</small><output>{r.batch.cost.toFixed(2)}</output></div>
       <div><small>Value (Rs.)</small><output>{r.value.toLocaleString('en-PK',{minimumFractionDigits:2})}</output></div>
       <div className="st-line-foot"><span className="st-ean"><Barcode/>{ean(i)}</span><button type="button" role="switch" aria-checked={r.narcotic} className={`st-narc ${r.narcotic?'on':''}`} onClick={()=>patch(i,{narcotic:!r.narcotic})}><i/>{r.narcotic?'Narcotic':'Non Narcotic'}</button></div>
      </div>
      <button className="st-del" aria-label={`Remove ${r.product.name}`} onClick={()=>remove(i)}><Trash2/></button>
     </article>)}
     <button className="st-add-more" onClick={()=>document.getElementById('st-search')?.focus()}><span><Plus/></span><div><b>Add Another Product</b><small>Search or scan to add products to this transfer</small></div></button>
    </div>
   </section>

   <aside className="st-side">
    <section className="st-panel st-slip">
     <div className="st-side-head"><span className="st-panel-ico sm"><FileText/></span><h3>Transfer Slip Preview</h3><button className="st-btn outline sm" onClick={()=>window.print()}><Printer/> View / Print</button></div>
     <div className="st-slip-brand"><span><Leaf/></span><b>BHATTI TRADERS</b><small>Stock Transfer Slip</small></div>
     <dl className="st-slip-kv"><dt>Transfer No.</dt><dd>{ref}</dd><dt>Date &amp; Time</dt><dd>14 Sep 2026 &nbsp;10:24 AM</dd><dt>Prepared By</dt><dd>Saim Javed</dd></dl>
     <div className="st-slip-route"><p><span><Warehouse/></span><small>From</small><b>{from}</b></p><p><span><Store/></span><small>To</small><b>{to}</b></p></div>
     <div className="st-slip-tot"><span>Items: <b>{totals.items}</b></span><span>Total Qty: <b>{totals.qty}</b></span><span>Value: <b>{rs(totals.value)}</b></span></div>
    </section>
    <section className="st-panel st-recent">
     <div className="st-side-head"><span className="st-panel-ico sm"><History/></span><h3>Recent Transfers</h3><button className="st-btn outline sm">View All</button></div>
     {recent.map(t=><div className="st-recent-row" key={t.id}><i className={t.status.toLowerCase()}/><div><b>{t.id}</b><small><Store/>{t.route}</small><small>{t.items} items &nbsp;•&nbsp; {rs(t.value).replace('.00','')}</small></div><div className="st-recent-when">{t.date}<br/>{t.time}</div><span className={`st-status ${t.status.toLowerCase()}`}>{t.status}</span></div>)}
    </section>
   </aside>
  </div>

  <footer className="st-foot">
   <em className="st-foot-note"><Truck/>Transferring today<br/>for a stronger tomorrow.</em>
   <div className="st-foot-stats"><div><span><PackagePlus/></span><div><small>Total Items</small><b>{totals.items}</b></div></div><div><span><Boxes/></span><div><small>Total Quantity</small><b>{totals.qty}</b></div></div><div><span><Package/></span><div><small>Total Loose</small><b>{totals.loose}</b></div></div><div><span><CircleDollarSign/></span><div><small>Total Value</small><b>{rs(totals.value)}</b></div></div></div>
   <button className="st-btn primary big" onClick={()=>post(false)} disabled={invalid}><Check/> Save &amp; Post Transfer <ChevronRight className="tail"/></button>
   <em className="st-foot-note right"><Wallet/>Stock moves.<br/>Business grows.</em>
  </footer>
 </div>
}
