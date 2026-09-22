'use client'
import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, CupSoda, Eye, House, Pencil, Pill, Plus, RefreshCw, Search, ShoppingBag, Tag, Trash2, X, type LucideIcon } from 'lucide-react'

type Sub={ id:string; name:string; visible:boolean }
type Main={ id:string; name:string; icon:string; visible:boolean; subs:Sub[] }

const icons:Record<string,LucideIcon>={cup:CupSoda,bag:ShoppingBag,house:House,pill:Pill,tag:Tag}
const seed:Main[]=[
 {id:'MC-001',name:'Beverages',icon:'cup',visible:true,subs:[{id:'ST-001',name:'Soft Drinks',visible:true},{id:'ST-002',name:'Juices',visible:true},{id:'ST-003',name:'Water',visible:true}]},
 {id:'MC-002',name:'Snacks',icon:'bag',visible:true,subs:[{id:'ST-004',name:'Chips',visible:true},{id:'ST-005',name:'Biscuits',visible:true}]},
 {id:'MC-003',name:'Household',icon:'house',visible:true,subs:[{id:'ST-006',name:'Cleaning',visible:true},{id:'ST-007',name:'Kitchen',visible:false}]},
]

function Toggle({on,onChange,label}:{on:boolean;onChange:()=>void;label?:string}){
 return <label className="pc-toggle" onClick={e=>e.stopPropagation()}><input type="checkbox" checked={on} onChange={onChange} aria-label={label}/><i/><span>{on?'Visible':'Hidden'}</span></label>
}

