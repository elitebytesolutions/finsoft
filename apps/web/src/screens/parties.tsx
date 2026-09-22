'use client'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from '@/lib/router'
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { ArrowLeft, ArrowRight, BarChart3, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CirclePause, CircleUser, Clock3, Download, Ellipsis, Eye, FileText, Filter, Grid2x2, List, Mail, MapPin, MessageSquare, Pencil, Phone, Plus, Search, ShoppingCart, Store, Truck, User, UserRound, Users, Wallet, WalletCards, X } from 'lucide-react'
import type { Master } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { money } from '@finsoft/ui'
import storefrontAtlasImage from './assets/pharmacy-storefronts.jpg'
// Vite's static import is a URL string; Next's is a StaticImageData object.
// The body interpolates this into a CSS url(), so unwrap .src here and leave
// the usage site byte-identical to the prototype.
const storefrontAtlas = storefrontAtlasImage.src

type Kind='Customer'|'Vendor'
const masterType=(k:Kind)=>k==='Customer'?'Customer':'Supplier'
const initials=(name:string)=>name.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()

/* ───────────────── Listing ───────────────── */
export function PartyList({data,kind,onAdd,canCreate}:{data:AppData;kind:Kind;onAdd:(m:Master)=>void;canCreate:boolean}){
 const navigate=useNavigate()
 const [query,setQuery]=useState('')
 const [status,setStatus]=useState('All')
 const [city,setCity]=useState('All')
 const [tab,setTab]=useState('All')
 const [ptype,setPtype]=useState('All'),[secondary,setSecondary]=useState('All')
 const [view,setView]=useState<'grid'|'list'>('grid'),[sort,setSort]=useState('Name (A-Z)')
 const [page,setPage]=useState(1)
 const [size,setSize]=useState(kind==='Customer'?12:10)
 const [open,setOpen]=useState(false)
 const isCustomer=kind==='Customer'
 const all=data.masters.filter(m=>m.type===masterType(kind))
 const cities=[...new Set(all.map(m=>m.city).filter(c=>c&&c!=='—'))]
 const secondaryOptions=[...new Set(all.map(m=>isCustomer?m.extra?.area:m.extra?.creditDays).filter((value):value is string=>!!value))]
 const rows=all.filter(m=>(status==='All'||m.status===status)&&(city==='All'||m.city===city)&&(tab==='All'||m.status==='Active')&&(ptype==='All'||(m.extra?.partyType??(isCustomer?'Customer':'Supplier'))===ptype)&&(secondary==='All'||(isCustomer?m.extra?.area:m.extra?.creditDays)===secondary)&&`${m.code} ${m.name} ${m.contact} ${m.extra?.dealing??''} ${m.extra?.ntn??''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='Name (Z-A)'?b.name.localeCompare(a.name):sort==='Code'?a.code.localeCompare(b.code):a.name.localeCompare(b.name))
 const pages=Math.max(1,Math.ceil(rows.length/size)),current=Math.min(page,pages),slice=rows.slice((current-1)*size,current*size)
 const active=all.filter(m=>m.status==='Active').length
 const shops=all.filter(m=>m.extra?.partyType==='Shop').length
 const base=isCustomer?'/customers':'/vendors'
 const stats:[typeof Users,string,number,string,string][]=isCustomer
  ?[[Users,'Total Customers',all.length,'+12%','green'],[CircleCheck,'Active Customers',active,`${all.length?Math.round(active/all.length*100):0}% of total`,'green'],[CirclePause,'Inactive Customers',all.length-active,`${all.length?Math.round((all.length-active)/all.length*100):0}% of total`,'red'],[Store,'Shops',shops,`${all.length?Math.round(shops/all.length*100):0}% of total`,'green']]
  :[[Users,'Total Vendors',all.length,'+12%','green'],[CircleCheck,'Active Vendors',active,'+8%','green'],[UserRound,'Inactive Vendors',all.length-active,'+3%','red'],[WalletCards,'For Account Vendors',all.filter(m=>m.balance>0).length,'+15%','green']]
 const reset=()=>{setQuery('');setStatus('All');setCity('All');setPtype('All');setSecondary('All');setPage(1)}
 return <div className="pt">
  <div className="pt-head"><div><h1>{isCustomer?'Customers':'Vendors'}</h1><p>{isCustomer?'Manage your customers, shops and business accounts':'Manage your suppliers and business vendors'}</p></div><button className="pt-primary big" disabled={!canCreate} onClick={()=>setOpen(true)}><Plus/> New {kind}</button></div>
  <div className="pt-stats">{stats.map(([Icon,label,value,delta,tone])=><div key={label} className="pt-stat"><span className={`pt-stat-icon ${tone}`}><Icon/></span><div><small>{label}</small><div className="pt-stat-row"><b>{value}</b>{delta&&<span className={`pt-delta ${tone}`}>{delta.startsWith('+')&&<i>▲</i>}{delta}{delta.startsWith('+')&&<small>vs last month</small>}</span>}</div></div></div>)}</div>

  <section className={`pt-card pt-filters ${isCustomer?'pt-customer-filters':''}`}>
   {!isCustomer&&<div className="pt-tabs-pill"><button className={tab==='All'?'active':''} onClick={()=>setTab('All')}>All Vendors ({all.length})</button><button className={tab==='Active'?'active':''} onClick={()=>setTab('Active')}>Active Vendors ({active})</button></div>}
   <div className="pt-filter-grid">
    <label>Search<span className="pt-search"><Search/><input value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="Search by code, name or phone..."/></span></label>
    <label>{isCustomer?'Customer Type':'Vendor Type'}<select value={ptype} onChange={e=>{setPtype(e.target.value);setPage(1)}}><option>All</option>{isCustomer?<><option>Shop</option><option>Customer</option></>:<><option>Supplier</option><option>Manufacturer</option><option>Distributor</option></>}</select></label>
    <label>City<select value={city} onChange={e=>setCity(e.target.value)}><option value="All">All Cities</option>{cities.map(c=><option key={c}>{c}</option>)}</select></label>
    <label>{isCustomer?'Area':'Credit Days'}<select value={secondary} onChange={e=>{setSecondary(e.target.value);setPage(1)}}><option value="All">{isCustomer?'All Areas':'All'}</option>{secondaryOptions.map(value=><option key={value} value={value}>{isCustomer?value:`${value} days`}</option>)}</select></label>
    <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="All">All</option><option>Active</option><option>Inactive</option></select></label>
    <div className="pt-filter-actions"><button className="pt-primary" onClick={()=>setPage(1)}><Filter/> Apply Filters</button><button className="pt-ghost" onClick={reset}>Reset</button></div>
   </div>
  </section>

  {isCustomer&&<section className="pt-customer-results">
   <div className="pt-customer-result-head"><span>Showing {rows.length?(current-1)*size+1:0}–{Math.min(current*size,rows.length)} of {rows.length} customers</span><div className="pt-view-tools"><div className="pt-view-toggle"><button type="button" aria-label="Grid view" aria-pressed={view==='grid'} className={view==='grid'?'active':''} onClick={()=>setView('grid')}><Grid2x2/></button><button type="button" aria-label="List view" aria-pressed={view==='list'} className={view==='list'?'active':''} onClick={()=>setView('list')}><List/></button></div><label>Sort by<select value={sort} onChange={e=>{setSort(e.target.value);setPage(1)}}><option>Name (A-Z)</option><option>Name (Z-A)</option><option>Code</option></select></label></div></div>
   {view==='grid'?<div className="pt-customer-grid">{slice.map((m,i)=>{const x=m.extra??{},type=x.partyType??'Customer';return <article className="pt-customer-card" key={m.code}>
    <div className={`pt-customer-photo scene-${i%4}`} style={{backgroundImage:`linear-gradient(180deg,transparent 45%,rgba(8,31,20,.28)),url(${storefrontAtlas})`}}><span className={`pt-card-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span><i className="pt-store-label" data-name={m.name} aria-hidden="true"/></div>
    <div className="pt-customer-card-body"><div className="pt-customer-name"><div><h2>{m.name}</h2><p>{m.code}<span className={`pt-kind ${type==='Shop'?'shop':'customer'}`}>{type}</span></p></div><button type="button" aria-label={`More for ${m.name}`}><Ellipsis/></button></div>
     <span className="pt-customer-city"><MapPin/>{m.city}</span>
     <div className="pt-customer-terms"><div><Clock3/><span><b>{x.creditDays??'30'}</b><small>Credit Days</small></span></div><div><Wallet/><span><b>{x.creditLimit||'0'}</b><small>Discount Limit</small></span></div><button type="button" aria-label={`Open ${m.name}`} onClick={()=>navigate(`${base}/${m.code}`)}><ArrowRight/></button></div>
    </div></article>})}{!slice.length&&<div className="pt-card empty-state">No customers match these filters.</div>}</div>:<CustomerTable rows={slice} base={base} navigate={navigate}/>} 
   <div className="pt-customer-paging"><span>Showing {rows.length?(current-1)*size+1:0}–{Math.min(current*size,rows.length)} of {rows.length} customers</span><Pager page={current} pages={pages} onPage={setPage}/></div>
  </section>}

  {!isCustomer&&<section className="pt-card">
   <div className="pt-list-head"><h2>{isCustomer?'Customers':'Vendors'} ({rows.length})</h2><div className="pt-show">Show <select value={size} onChange={e=>{setSize(+e.target.value);setPage(1)}}>{[10,25,50].map(n=><option key={n}>{n}</option>)}</select> of {rows.length} records</div></div>
   <div className="table-wrap pt-table"><table><thead><tr><th>Code</th><th>{isCustomer?'Name':'Vendor Name'}</th><th>Type</th><th>Dealing Person</th><th>Phone</th><th>City</th><th>{isCustomer?'NTN #':'E-mail'}</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    {slice.map(m=><tr key={m.code}><td>{m.code}</td><td><button className="linkable" onClick={()=>navigate(`${base}/${m.code}`)}>{m.name}</button></td><td>{m.extra?.partyType??(isCustomer?'Customer':'Supplier')}</td><td>{m.extra?.dealing??'—'}</td><td>{m.contact}</td><td>{m.city}</td><td>{isCustomer?m.extra?.ntn??'—':m.extra?.email??'—'}</td><td><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span></td><td><div className="pt-row-actions"><button aria-label={`View ${m.name}`} onClick={()=>navigate(`${base}/${m.code}`)}><Eye/></button><button aria-label={`Edit ${m.name}`} onClick={()=>navigate(`${base}/${m.code}`)}><Pencil/></button><button aria-label={`More for ${m.name}`}><Ellipsis/></button></div></td></tr>)}
    {!slice.length&&<tr><td colSpan={9}><div className="empty-state">No {kind.toLowerCase()}s match these filters.</div></td></tr>}
   </tbody></table></div>
   <div className="pt-paging"><span>Showing {rows.length?(current-1)*size+1:0} to {Math.min(current*size,rows.length)} of {rows.length} records</span><Pager page={current} pages={pages} onPage={setPage}/></div>
  </section>}

  {open&&<PartyWizard kind={kind} existing={all} onClose={()=>setOpen(false)} onSave={m=>{onAdd(m);setOpen(false);navigate(`${base}/${m.code}`)}}/>}
 </div>
}

