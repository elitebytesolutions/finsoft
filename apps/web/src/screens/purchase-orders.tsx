'use client'
import { useMemo, useState, type DragEvent } from 'react'
import { useNavigate } from '@/lib/router'
import { Ban, CalendarDays, Check, CircleAlert, CircleCheck, Clock3, Ellipsis, FileText, Filter, GripVertical, Hourglass, PackageCheck, Plus, Search, ShoppingCart, X } from 'lucide-react'
import type { PurchaseOrder, PurchaseOrderLine } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Status=PurchaseOrder['status']
type Props={data:AppData;onAddPO:(p:PurchaseOrder)=>void;onPatchPO:(id:string,patch:Partial<PurchaseOrder>)=>void;onConvert:(id:string)=>void;canCreate:boolean}
const columns:{key:Status;label:string;icon:typeof FileText;tone:string}[]=[
 {key:'Draft',label:'Draft',icon:FileText,tone:'draft'},
 {key:'Pending',label:'Pending',icon:Hourglass,tone:'pending'},
 {key:'Approved',label:'Approved',icon:CircleCheck,tone:'approved'},
 {key:'Received',label:'Received',icon:PackageCheck,tone:'received'},
 {key:'Cancelled',label:'Cancelled',icon:Ban,tone:'cancelled'},
]
const pkr=(n:number)=>'PKR '+n.toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2})
const initials=(n:string)=>n.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()
const flagIcon=(f:string)=>f==='Urgent'?CircleAlert:f==='Due Today'?Clock3:CircleCheck
const iso=(d:string)=>{const [a,b,c]=d.split('-');return c?`${c}-${b}-${a}`:d}