export function ProductClasses(){
 const [mains,setMains]=useState<Main[]>(seed)
 const [open,setOpen]=useState<Set<string>>(new Set(['MC-001','MC-002']))
 const [q,setQ]=useState('')
 const [mainId,setMainId]=useState('')
 const [vis,setVis]=useState('All Visibility')
 const [modal,setModal]=useState<null|{kind:'main'}|{kind:'sub';parent?:string}|{kind:'editSub';parent:string;sub:Sub}>(null)
 const [name,setName]=useState('')
 const [parent,setParent]=useState('')

 const toggleOpen=(id:string)=>setOpen(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n})
 const setMainVis=(id:string)=>setMains(ms=>ms.map(m=>m.id===id?{...m,visible:!m.visible}:m))
 const setSubVis=(mid:string,sid:string)=>setMains(ms=>ms.map(m=>m.id===mid?{...m,subs:m.subs.map(s=>s.id===sid?{...s,visible:!s.visible}:s)}:m))
 const removeSub=(mid:string,sid:string)=>setMains(ms=>ms.map(m=>m.id===mid?{...m,subs:m.subs.filter(s=>s.id!==sid)}:m))
 const reset=()=>{setQ('');setMainId('');setVis('All Visibility')}

 const nextMain=()=>`MC-${String(mains.length+1).padStart(3,'0')}`
 const nextSub=()=>`ST-${String(mains.reduce((a,m)=>a+m.subs.length,0)+1).padStart(3,'0')}`
 const openModal=(m:typeof modal)=>{setModal(m);setName(m&&m.kind==='editSub'?m.sub.name:'');setParent(m&&(m.kind==='sub'||m.kind==='editSub')?(m.parent??mains[0]?.id??''):'')}
 const save=()=>{
  if(!modal||!name.trim())return
  if(modal.kind==='main')setMains(ms=>[...ms,{id:nextMain(),name:name.trim(),icon:'tag',visible:true,subs:[]}])
  else if(modal.kind==='sub'){const id=nextSub();setMains(ms=>ms.map(m=>m.id===parent?{...m,subs:[...m.subs,{id,name:name.trim(),visible:true}]}:m));setOpen(s=>new Set(s).add(parent))}
  else setMains(ms=>ms.map(m=>m.id===modal.parent?{...m,subs:m.subs.map(s=>s.id===modal.sub.id?{...s,name:name.trim()}:s)}:m))
  setModal(null)
 }

 const ql=q.trim().toLowerCase()
 const shown=mains.filter(m=>(!mainId||m.id===mainId)&&(vis==='All Visibility'||(vis==='Visible')===m.visible)&&(!ql||m.name.toLowerCase().includes(ql)||m.id.toLowerCase().includes(ql)||m.subs.some(s=>s.name.toLowerCase().includes(ql)||s.id.toLowerCase().includes(ql))))

 return <div className="pc-page">
  <header className="pc-head">
   <span className="pc-head-ico"><Tag/></span>
   <div><h1>Product Classes</h1><p>Manage main classes and their sub types.</p></div>
   <div className="pc-head-btns">
    <button type="button" className="pc-btn soft" onClick={()=>openModal({kind:'main'})}><Plus/>Add Main Class</button>
    <button type="button" className="pc-btn solid" onClick={()=>openModal({kind:'sub'})}><Plus/>Add Sub Type</button>
   </div>
  </header>

  <div className="pc-filters">
   <label className="pc-in"><Search/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search class name, ID..."/></label>
   <label className="pc-in sel"><Tag/><select value={mainId} onChange={e=>setMainId(e.target.value)}><option value="">Main ID</option>{mains.map(m=><option key={m.id} value={m.id}>{m.id} — {m.name}</option>)}</select><ChevronDown className="chev"/></label>
   <label className="pc-in sel"><Eye/><select value={vis} onChange={e=>setVis(e.target.value)}><option>All Visibility</option><option>Visible</option><option>Hidden</option></select><ChevronDown className="chev"/></label>
   <button type="button" className="pc-btn soft" onClick={reset}><RefreshCw/>Reset</button>
  </div>

  {shown.map(m=>{const Icon=icons[m.icon]??Tag;const isOpen=open.has(m.id)
   return <section className="pc-card" key={m.id}>
    <button type="button" className="pc-main" onClick={()=>toggleOpen(m.id)} aria-expanded={isOpen}>
     <span className="pc-main-ico"><Icon/></span>
     <span className="pc-meta"><small>Main ID</small><b>{m.id}</b></span>
     <span className="pc-meta"><small>Main Class Name</small><b>{m.name}</b></span>
     <span className="pc-meta"><small>Sub Types</small><b className="light">{m.subs.length} sub type{m.subs.length===1?'':'s'}</b></span>
     <span className="pc-main-right"><Toggle on={m.visible} onChange={()=>setMainVis(m.id)} label={`${m.name} visibility`}/>{isOpen?<ChevronUp/>:<ChevronDown/>}</span>
    </button>
    {isOpen&&<div className="pc-sub-wrap"><table className="pc-table">
     <thead><tr><th>Sub ID</th><th>Sub Type Name</th><th>Parent Main ID</th><th>Visibility</th><th className="act">Actions</th></tr></thead>
     <tbody>
      {m.subs.map(s=><tr key={s.id}>
       <td>{s.id}</td><td>{s.name}</td><td>{m.id}</td>
       <td><Toggle on={s.visible} onChange={()=>setSubVis(m.id,s.id)} label={`${s.name} visibility`}/></td>
       <td className="act"><button type="button" aria-label={`Edit ${s.name}`} onClick={()=>openModal({kind:'editSub',parent:m.id,sub:s})}><Pencil/></button><button type="button" aria-label={`Delete ${s.name}`} onClick={()=>removeSub(m.id,s.id)}><Trash2/></button></td>
      </tr>)}
      {!m.subs.length&&<tr><td colSpan={5} className="pc-empty">No sub types yet. <button type="button" onClick={()=>openModal({kind:'sub',parent:m.id})}>Add one</button></td></tr>}
     </tbody>
    </table></div>}
   </section>})}
  {!shown.length&&<div className="pc-card pc-none">No classes match your filters.</div>}

  {modal&&<div className="pc-overlay" onMouseDown={e=>e.target===e.currentTarget&&setModal(null)}>
   <div className="pc-modal" role="dialog" aria-modal="true">
    <div className="pc-modal-head"><h2>{modal.kind==='main'?'Add Main Class':modal.kind==='sub'?'Add Sub Type':'Edit Sub Type'}</h2><button type="button" aria-label="Close" onClick={()=>setModal(null)}><X/></button></div>
    <div className="pc-modal-body">
     {modal.kind!=='main'&&<label className="pc-fld"><span>Parent Main Class</span><span className="pc-in sel"><Tag/><select value={parent} disabled={modal.kind==='editSub'} onChange={e=>setParent(e.target.value)}>{mains.map(m=><option key={m.id} value={m.id}>{m.id} — {m.name}</option>)}</select><ChevronDown className="chev"/></span></label>}
     <label className="pc-fld"><span>{modal.kind==='main'?'Main Class Name':'Sub Type Name'}</span><span className="pc-in"><input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&save()} placeholder={modal.kind==='main'?'e.g. Beverages':'e.g. Soft Drinks'}/></span></label>
     <p className="pc-hint">ID will be assigned automatically: <b>{modal.kind==='main'?nextMain():modal.kind==='sub'?nextSub():modal.sub.id}</b></p>
    </div>
    <div className="pc-modal-foot"><button type="button" className="pc-btn ghost" onClick={()=>setModal(null)}>Cancel</button><button type="button" className="pc-btn solid" onClick={save} disabled={!name.trim()}><Check/>Save</button></div>
   </div>
  </div>}
 </div>
}