function CustomerTable({rows,base,navigate}:{rows:Master[];base:string;navigate:(path:string)=>void}){
 return <div className="pt-card pt-customer-list"><div className="table-wrap pt-table"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Dealing Person</th><th>Phone</th><th>City</th><th>NTN #</th><th>Status</th><th>Actions</th></tr></thead><tbody>
  {rows.map(m=><tr key={m.code}><td>{m.code}</td><td><button className="linkable" onClick={()=>navigate(`${base}/${m.code}`)}>{m.name}</button></td><td>{m.extra?.partyType??'Customer'}</td><td>{m.extra?.dealing??'—'}</td><td>{m.contact}</td><td>{m.city}</td><td>{m.extra?.ntn??'—'}</td><td><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span></td><td><div className="pt-row-actions"><button aria-label={`View ${m.name}`} onClick={()=>navigate(`${base}/${m.code}`)}><Eye/></button><button aria-label={`Edit ${m.name}`} onClick={()=>navigate(`${base}/${m.code}`)}><Pencil/></button><button aria-label={`More for ${m.name}`}><Ellipsis/></button></div></td></tr>)}
  {!rows.length&&<tr><td colSpan={9}><div className="empty-state">No customers match these filters.</div></td></tr>}
 </tbody></table></div></div>
}