export function PurchaseOrders({data,onAddPO,onPatchPO,onConvert,canCreate}:Props){
 const navigate=useNavigate()
 const [query,setQuery]=useState(''),[listQuery,setListQuery]=useState('')
 const [chip,setChip]=useState<'All'|Status>('All')
 const [from,setFrom]=useState('2026-09-01'),[to,setTo]=useState('2026-09-30')
 const [picked,setPicked]=useState<string[]>([])
 const [page,setPage]=useState(1),size=10
 const [drag,setDrag]=useState<string|null>(null),[over,setOver]=useState<Status|null>(null)
 const [open,setOpen]=useState(false),[toast,setToast]=useState('')
 const [supplier,setSupplier]=useState('Getz Pharma'),[expected,setExpected]=useState('2026-09-30')
 const [lines,setLines]=useState<PurchaseOrderLine[]>([{product:data.products[0].name,qty:10,cost:data.products[0].cost}])

 const pos=data.pos
 const matches=(p:PurchaseOrder,q:string)=>`${p.id} ${p.supplier} ${p.date} ${p.lines.map(l=>l.product).join(' ')}`.toLowerCase().includes(q.toLowerCase())
 const board=useMemo(()=>pos.filter(p=>matches(p,query)),[pos,query])
 const counts=useMemo(()=>Object.fromEntries(columns.map(c=>[c.key,pos.filter(p=>p.status===c.key).length])) as Record<Status,number>,[pos])
 const listRows=useMemo(()=>pos.filter(p=>(chip==='All'||p.status===chip)&&matches(p,listQuery)),[pos,chip,listQuery])
 const pages=Math.max(1,Math.ceil(listRows.length/size)),cur=Math.min(page,pages),slice=listRows.slice((cur-1)*size,cur*size)
 const total=pos.length, pct=(n:number)=>total?`${((n/total)*100).toFixed(1)}%`:'0%'

 const drop=(status:Status)=>{setOver(null);if(!drag)return;const po=pos.find(p=>p.id===drag);setDrag(null);if(!po||po.status===status)return
  if(status==='Received'&&po.status!=='Received'){onConvert(po.id);setToast(`${po.id} received — stock and payable posted`);return}
  onPatchPO(po.id,{status});setToast(`${po.id} moved to ${status}`)}
 const suppliers=[...new Set([...data.masters.filter(m=>m.type==='Supplier').map(m=>m.name),...data.purchases.map(p=>p.supplier)])]
 const setL=(i:number,p:Partial<PurchaseOrderLine>)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,...p}:l))
 const pick=(i:number,name:string)=>{const pr=data.products.find(x=>x.name===name);setL(i,{product:name,cost:pr?.cost??0})}
 const amount=lines.reduce((a,l)=>a+(Number(l.qty)||0)*(Number(l.cost)||0),0)
 const save=()=>{if(!lines.some(l=>Number(l.qty)>0))return
  const n=Math.max(48,...pos.map(p=>parseInt(p.id.replace(/\D/g,''),10)||0))+1
  const id=`PO-${String(n).padStart(5,'0')}`
  onAddPO({id,date:new Date().toLocaleDateString('en-GB').replace(/\//g,'-'),supplier,expected,lines:lines.map(l=>({...l,qty:Number(l.qty)||0,cost:Number(l.cost)||0})),amount,status:'Draft',owner:'Saim Javed'})
  setOpen(false);setToast(`${id} created as draft`)}

 const card=(p:PurchaseOrder)=>{const Flag=p.flag?flagIcon(p.flag):null
  return <article key={p.id} className={`po-card ${drag===p.id?'dragging':''}`} draggable onDragStart={()=>setDrag(p.id)} onDragEnd={()=>{setDrag(null);setOver(null)}}>
   <div className="po-card-top"><b>{p.id}</b>{p.flag&&<span className={`po-flag ${p.flag.toLowerCase().replace(/ /g,'-')}`}>{Flag&&<Flag/>}{p.flag}</span>}{p.partial&&<span className="po-flag partial">Partially Received</span>}<button className="po-grip" aria-label={`Options for ${p.id}`}><GripVertical/></button></div>
   <h4>{p.supplier}</h4>
   <p className="po-date"><CalendarDays/>{p.date}</p>
   <p className="po-items">{p.lines.length} items</p>
   <b className="po-amt">{pkr(p.amount)}</b>
   <footer><span className="po-av">{initials(p.owner??'Saim Javed')}</span><small>{p.owner??'Saim Javed'}</small><span className={`po-pill ${p.status.toLowerCase()}`}>{p.status}</span></footer>
  </article>}

 return <div className="po-page">
  <header className="po-head">
   <span className="po-head-ico"><ShoppingCart/></span>
   <div><h1>Purchase Orders</h1><p>Create and manage purchase orders to your suppliers</p></div>
   <div className="po-kpis">
    <div className="po-kpi"><span className="k-total"><FileText/></span><div><small>Total POs</small><b>{total}</b><em className="up">+12% this month</em></div></div>
    {columns.map(c=>{const I=c.icon;return <div className="po-kpi" key={c.key}><span className={`k-${c.tone}`}><I/></span><div><small>{c.label}</small><b>{counts[c.key]}</b><em>{pct(counts[c.key])}</em></div></div>})}
   </div>
  </header>
  {toast&&<div className="po-toast" role="status"><Check/>{toast}<button aria-label="Dismiss" onClick={()=>setToast('')}><X/></button></div>}

  <div className="po-bar">
   <label className="po-search big"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search PO No., supplier, product or date..."/></label>
   <span className="po-range"><CalendarDays/><input type="date" aria-label="From date" value={from} onChange={e=>setFrom(e.target.value)}/><i>→</i><input type="date" aria-label="To date" value={to} onChange={e=>setTo(e.target.value)}/></span>
   <button className="po-btn"><Filter/> Filters</button>
   <button className="po-btn solid" disabled={!canCreate} onClick={()=>setOpen(true)}><Plus/> New Purchase Order</button>
  </div>

  <div className="po-body">
   <aside className="po-list">
    <div className="po-list-head"><span className="po-list-ico"><FileText/></span><div><h2>Search &amp; Listing</h2><p>Search, filter and select purchase orders</p></div><button className="po-grip" aria-label="List options"><GripVertical/></button></div>
    <label className="po-search"><Search/><input value={listQuery} onChange={e=>{setListQuery(e.target.value);setPage(1)}} placeholder="Search POs..."/></label>
    <div className="po-chips">{([['All',total],...columns.map(c=>[c.label,counts[c.key]] as [string,number])] as [string,number][]).map(([l,n])=><button key={l} className={chip===l?'on':''} onClick={()=>{setChip(l as 'All'|Status);setPage(1)}}>{l} ({n})</button>)}</div>
    <div className="po-table-wrap"><table className="po-table">
     <thead><tr><th><input type="checkbox" aria-label="Select all" checked={!!slice.length&&slice.every(p=>picked.includes(p.id))} onChange={e=>setPicked(e.target.checked?[...new Set([...picked,...slice.map(p=>p.id)])]:picked.filter(id=>!slice.some(p=>p.id===id)))}/></th><th>PO No.</th><th>Supplier</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
     <tbody>{slice.map(p=><tr key={p.id} className={picked.includes(p.id)?'on':''}>
      <td><input type="checkbox" aria-label={`Select ${p.id}`} checked={picked.includes(p.id)} onChange={()=>setPicked(s=>s.includes(p.id)?s.filter(x=>x!==p.id):[...s,p.id])}/></td>
      <td><b>{p.id}</b></td><td>{p.supplier}</td><td>{p.date}</td><td className="num">{pkr(p.amount).replace('PKR ','PKR ')}</td>
      <td><span className={`po-pill ${p.status.toLowerCase()}`}>{p.status}</span></td></tr>)}
      {!slice.length&&<tr><td colSpan={6}><div className="po-empty">No purchase orders match your search.</div></td></tr>}
     </tbody></table></div>
    <div className="po-list-foot"><span>Showing {listRows.length?(cur-1)*size+1:0} to {Math.min(cur*size,listRows.length)} of {listRows.length} entries</span>
     <div className="po-pager"><button aria-label="Previous page" disabled={cur===1} onClick={()=>setPage(cur-1)}>‹</button>{Array.from({length:Math.min(5,pages)},(_,i)=>i+1).map(n=><button key={n} className={n===cur?'on':''} onClick={()=>setPage(n)}>{n}</button>)}<button aria-label="Next page" disabled={cur===pages} onClick={()=>setPage(cur+1)}>›</button></div></div>
   </aside>

   <div className="po-board">{columns.map(c=>{const I=c.icon;const items=board.filter(p=>p.status===c.key)
    return <section key={c.key} className={`po-col ${c.tone} ${over===c.key?'over':''}`} onDragOver={e=>{e.preventDefault();setOver(c.key)}} onDragLeave={()=>setOver(o=>o===c.key?null:o)} onDrop={(e:DragEvent)=>{e.preventDefault();drop(c.key)}}>
     <header className="po-col-head"><I/><b>{c.label} ({counts[c.key]})</b><button className="po-grip" aria-label={`${c.label} column options`}><Ellipsis/></button></header>
     <div className="po-col-body">{items.map(card)}
      <div className="po-drop"><Plus/><span>Drop here to move<br/>to {c.label}</span></div>
     </div>
    </section>})}</div>
  </div>

  {open&&<div className="po-modal-wrap" role="dialog" aria-label="New purchase order" onClick={e=>e.target===e.currentTarget&&setOpen(false)}>
   <div className="po-modal">
    <header><h2>New Purchase Order</h2><button aria-label="Close" onClick={()=>setOpen(false)}><X/></button></header>
    <div className="po-modal-grid">
     <label>Supplier<select value={supplier} onChange={e=>setSupplier(e.target.value)}>{suppliers.map(s=><option key={s}>{s}</option>)}</select></label>
     <label>Expected delivery<input type="date" value={iso(expected)} onChange={e=>setExpected(e.target.value)}/></label>
    </div>
    <div className="po-modal-lines">
     <div className="po-line head"><span>Product</span><span>Qty</span><span>Cost</span><span/></div>
     {lines.map((l,i)=><div className="po-line" key={i}>
      <select aria-label={`Product ${i+1}`} value={l.product} onChange={e=>pick(i,e.target.value)}>{data.products.map(p=><option key={p.id}>{p.name}</option>)}</select>
      <input aria-label={`Qty ${i+1}`} type="number" min={1} value={l.qty} onChange={e=>setL(i,{qty:Number(e.target.value)})}/>
      <input aria-label={`Cost ${i+1}`} type="number" min={0} value={l.cost} onChange={e=>setL(i,{cost:Number(e.target.value)})}/>
      <button aria-label={`Remove line ${i+1}`} onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))}><X/></button></div>)}
     <button className="po-btn" onClick={()=>setLines(ls=>[...ls,{product:data.products[0].name,qty:1,cost:data.products[0].cost}])}><Plus/> Add line</button>
    </div>
    <footer><span>Order value <b>{pkr(amount)}</b></span><button className="po-btn" onClick={()=>setOpen(false)}>Cancel</button><button className="po-btn solid" onClick={save}><Check/> Save order</button></footer>
   </div>
  </div>}
  <button hidden onClick={()=>navigate('/procurement')}>Demand list</button>
 </div>
}