function Pager({page,pages,onPage}:{page:number;pages:number;onPage:(p:number)=>void}){
 const nums=pages<=6?Array.from({length:pages},(_,i)=>i+1):[1,2,3,4,5,0,pages]
 return <div className="pt-pager"><button aria-label="Previous page" disabled={page===1} onClick={()=>onPage(page-1)}><ChevronLeft/></button>{nums.map((n,i)=>n?<button key={n} className={n===page?'active':''} onClick={()=>onPage(n)}>{n}</button>:<span key={`e${i}`}>…</span>)}<button aria-label="Next page" disabled={page===pages} onClick={()=>onPage(page+1)}><ChevronRight/></button></div>
}

/* ───────────────── Create wizard ───────────────── */
function PartyWizard({kind,existing,onClose,onSave}:{kind:Kind;existing:Master[];onClose:()=>void;onSave:(m:Master)=>void}){
 const isCustomer=kind==='Customer'
 const nextCode=isCustomer?`10-0${existing.length+1}-0${(existing.length%9)+1}-${String(1000+existing.length*137).slice(-4)}`:`V-${String(existing.length+1).padStart(3,'0')}`
 const [step,setStep]=useState(1)
 const [f,setF]=useState({code:nextCode,partyType:isCustomer?'Shop':'Supplier',name:'',dealing:'',phone:'',cell:'',booker:'',email:'',city:'',area:'',address:'',ntn:'',stn:'',creditLimit:'',creditDays:'30',status:'Active'})
 const set=(k:keyof typeof f)=>(e:{target:{value:string}})=>setF({...f,[k]:e.target.value})
 const steps=isCustomer?[['Basic Info','Tell us the basic details'],['Contact & Address','Add contact information'],['Credit & Tax','Set credit and tax details']]:[['Basic Info','Vendor details & type'],['Contact & Address','Contact information and location'],['Terms & Account','Payment terms, credit and status']]
 const titles=[['Basic Information',`Start with the essential details about your ${kind.toLowerCase()}.`],['Contact & Address',`Where and how to reach this ${kind.toLowerCase()}.`],[isCustomer?'Credit & Tax':'Terms & Account','Set limits, terms and registration details.']]
 const canNext=step===1?!!f.name.trim():true
 const finish=()=>onSave({code:f.code,name:f.name.trim(),type:masterType(kind),balanceType:isCustomer?'Debit':'Credit',status:f.status,city:f.city||'—',contact:f.phone||f.cell||'—',balance:0,extra:{partyType:f.partyType,dealing:f.dealing,booker:f.booker,email:f.email,area:f.area,address:f.address,ntn:f.ntn,stn:f.stn,creditLimit:f.creditLimit,creditDays:f.creditDays,cell:f.cell,since:'12 Sep 2026'}})
 return <div className="overlay" role="presentation" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className="pt-wizard" role="dialog" aria-modal="true" aria-label={`Create new ${kind.toLowerCase()}`}>
  <aside className="pt-wiz-side"><span className="pt-wiz-avatar">{isCustomer?<CircleUser/>:<Building2/>}<i><Plus/></i></span><h2>Create New<br/>{kind}</h2><p>{isCustomer?'Add a new customer or shop to your system. Follow the steps to complete the information.':'Add a new supplier to your system. Fill in the details step by step.'}</p>
   <ol className="pt-wiz-steps">{steps.map(([t,s],i)=><li key={t} className={step===i+1?'active':step>i+1?'done':''}><span>{step>i+1?<Check/>:i+1}</span><div><b>{t}</b><small>{s}</small></div></li>)}</ol>
   <div className="pt-wiz-art"><span className="hill a"/><span className="hill b"/><span className="house"/><em>{isCustomer?'Growing businesses together':'Stronger suppliers · Brighter business'}</em></div></aside>
  <div className="pt-wiz-main">
   <button className="pt-wiz-close" aria-label="Close" onClick={onClose}><X/></button>
   <div className="pt-wiz-head"><div><small>Step {step} of 3</small><h1>{titles[step-1][0]}</h1><p>{titles[step-1][1]}</p></div>
    <div className="pt-stepper">{steps.map(([t],i)=><div key={t} className={`${step>=i+1?'on':''} ${step>i+1?'done':''}`}><span>{step>i+1?<Check/>:i+1}</span><small>{t}</small></div>)}</div></div>
   <div className="pt-wiz-body">
    {step===1&&<div className="pt-form">
     <label>{isCustomer?'Code':'Vendor Code'} <i>*</i><input value={f.code} onChange={set('code')}/><small>Unique {kind.toLowerCase()} code (e.g. {nextCode})</small></label>
     {isCustomer?<div className="pt-field"><span>Customer Type <i>*</i></span><div className="pt-radio-cards">{[['Shop','Retail shop / outlet',Store],['Customer','Business account',User]].map(([v,d,Icon])=><button key={v as string} type="button" className={f.partyType===v?'active':''} onClick={()=>setF({...f,partyType:v as string})}><i/><Icon/><div><b>{v as string}</b><small>{d as string}</small></div></button>)}</div></div>
      :<label>Vendor Type <i>*</i><span className="pt-icon-input"><Truck/><select value={f.partyType} onChange={set('partyType')}>{['Supplier','Manufacturer','Distributor','Service Provider'].map(t=><option key={t}>{t}</option>)}</select></span></label>}
     <label>{isCustomer?'Name':'Vendor Name'} <i>*</i><input value={f.name} onChange={set('name')} placeholder={isCustomer?'Ahmed Traders':'ABC Pharmaceuticals'}/><small>Enter {isCustomer?'customer or shop':'vendor or company'} name</small></label>
     <label>Dealing Person<input value={f.dealing} onChange={set('dealing')} placeholder="Ali Raza"/><small>Person responsible for {isCustomer?'dealings':'purchases'}</small></label>
     <label>Phone #<span className="pt-icon-input"><Phone/><input value={f.phone} onChange={set('phone')} placeholder="0300-1234567"/></span><small>Enter active phone number</small></label>
     {isCustomer?<label>Booker<input value={f.booker} onChange={set('booker')} placeholder="Usman Malik"/><small>Name of the booking person (optional)</small></label>
      :<label>Cell #<span className="pt-icon-input"><Phone/><input value={f.cell} onChange={set('cell')} placeholder="0300-9876543"/></span></label>}
     {!isCustomer&&<><label>E-mail<span className="pt-icon-input"><Mail/><input value={f.email} onChange={set('email')} placeholder="sales@abcpharma.com"/></span></label><label>City<span className="pt-icon-input"><MapPin/><select value={f.city} onChange={set('city')}><option value="">Select city</option>{['Karachi','Lahore','Islamabad','Rawalpindi','Faisalabad','Multan','Peshawar'].map(c=><option key={c}>{c}</option>)}</select></span></label><label className="span-2">Address<span className="pt-icon-input tall"><MapPin/><textarea rows={2} value={f.address} onChange={set('address')} placeholder="Plot # 12, Industrial Area, Karachi"/></span><small>Full address of the vendor</small></label></>}
     {isCustomer&&<div className="pt-next-hint span-2"><span>i</span><div><b>Next Step: Contact &amp; Address</b><small>You’ll add the address, city and area details in the next step.</small></div></div>}
    </div>}
    {step===2&&<div className="pt-form">
     <label>E-mail<span className="pt-icon-input"><Mail/><input value={f.email} onChange={set('email')} placeholder="info@company.com"/></span></label>
     <label>Cell #<span className="pt-icon-input"><Phone/><input value={f.cell} onChange={set('cell')} placeholder="0300-9876543"/></span></label>
     <label>City<span className="pt-icon-input"><MapPin/><select value={f.city} onChange={set('city')}><option value="">Select city</option>{['Karachi','Lahore','Islamabad','Rawalpindi','Faisalabad','Multan','Peshawar'].map(c=><option key={c}>{c}</option>)}</select></span></label>
     <label>Area<input value={f.area} onChange={set('area')} placeholder="Shadman, Gulberg…"/></label>
     <label className="span-2">Address<span className="pt-icon-input tall"><MapPin/><textarea rows={3} value={f.address} onChange={set('address')} placeholder="Full address"/></span></label>
     <div className="pt-next-hint span-2"><span>i</span><div><b>Next Step: {isCustomer?'Credit & Tax':'Terms & Account'}</b><small>Set the credit limit, payment terms and tax registration next.</small></div></div>
    </div>}
    {step===3&&<div className="pt-form">
     <label>Credit Limit (Rs)<input inputMode="numeric" value={f.creditLimit} onChange={set('creditLimit')} placeholder="2,000,000"/></label>
     <label>Credit Days<select value={f.creditDays} onChange={set('creditDays')}>{['0','7','15','30','45','60','90'].map(d=><option key={d} value={d}>{d==='0'?'Cash only':`${d} Days`}</option>)}</select></label>
     <label>NTN #<input value={f.ntn} onChange={set('ntn')} placeholder="1234567-8"/></label>
     <label>Sales Tax No<input value={f.stn} onChange={set('stn')} placeholder="3277876-5"/></label>
     <label>Status<select value={f.status} onChange={set('status')}><option>Active</option><option>Inactive</option></select></label>
     <div className="pt-summary span-2"><b>Ready to create</b><dl><dt>Code</dt><dd>{f.code}</dd><dt>Name</dt><dd>{f.name||'—'}</dd><dt>Type</dt><dd>{f.partyType}</dd><dt>City</dt><dd>{f.city||'—'}</dd><dt>Phone</dt><dd>{f.phone||f.cell||'—'}</dd><dt>Terms</dt><dd>{f.creditDays==='0'?'Cash':`${f.creditDays} Days`}</dd></dl></div>
    </div>}
   </div>
   <div className="pt-wiz-foot"><button className="pt-ghost" onClick={onClose}>Cancel</button><div><button className="pt-ghost" disabled={step===1} onClick={()=>setStep(step-1)}><ArrowLeft/> Previous</button>{step<3?<button className="pt-primary" disabled={!canNext} onClick={()=>setStep(step+1)}>Next <ArrowRight/></button>:<button className="pt-primary" disabled={!f.name.trim()} onClick={finish}><Check/> Create {kind}</button>}</div></div>
  </div>
 </div></div>
}

/* ───────────────── Shared bits ───────────────── */
function Card({title,sub,icon:Icon,action,children,className=''}:{title:string;sub?:string;icon?:typeof Users;action?:ReactNode;children:ReactNode;className?:string}){
 return <section className={`pt-card ${className}`}><div className="pt-card-head">{Icon&&<span className="pt-card-icon"><Icon/></span>}<div><h3>{title}</h3>{sub&&<p>{sub}</p>}</div>{action&&<div className="pt-card-action">{action}</div>}</div>{children}</section>
}
const Row=({label,children}:{label:string;children:ReactNode})=><div className="pt-kv"><span>{label}</span><b>{children}</b></div>
const Bars=({tone}:{tone:string})=><span className={`pt-bars ${tone}`}>{[3,5,4,7,6,9,8].map((h,i)=><i key={i} style={{height:h*3}}/>)}</span>

function useParty(data:AppData,kind:Kind){
 const {code}=useParams()
 return data.masters.find(m=>m.code===code&&m.type===masterType(kind))
}

/* ───────────────── Customer detail ───────────────── */
export function CustomerDetail({data,onPatch}:{data:AppData;onPatch:(code:string,patch:Partial<Master>)=>void}){
 const navigate=useNavigate()
 const m=useParty(data,'Customer')
 const [tab,setTab]=useState('All Transactions')
 const [openRow,setOpenRow]=useState<string|null>(null)
 const [form,setForm]=useState<{name:string;phone:string;email:string;address:string;terms:string;limit:string}|null>(null)
 const [saved,setSaved]=useState(false)
 const invoices=useMemo(()=>m?data.sales.filter(s=>s.customer===m.name):[],[data,m])
 const receipts=useMemo(()=>m?data.payments.filter(p=>p.party===m.name&&p.kind==='Receipt'):[],[data,m])
 if(!m)return <div className="pt"><div className="pt-card"><div className="empty-state">Customer not found. <button className="linkable" onClick={()=>navigate('/customers')}>Back to customers</button></div></div></div>
 const x=m.extra??{}
 const f=form??{name:m.name,phone:m.contact,email:x.email??'',address:x.address??'',terms:x.creditDays?`${x.creditDays} Days`:'30 Days',limit:x.creditLimit??'2,000,000'}
 const totalSales=invoices.reduce((a,s)=>a+s.amount,0),totalPaid=receipts.reduce((a,p)=>a+p.total,0)+invoices.filter(s=>s.status==='Paid').reduce((a,s)=>a+s.amount,0)
 const outstanding=m.balance||invoices.filter(s=>s.status==='Credit').reduce((a,s)=>a+s.amount,0)
 const limit=parseInt(f.limit.replace(/\D/g,''))||2000000,used=Math.min(100,Math.round(outstanding/limit*100))
 type L={id:string;date:string;type:'Sales Invoice'|'Payment';ref:string;narration:string;debit:number;credit:number;status:string;detail?:ReactNode}
 const ledger:L[]=[...invoices.map<L>(s=>({id:s.id,date:s.date,type:'Sales Invoice',ref:`SI-${s.id.slice(-6)}`,narration:`Sale of ${s.product}`,debit:s.amount,credit:0,status:'Posted',detail:<><div><small>Narration</small><b>Sale of {s.product} to {m.name}.</b></div><div><small>Items (1)</small><b>● {s.product} <em>x {s.qty}</em></b></div><div><small>Created By</small><b>Sarah Lloyd</b></div><div><small>Created On</small><b>{s.date}, 10:24 AM</b></div></>})),...receipts.map<L>(p=>({id:p.id,date:p.date,type:'Payment',ref:p.account,narration:'Payment received',debit:0,credit:p.total,status:'Cleared'}))]
 let run=0;const withBal=ledger.map(l=>({...l,balance:(run+=l.debit-l.credit)}))
 const shown=withBal.filter(l=>tab==='All Transactions'||(tab==='Invoices'&&l.type==='Sales Invoice')||(tab==='Payments'&&l.type==='Payment'))
 const save=()=>{onPatch(m.code,{name:f.name,contact:f.phone,extra:{...x,email:f.email,address:f.address,creditDays:f.terms.replace(/\D/g,''),creditLimit:f.limit}});setSaved(true);setTimeout(()=>setSaved(false),2500)}
 return <div className="pt">
  <div className="pt-crumbs"><button onClick={()=>navigate('/customers')}>Customers</button><ChevronRight/><b>Customer Details</b></div>
  <section className="pt-card pt-profile">
   <span className="pt-avatar">{initials(m.name)}</span>
   <div className="pt-profile-main"><div className="pt-profile-title"><h1>{m.name}</h1><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span></div>
    <div className="pt-profile-meta"><span>{m.code}</span><i/><span>{x.partyType==='Shop'?'Retail shop':'Wholesaler'}</span><i/><span>Since {x.since??'12 Jan 2023'}</span></div>
    <div className="pt-tags"><span>General Trade</span><span>Regular Customer</span><button><Plus/> Add Tag</button></div></div>
   <div className="pt-contact-strip"><div><span><User/></span><div><b>{x.dealing||'Muhammad Asim'}</b><small>Contact Person</small></div></div><div><span><Phone/></span><div><b>{m.contact}</b><small>Primary Phone</small></div></div><div><span><Mail/></span><div><b>{x.email||`${m.name.split(' ')[0].toLowerCase()}@mail.com`}</b><small>Email</small></div></div><div><span><MapPin/></span><div><b>{x.area||m.city}</b><small>{m.city}, Pakistan</small></div></div></div>
   <div className="pt-profile-actions"><button className="pt-ghost sq" aria-label="More"><Ellipsis/></button><button className="pt-ghost" onClick={()=>document.getElementById('quick-edit-name')?.focus()}><Pencil/> Edit</button><button className="pt-primary dark" onClick={()=>navigate('/sales')}><Plus/> New Transaction <ChevronDown/></button></div>
  </section>

  <div className="pt-grid-4">
   <Card title="Customer Snapshot" sub="Key information at a glance" icon={CircleUser}>
    <Row label="Customer Code">{m.code}</Row><Row label="NTN / CNIC">{x.ntn||'35202-1234567-1'}</Row><Row label="Customer Group">{x.partyType==='Shop'?'Retail Customer':'Wholesale Customer'}</Row><Row label="Sales Tax No">{x.stn||'3277876-5'}</Row><Row label="Payment Terms">{f.terms}</Row><Row label="Credit Limit">Rs {f.limit}</Row><Row label="Status"><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>● {m.status}</span></Row><Row label="Customer Since">{x.since??'12 Jan 2023'}</Row>
    <blockquote className="pt-quote">“Reliable customer with consistent orders and early payments.”<footer>— Account Manager</footer></blockquote>
   </Card>
   <Card title="Financial Health" sub="A business snapshot" icon={BarChart3} action={<select className="pt-mini-select" defaultValue="This Year"><option>This Year</option><option>Last Year</option></select>}>
    <div className="pt-fin"><div className="pt-fin-tile"><b>{money(totalSales)}</b><small>Total Sales</small><span className="pt-delta green">▲ 18%</span><Bars tone="green"/></div><div className="pt-fin-tile"><b>{money(totalPaid)}</b><small>Total Payments</small><span className="pt-delta green">▲ 24%</span><Bars tone="green"/></div><div className="pt-fin-tile warm"><b>{money(outstanding)}</b><small>Outstanding Balance</small><span className="pt-delta red">▲ 8%</span><Bars tone="orange"/></div><div className="pt-fin-tile"><b>Rs {f.limit}</b><small>Credit Limit</small><i className="pt-meter"><i style={{width:`${used}%`}}/></i><small className="right">{used}% used</small></div></div>
    <div className="pt-good"><span><Check/></span><div><b>Account is in good standing</b><small>Payment behavior is healthy with consistent activity and no overdue invoices.</small></div></div>
   </Card>
   <Card title="Quick Edit Details" sub="Update customer information" icon={Pencil}>
    <div className="pt-edit"><label>Customer Name<input id="quick-edit-name" value={f.name} onChange={e=>setForm({...f,name:e.target.value})}/></label><label>Phone<input value={f.phone} onChange={e=>setForm({...f,phone:e.target.value})}/></label><label>Email<input value={f.email} onChange={e=>setForm({...f,email:e.target.value})}/></label><label>Address<textarea rows={3} value={f.address} onChange={e=>setForm({...f,address:e.target.value})}/></label><label>Payment Terms<select value={f.terms} onChange={e=>setForm({...f,terms:e.target.value})}>{['Cash','7 Days','15 Days','30 Days','45 Days','60 Days'].map(t=><option key={t}>{t}</option>)}</select></label><label>Credit Limit<input value={f.limit} onChange={e=>setForm({...f,limit:e.target.value})}/></label></div>
    <div className="pt-edit-foot"><button className="pt-primary dark" onClick={save}>{saved?<><Check/> Saved</>:'Save Changes'}</button><button className="pt-ghost" onClick={()=>setForm(null)}>Cancel</button></div>
   </Card>
   <div className="pt-col">
    <Card title="Report Center" sub="Generate and download reports" icon={FileText}>
     <div className="pt-links">{[['Customer Statement','View account activity',FileText,`/finance/accounts/${m.code}`],['Account Ledger','Detailed transaction history',FileText,`/finance/accounts/${m.code}`],['Sales Summary','Sales and invoice analysis',BarChart3,'/reports'],['Aging Report','Outstanding balance by age',Clock3,'/receivables'],['Export to PDF / Excel','Download customer data',Download,'/reports']].map(([t,s,Icon,path])=>{const I=Icon as typeof Users;return <button key={t as string} onClick={()=>navigate(path as string)}><I/><div><b>{t as string}</b><small>{s as string}</small></div><ChevronRight/></button>})}</div>
    </Card>
    <Card title="Recent Interactions" sub="View all activity and notes" icon={MessageSquare} action={<button className="pt-ghost sm"><Plus/> Add Note</button>}>
     <ul className="pt-timeline">{[['08 Sep 2026','green','Payment received','Rs 200,000 via Bank Transfer','SA'],['05 Sep 2026','blue','Sales invoice created','INV-002145 - Rs 250,000','SA'],['28 Aug 2026','orange','Note added','Discussed upcoming order for October.','MK']].map(([d,c,t,s,who])=><li key={t}><time>{d}</time><i className={c}/><div><b>{t}</b><small>{s}</small></div><span>{who}</span></li>)}</ul>
     <button className="pt-link" onClick={()=>navigate(`/finance/accounts/${m.code}`)}>View All Activity <ArrowRight/></button>
    </Card>
   </div>
  </div>

  <Card title="Account Ledger" sub="Complete transaction history for this customer" icon={FileText} className="pt-ledger" action={<div className="pt-ledger-tools"><span className="pt-search"><Search/><input placeholder="Search by voucher no, reference, or narration..."/></span><button className="pt-ghost"><Filter/> Filters <ChevronDown/></button><button className="pt-ghost"><Clock3/> All Time <ChevronDown/></button><button className="pt-ghost"><Download/> Export</button></div>}>
   <div className="pt-tabs">{[['All Transactions',withBal.length],['Invoices',invoices.length],['Payments',receipts.length],['Credit Notes',0],['Adjustments',0]].map(([t,n])=><button key={t as string} className={tab===t?'active':''} onClick={()=>setTab(t as string)}>{t as string} ({n as number})</button>)}</div>
   <div className="table-wrap pt-table"><table><thead><tr><th><input type="checkbox" aria-label="Select all"/></th><th/><th>Date</th><th>Type</th><th>Voucher No</th><th>Reference</th><th>Narration</th><th className="num">Debit (Rs)</th><th className="num">Credit (Rs)</th><th className="num">Balance (Rs)</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    {shown.map(l=><><tr key={l.id}><td><input type="checkbox" aria-label={`Select ${l.id}`}/></td><td><button className="pt-expand" aria-label={`Toggle ${l.id}`} onClick={()=>setOpenRow(openRow===l.id?null:l.id)}>{openRow===l.id?<ChevronDown/>:<ChevronRight/>}</button></td><td>{l.date}</td><td><span className={`pt-type ${l.type==='Payment'?'blue':'green'}`}>{l.type}</span></td><td>{l.id}</td><td>{l.ref}</td><td>{l.narration}</td><td className="num">{l.debit?l.debit.toLocaleString():'-'}</td><td className="num">{l.credit?l.credit.toLocaleString():'-'}</td><td className="num">{l.balance.toLocaleString()}</td><td><span className="pt-status on">{l.status}</span></td><td><button className="pt-ghost sq sm" aria-label="Row actions"><Ellipsis/></button></td></tr>
     {openRow===l.id&&l.detail&&<tr key={`${l.id}-d`} className="pt-detail-row"><td colSpan={12}><div className="pt-detail">{l.detail}</div></td></tr>}</>)}
    {!shown.length&&<tr><td colSpan={12}><div className="empty-state">No entries in this view.</div></td></tr>}
   </tbody></table></div>
   <div className="pt-paging"><span>Showing 1 to {shown.length} of {shown.length} entries</span><Pager page={1} pages={1} onPage={()=>{}}/></div>
  </Card>
 </div>
}

/* ───────────────── Vendor detail ───────────────── */
export function VendorDetail({data,onPatch}:{data:AppData;onPatch:(code:string,patch:Partial<Master>)=>void}){
 const navigate=useNavigate()
 const m=useParty(data,'Vendor')
 const [tab,setTab]=useState('Overview')
 const [txTab,setTxTab]=useState('Recent Transactions')
 const [editing,setEditing]=useState(false)
 const [f,setF]=useState({name:'',phone:'',email:'',address:''})
 const purchases=useMemo(()=>m?data.purchases.filter(p=>p.supplier===m.name&&p.status==='Posted'):[],[data,m])
 const payments=useMemo(()=>m?data.payments.filter(p=>p.party===m.name&&p.kind==='Payment'):[],[data,m])
 if(!m)return <div className="pt"><div className="pt-card"><div className="empty-state">Vendor not found. <button className="linkable" onClick={()=>navigate('/vendors')}>Back to vendors</button></div></div></div>
 const x=m.extra??{}
 const totalPurchases=purchases.reduce((a,p)=>a+p.amount,0),totalPaid=payments.reduce((a,p)=>a+p.total,0)
 const balance=m.balance||Math.max(0,totalPurchases-totalPaid)
 const limit=x.creditLimit?`Rs ${x.creditLimit}`:'Rs 500,000',terms=x.creditDays?`${x.creditDays} Days`:'30 Days'
 const email=x.email||`info@${m.name.split(' ')[0].toLowerCase()}.com`
 const trend=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep'].map((mo,i)=>({mo,v:[180,320,210,260,230,330,340,400,300][i]*1000}))
 type T={date:string;type:'Purchase'|'Payment';ref:string;desc:string;debit:number;credit:number}
 const tx:T[]=[...purchases.map<T>(p=>({date:p.date,type:'Purchase',ref:p.id,desc:'Purchase Invoice',debit:p.amount,credit:0})),...payments.map<T>(p=>({date:p.date,type:'Payment',ref:p.id,desc:`Payment via ${p.account}`,debit:0,credit:p.total}))]
 let run=0;const rows=tx.map(t=>({...t,balance:(run+=t.debit-t.credit)})).reverse()
 const shownTx=rows.filter(r=>txTab==='Recent Transactions'||(txTab==='Open Invoices'&&r.type==='Purchase')||(txTab==='Recent Purchases'&&r.type==='Purchase'))
 const topItems=Object.entries(purchases.reduce<Record<string,{qty:number;amt:number}>>((acc,p)=>{acc[p.product]=acc[p.product]??{qty:0,amt:0};acc[p.product].qty+=p.qty;acc[p.product].amt+=p.amount;return acc},{})).sort((a,b)=>b[1].amt-a[1].amt).slice(0,5)
 const aging=[['Current (0-30)',balance*0.62,'green'],['31-60 Days',balance*0.25,'yellow'],['61-90 Days',balance*0.08,'orange'],['90+ Days',0,'grey']] as const
 const startEdit=()=>{setF({name:m.name,phone:m.contact,email,address:x.address??''});setEditing(true)}
 const saveEdit=()=>{onPatch(m.code,{name:f.name,contact:f.phone,extra:{...x,email:f.email,address:f.address}});setEditing(false)}
 const contacts=[[x.dealing||'Ali Raza','Sales Manager',m.contact,email],['Sara Khan','Accounts','+92 321 7654321',`sara@${email.split('@')[1]}`],['Usman Malik','Operations','+92 333 1112233',`ops@${email.split('@')[1]}`]]
 return <div className="pt">
  <div className="pt-topbar"><div className="pt-crumbs"><button onClick={()=>navigate('/vendors')}>Vendors</button><ChevronRight/><b>Vendor Details</b></div><div className="pt-actions"><button className="pt-ghost" onClick={()=>navigate('/vendors')}><ArrowLeft/> Back to List</button><button className="pt-primary" onClick={startEdit}><Pencil/> Edit Vendor</button><button className="pt-ghost">More <ChevronDown/></button></div></div>
  <section className="pt-card pt-vprofile">
   <span className="pt-avatar soft"><Store/></span>
   <div className="pt-profile-main"><h1>{m.name}</h1><div className="pt-chips"><span className="code">{m.code}</span><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span></div>
    <div className="pt-icon-meta"><span><Truck/>{x.partyType||'Pharmaceuticals'}</span><span><MapPin/>{m.city==='—'?'Local Supplier':`${m.city} Supplier`}</span><span><Clock3/>Since {x.since??'12 Jan 2023'}</span></div></div>
   <div className="pt-vcontact"><div><User/><div><b>{x.dealing||'Ali Raza'}</b><small>Sales Manager</small></div></div><div><Phone/>{m.contact}</div><div><Mail/>{email}</div><div><MapPin/>{x.address||`${m.city}, Pakistan`}</div></div>
   <div className="pt-vbalance"><div><small>Current Balance</small><b className="green">{money(balance)}</b><span className="pt-pill">Payable</span></div><div><small>Credit Limit</small><b>{limit}</b></div><div><small>Payment Terms</small><b>{terms}</b></div></div>
  </section>
  <div className="pt-tabs underline">{['Overview','Ledger','Purchases','Payments','Documents','Contacts','Notes','Activity'].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>t==='Ledger'?navigate(`/finance/accounts/${m.code}`):t==='Purchases'?navigate('/purchases'):t==='Payments'?navigate('/payments'):setTab(t)}>{t}</button>)}</div>

  <div className="pt-vgrid">
   <Card title="Vendor Information" action={editing?<div className="pt-inline-actions"><button className="pt-primary sm" onClick={saveEdit}><Check/> Save</button><button className="pt-ghost sm" onClick={()=>setEditing(false)}>Cancel</button></div>:<button className="pt-ghost sm" onClick={startEdit}><Pencil/> Edit</button>}>
    {editing?<div className="pt-edit"><label>Vendor Name<input value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></label><label>Phone<input value={f.phone} onChange={e=>setF({...f,phone:e.target.value})}/></label><label>Email<input value={f.email} onChange={e=>setF({...f,email:e.target.value})}/></label><label>Address<textarea rows={3} value={f.address} onChange={e=>setF({...f,address:e.target.value})}/></label></div>
    :<div className="pt-info"><Row label="Vendor Name">{m.name}</Row><Row label="Vendor Code">{m.code}</Row><Row label="Category">{x.partyType||'Pharmaceuticals'}</Row><Row label="GST / NTN">{x.ntn||'3278132-7'}</Row><Row label="Phone">{m.contact}</Row><Row label="Email">{email}</Row><Row label="Website">www.{email.split('@')[1]}</Row><Row label="Address">{x.address||`123 Industrial Area, ${m.city}, Pakistan`}</Row><Row label="Billing Address">Same as above</Row><Row label="Shipping Address">{x.address||`Warehouse 2, ${m.city}, Pakistan`}</Row><Row label="Payment Terms">{terms}</Row><Row label="Credit Limit">{limit}</Row><Row label="Currency">PKR</Row><Row label="Status"><span className={`pt-status ${m.status==='Active'?'on':'off'}`}>{m.status}</span></Row><Row label="Notes">Preferred supplier for antibiotics and general medicines.</Row></div>}
   </Card>
   <div className="pt-col">
    <div className="pt-vstats">{[[ShoppingCart,'Total Purchases',money(totalPurchases),'This Year'],[WalletCards,'Total Payments',money(totalPaid),'This Year'],[Wallet,'Current Balance',money(balance),'Payable'],[FileText,'Open Invoices',String(purchases.length),'Total']].map(([Icon,l,v,s])=>{const I=Icon as typeof Users;return <div key={l as string} className="pt-vstat"><span><I/></span><div><small>{l as string}</small><b className={l==='Current Balance'?'green':''}>{v as string}</b>{s==='Payable'?<em className="pt-pill">Payable</em>:<small>{s as string}</small>}</div></div>})}</div>
    <div className="pt-vrow">
     <Card title="Balance Trend" action={<small>Last 9 Months</small>}><div className="pt-chart"><ResponsiveContainer><AreaChart data={trend} margin={{top:10,right:8,left:-14,bottom:0}}><defs><linearGradient id="ptg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#15803D" stopOpacity=".25"/><stop offset="100%" stopColor="#15803D" stopOpacity="0"/></linearGradient></defs><XAxis dataKey="mo" tick={{fontSize:10,fill:'#64748B'}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:'#64748B'}} axisLine={false} tickLine={false} tickFormatter={v=>`${v/1000}K`} ticks={[0,300000,600000]}/><Area type="monotone" dataKey="v" stroke="#15803D" strokeWidth={2} fill="url(#ptg)" dot={{r:3,fill:'#15803D',strokeWidth:0}}/></AreaChart></ResponsiveContainer></div></Card>
     <Card title="Aging Summary"><div className="pt-aging">{aging.map(([l,v,c])=><div key={l}><span>{l}</span><i><i className={c} style={{width:`${balance?Math.round(v/balance*100):0}%`}}/></i><b>{money(Math.round(v))}</b></div>)}</div></Card>
    </div>
    <Card title="" className="pt-tx" action={<button className="pt-link" onClick={()=>navigate(`/finance/accounts/${m.code}`)}>View All <ArrowRight/></button>}>
     <div className="pt-tabs underline tight">{['Recent Transactions','Open Invoices','Recent Purchases'].map(t=><button key={t} className={txTab===t?'active':''} onClick={()=>setTxTab(t)}>{t}</button>)}</div>
     <div className="table-wrap pt-table"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th className="num">Debit (Rs)</th><th className="num">Credit (Rs)</th><th className="num">Balance (Rs)</th></tr></thead><tbody>
      {shownTx.map(r=><tr key={r.ref}><td>{r.date}</td><td><span className={`pt-type ${r.type==='Payment'?'green':'blue'}`}>{r.type}</span></td><td><button className="linkable" onClick={()=>navigate(r.type==='Purchase'?`/purchases/${r.ref}`:'/payments')}>{r.ref}</button></td><td>{r.desc}</td><td className="num">{r.debit?r.debit.toLocaleString():'-'}</td><td className="num">{r.credit?r.credit.toLocaleString():'-'}</td><td className="num">{r.balance.toLocaleString()}</td></tr>)}
      {!shownTx.length&&<tr><td colSpan={7}><div className="empty-state">No transactions yet for this vendor.</div></td></tr>}
     </tbody></table></div>
    </Card>
    <div className="pt-vrow three">
     <Card title="Top Purchase Items" action={<select className="pt-mini-select" defaultValue="This Year"><option>This Year</option></select>}><table className="pt-plain"><thead><tr><th>#</th><th>Product</th><th className="num">Qty</th><th className="num">Amount (Rs)</th></tr></thead><tbody>{topItems.map(([p,v],i)=><tr key={p}><td>{i+1}</td><td>{p}</td><td className="num">{v.qty.toLocaleString()}</td><td className="num">{v.amt.toLocaleString()}</td></tr>)}{!topItems.length&&<tr><td colSpan={4}><div className="empty-state">No purchases yet.</div></td></tr>}</tbody></table></Card>
     <Card title="Contacts" action={<button className="pt-link">Add Contact</button>}><ul className="pt-contacts">{contacts.map(([n,r,p,e])=><li key={n}><span><User/></span><div><b>{n}</b><small>{r}</small></div><div><small><Phone/>{p}</small><small><Mail/>{e}</small></div></li>)}</ul></Card>
     <Card title="Documents" action={<button className="pt-link">Upload</button>}><ul className="pt-docs">{[['Vendor Agreement.pdf','2.4 MB · 12 Jan 2023'],['NTN Certificate.pdf','1.1 MB · 12 Jan 2023'],['GST Certificate.pdf','1.3 MB · 12 Jan 2023'],['Other Docs','3 files']].map(([n,s])=><li key={n}><span><FileText/></span><div><b>{n}</b><small>{s}</small></div><button aria-label={`Options for ${n}`}><Ellipsis/></button></li>)}</ul></Card>
    </div>
   </div>
  </div>
 </div>
}
