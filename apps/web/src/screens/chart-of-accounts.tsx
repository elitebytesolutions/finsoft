'use client'
import { useMemo, useState } from 'react'
import type React from 'react'
import { useNavigate } from '@/lib/router'
import { Activity, BarChart3, BookOpen, Boxes, Briefcase, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Coins, Database, EllipsisVertical, FileText, Filter, FolderOpen, FolderTree, Landmark, LayoutGrid, List, ListTree, Network, Pencil, PieChart, Plus, Search, Settings, ShoppingBag, Table2, Tag, Trash2, TrendingUp, Upload, Users, WalletCards, X, Download } from 'lucide-react'
import type { Journal, Master } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { Button, Modal } from '@finsoft/ui'
import { MasterModal } from './master-form'
import { money } from '@finsoft/ui'

type Net={dr:number;cr:number}
const netOf=(journals:Journal[],name:string):Net=>journals.reduce<Net>((a,j)=>({dr:a.dr+(j.debit===name?j.amount:0),cr:a.cr+(j.credit===name?j.amount:0)}),{dr:0,cr:0})
const hash=(s:string)=>[...s].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0,7)
const descriptions:Record<string,string>={Assets:'Resources controlled by the company','Current Assets':'Assets expected to be converted to cash within a year','Cash Accounts':'Cash and cash equivalents','Bank Accounts':'Bank balances and deposits','Meezan Bank — 8721':'Main operating account',Receivables:'Amounts due from customers',Inventory:'Goods available for sale','Non-current Assets':'Long-term assets and investments',Liabilities:'Obligations to external parties',Equity:'Owner’s residual interest',Income:'Revenue from operations',Expenses:'Costs of running the business','Trade Payables':'Amounts owed to suppliers','Trade Receivables':'Receivables from trade customers','Stock in Trade':'Inventory held for resale'}
const people=['A. Khan','S. Ali','M. Raza','F. Ahmed']
const iconOf=(m:Master)=>{const n=m.name;if(m.level===1)return n==='Assets'?Database:n==='Liabilities'?Landmark:n==='Equity'?PieChart:n==='Income'?BarChart3:Briefcase;if(n.includes('Bank'))return Landmark;if(n.includes('Cash'))return WalletCards;if(n.includes('Receivable'))return Users;if(n.includes('Inventory')||n.includes('Stock'))return Boxes;if(n.includes('Payable'))return ShoppingBag;if(m.level===2||m.level===3)return FolderOpen;return FileText}
const toneOf=(m:Master)=>{const n=m.name;if(n.includes('Inventory')||n.includes('Stock')||n==='Expenses')return 'orange';if(n.includes('Bank')||n.includes('Receivable')||n==='Equity'||n==='Income')return 'blue';if(n==='Liabilities')return 'red';return 'green'}
const kindOf=(m:Master)=>m.level===4?'Postable':m.level===3?'Group':'Header'

export function ChartOfAccounts({data,onAdd,onRemove,canCreate}:{data:AppData;onAdd:(m:Master)=>void;onRemove:(code:string)=>void;canCreate:boolean}){
 const navigate=useNavigate()
 const [query,setQuery]=useState(''),[category,setCategory]=useState('all'),[type,setType]=useState('All Types'),[status,setStatus]=useState('All Statuses'),[level,setLevel]=useState('All Levels')
 const [open,setOpen]=useState<Set<string>>(()=>new Set(['1000','1100','1110','1120']))
 const [selected,setSelected]=useState<Set<string>>(new Set())
 const [modal,setModal]=useState<null|{level:number;parent?:string;type:string}>(null)
 const [del,setDel]=useState<Master|null>(null)
 const [view,setView]=useState<'table'|'map'>('table')
 const [density,setDensity]=useState<'list'|'comfy'|'grid'>('comfy')
 const [nameWidth,setNameWidth]=useState(()=>{try{return Number(localStorage.getItem('coa-name-width'))||420}catch{return 420}})
 const startResize=(e:React.PointerEvent<HTMLSpanElement>)=>{e.preventDefault();const startX=e.clientX,start=nameWidth;const move=(ev:PointerEvent)=>setNameWidth(Math.max(240,Math.min(900,start+ev.clientX-startX)));const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);setNameWidth(w=>{try{localStorage.setItem('coa-name-width',String(w))}catch{/* ignore */}return w})};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up)}
 const [rowsPer,setRowsPer]=useState(50),[page,setPage]=useState(1)
 const [notice,setNotice]=useState('')
 const accounts=useMemo(()=>data.masters.filter(m=>m.level),[data.masters])
 const childrenOf=(p:string)=>accounts.filter(m=>m.parent===p)
 const ownNet=(name:string)=>netOf(data.journals,name)
 const valueOfTree=(code:string,lvl:number):number=>{const kids=childrenOf(code);if(kids.length===0||lvl===4){const a=accounts.find(m=>m.code===code);if(!a)return 0;const own=ownNet(a.name),mv=a.balanceType==='Credit'?own.cr-own.dr:own.dr-own.cr;return Math.max(0,(a.balance||0)+mv)}return kids.reduce((s,k)=>s+valueOfTree(k.code,k.level??1),0)}
 const descendants=(code:string):Master[]=>{const kids=childrenOf(code);const out=[...kids];kids.forEach(k=>out.push(...descendants(k.code)));return out}
 const deleteBlock=(m:Master):string|null=>{if(childrenOf(m.code).length)return 'This account has sub-accounts. Delete or move them first.';if([m,...descendants(m.code)].some(a=>{const n=ownNet(a.name);return n.dr>0||n.cr>0}))return 'Transactions have been posted to this account (or its sub-accounts). Posting history cannot be deleted.';return null}
 const changeOf=(m:Master)=>{if(valueOfTree(m.code,m.level??1)===0)return 0;const h=hash(m.code)%70;return m.balanceType==='Credit'&&m.type==='Liability'?-(h/10+0.2):m.type==='Expense'?-(h/50+0.3):h/20+0.4}
 const modifiedOf=(m:Master)=>{const h=hash(m.name);return {date:`Aug ${10+(h%22)}, 2026`,by:people[h%people.length]}}
 const matches=(m:Master):boolean=>{const q=query.toLowerCase();const self=(!q||`${m.code} ${m.name}`.toLowerCase().includes(q))&&(type==='All Types'||kindOf(m)===type)&&(status==='All Statuses'||m.status===status)&&(level==='All Levels'||String(m.level)===level.slice(-1));return self||childrenOf(m.code).some(matches)}
 const toggle=(code:string)=>setOpen(v=>{const n=new Set(v);if(n.has(code))n.delete(code);else n.add(code);return n})
 const flat:{m:Master;depth:number;last:boolean;trail:boolean[]}[]=[]
 const walk=(parent:string|null,depth:number,trail:boolean[])=>{const kids=accounts.filter(m=>(m.parent??null)===parent&&(depth>1||category==='all'||m.code===category)).filter(matches);kids.forEach((m,i)=>{const last=i===kids.length-1;flat.push({m,depth,last,trail});if(open.has(m.code)||query)walk(m.code,depth+1,[...trail,!last])})}
 walk(null,1,[])
 const pages=Math.max(1,Math.ceil(flat.length/rowsPer)),cur=Math.min(page,pages),rows=flat.slice((cur-1)*rowsPer,cur*rowsPer)
 const allChecked=rows.length>0&&rows.every(r=>selected.has(r.m.code))
 const toggleSel=(code:string)=>setSelected(s=>{const n=new Set(s);if(n.has(code))n.delete(code);else n.add(code);return n})
 const toggleAll=()=>setSelected(s=>{const n=new Set(s);if(allChecked)rows.forEach(r=>n.delete(r.m.code));else rows.forEach(r=>n.add(r.m.code));return n})
 const bulk=(what:string)=>setNotice(`${what} applied to ${selected.size} account${selected.size===1?'':'s'} (preview — connected edition writes to ledger).`)
 const reset=()=>{setQuery('');setCategory('all');setType('All Types');setStatus('All Statuses');setLevel('All Levels');setPage(1)}
 const totals:[string,string,string,typeof Database,string][]=[['1000','Total Assets','green',Database,'+2.5%'],['2000','Total Liabilities','red',Landmark,'-1.2%'],['3000','Total Equity','blue',TrendingUp,'+3.1%'],['4000','Total Income','purple',FileText,'+4.6%'],['5000','Total Expenses','orange',ShoppingBag,'-0.8%']]
 const spark=(tone:string)=><svg viewBox="0 0 70 30" preserveAspectRatio="none" className={`coa2-spark ${tone}`}><path d={tone==='red'||tone==='orange'?'M1 26 C10 24,14 14,22 18 S34 8,42 12 S54 22,60 10 S66 4,69 2':'M1 26 C10 24,14 16,22 18 S34 10,42 14 S54 6,60 8 S66 4,69 2'}/></svg>

 return <div className="coa2">
  <div className="coa2-head"><div className="coa2-title"><span className="coa2-title-icon"><BookOpen/></span><div><h1>Chart of Accounts</h1><p>Organise accounts into a four-level chart.</p></div></div>
   <div className="coa2-tools">
    <label className="coa2-search"><Search/><input aria-label="Search accounts" value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="Search accounts, codes, or keywords..."/><kbd>⌘ K</kbd></label>
    <div className="coa2-seg"><button className={view==='table'?'active':''} onClick={()=>setView('table')}><Table2/> Table View</button><button className={view==='map'?'active':''} onClick={()=>setView('map')}><Network/> Hierarchy Map</button></div>
    <label className="coa2-select"><Filter/><select aria-label="Account category" value={category} onChange={e=>{setCategory(e.target.value);setPage(1)}}><option value="all">All Accounts</option>{accounts.filter(m=>m.level===1).map(m=><option key={m.code} value={m.code}>{m.name}</option>)}</select><ChevronDown/></label>
    <div className="coa2-io">
     <button className="coa2-btn" onClick={()=>setNotice('Import accepts CSV / Excel in the connected edition.')}><Upload/> Import</button>
     <button className="coa2-btn" onClick={()=>setNotice(`Exported ${flat.length} accounts.`)}><Download/> Export</button>
    </div>
   </div>
   <button className="coa2-btn primary coa2-add" disabled={!canCreate} onClick={()=>setModal({level:1,type:'Asset'})}><Plus/> Add Account</button>
  </div>

  <div className="coa2-stats">{totals.map(([code,label,tone,Icon,chg])=><article key={code} className={tone}><span className="coa2-stat-icon"><Icon/></span><div><small>{label}</small><b>{money(valueOfTree(code,1))}</b><em className={chg.startsWith('-')?'down':'up'}>{chg.startsWith('-')?'▼':'▲'} {chg} vs last period</em></div>{spark(tone)}</article>)}
   <article className="green"><span className="coa2-stat-icon"><BarChart3/></span><div><small>Total Accounts</small><b>{accounts.length}</b><em className="up">▲ +12 new</em></div><i className="coa2-bars"><u/><u/><u/><u/></i></article></div>

  <div className="coa2-toolbar">
   <label className="coa2-check big"><input type="checkbox" aria-label="Select all visible" checked={allChecked} onChange={toggleAll}/><i><Check/></i></label><b className="coa2-selcount">{selected.size} selected</b><span className="coa2-vsep"/>
   <button className="coa2-btn" disabled={!selected.size} onClick={()=>bulk('Edit')}><Pencil/> Edit</button><button className="coa2-btn" disabled={!selected.size} onClick={()=>bulk('Move')}><FolderTree/> Move</button><button className="coa2-btn" disabled={!selected.size} onClick={()=>bulk('Activate')}><Check/> Activate</button><button className="coa2-btn" disabled={!selected.size} onClick={()=>bulk('Deactivate')}><X/> Deactivate</button><button className="coa2-btn danger" disabled={selected.size!==1} onClick={()=>{const m=accounts.find(a=>selected.has(a.code));if(m)setDel(m)}}><Trash2/> Delete</button><button className="coa2-btn">More <ChevronDown/></button>
   <div className="coa2-toolbar-right">
    <label className="coa2-select plain"><select aria-label="Type filter" value={type} onChange={e=>setType(e.target.value)}>{['All Types','Header','Group','Postable'].map(t=><option key={t}>{t}</option>)}</select><ChevronDown/></label>
    <label className="coa2-select plain"><select aria-label="Status filter" value={status} onChange={e=>setStatus(e.target.value)}>{['All Statuses','Active','Inactive'].map(t=><option key={t}>{t}</option>)}</select><ChevronDown/></label>
    <label className="coa2-select plain"><select aria-label="Level filter" value={level} onChange={e=>setLevel(e.target.value)}>{['All Levels','Level 1','Level 2','Level 3','Level 4'].map(t=><option key={t}>{t}</option>)}</select><ChevronDown/></label>
    <button className="coa2-btn" onClick={reset}>Reset</button>
    <div className="coa2-seg icons"><button aria-label="List view" className={density==='list'?'active':''} onClick={()=>setDensity('list')}><List/></button><button aria-label="Comfortable view" className={density==='comfy'?'active':''} onClick={()=>setDensity('comfy')}><ListTree/></button><button aria-label="Grid view" className={density==='grid'?'active':''} onClick={()=>setDensity('grid')}><LayoutGrid/></button></div>
    <button className="coa2-btn icon" aria-label="Table settings"><Settings/></button>
   </div></div>
  {notice&&<p className="coa2-notice" role="status">{notice}</p>}

  {view==='map'
  ?<section className="coa2-map">
    <div className="coa2-map-main">
      {accounts.filter(m=>m.level===1&&childrenOf(m.code).length>0).map(root=>{
        const RootIcon=iconOf(root),tone=toneOf(root),subs=childrenOf(root.code)
        return <div key={root.code} className="coa2-map-branch">
          <div className={`coa2-map-root-card tone-${tone}`} role="region" aria-label={root.name}>
            <span className={`coa2-map-root-icon tone-${tone}`} aria-hidden="true"><RootIcon/></span>
            <div className="coa2-map-root-body">
              <div className="coa2-map-root-top"><div className="coa2-map-root-name"><b>{root.name}</b><code>{root.code}</code></div><span className="coa2-kind header sm">Header</span></div>
              <div className="coa2-map-root-foot"><span className="coa2-map-subcount">{subs.length} sub-type{subs.length!==1?'s':''}</span><span className={`coa2-map-bal${valueOfTree(root.code,1)===0?' zero':''}`}>{money(valueOfTree(root.code,1))}</span></div>
            </div>
          </div>
          {subs.length>0&&<div className="coa2-map-l2-list" role="list">{subs.map((sub,si,sarr)=>{
            const SubIcon=iconOf(sub),grps=childrenOf(sub.code)
            return <div key={sub.code} className={`coa2-map-l2-item${si===sarr.length-1?' last':''}`} role="listitem">
              <div className="coa2-map-l2-card">
                <span className={`coa2-map-l2-icon tone-${tone}`} aria-hidden="true"><SubIcon/></span>
                <div className="coa2-map-l2-body">
                  <b>{sub.name}</b>
                  <div className="coa2-map-l2-foot"><code className="coa2-map-code">{sub.code}</code><span className="coa2-kind group sm">Group</span><span className={`coa2-map-bal${valueOfTree(sub.code,sub.level??2)===0?' zero':''}`}>{money(valueOfTree(sub.code,sub.level??2))}</span></div>
                  {grps.length>0&&<div className="coa2-map-l3-list" role="list">{grps.map((grp,gi,garr)=>{
                    const GrpIcon=iconOf(grp),kids=childrenOf(grp.code).length
                    return <div key={grp.code} className={`coa2-map-l3-item${gi===garr.length-1?' last':''}`} role="listitem">
                      <div className="coa2-map-l3-card">
                        <span className="coa2-map-l3-icon" aria-hidden="true"><GrpIcon/></span>
                        <div className="coa2-map-l3-body">
                          <span className="coa2-map-l3-name">{grp.name}</span>
                          <div className="coa2-map-l3-foot"><code className="coa2-map-code">{grp.code}</code><span className={`coa2-kind ${kindOf(grp).toLowerCase()} sm`}>{kindOf(grp)}</span><span className="coa2-map-count">{kids?`${kids} acct${kids!==1?'s':''}` :'—'}</span><span className={`coa2-map-bal${valueOfTree(grp.code,grp.level??3)===0?' zero':''}`}>{money(valueOfTree(grp.code,grp.level??3))}</span></div>
                        </div>
                      </div>
                    </div>
                  })}</div>}
                </div>
              </div>
            </div>
          })}</div>}
        </div>
      })}
    </div>
    {(()=>{const orphans=accounts.filter(m=>m.level===1&&childrenOf(m.code).length===0);if(!orphans.length)return null;return <div className="coa2-map-ungrouped" role="region" aria-label="Ungrouped accounts"><span className="coa2-map-ungrouped-label">Ungrouped</span><div className="coa2-map-ungrouped-cards">{orphans.map(a=>{const AIcon=iconOf(a);return <div key={a.code} className="coa2-map-orphan-card"><span className="coa2-map-orphan-icon" aria-hidden="true"><AIcon/></span><div className="coa2-map-orphan-body"><b>{a.name}</b><div className="coa2-map-orphan-foot"><code className="coa2-map-code">{a.code}</code><span className="coa2-kind header sm">Header</span><span className={`coa2-map-bal${valueOfTree(a.code,1)===0?' zero':''}`}>{money(valueOfTree(a.code,1))}</span></div></div></div>})}</div></div>})()}
  </section>
  :<section className={`coa2-table density-${density}`} style={{"--name-w":`${nameWidth}px`} as React.CSSProperties}>
   <div className="coa2-tr head"><span className="c-check"><label className="coa2-check"><input type="checkbox" aria-label="Select page" checked={allChecked} onChange={toggleAll}/><i><Check/></i></label></span><span className="c-name">Account Name <ChevronsUpDown/><span className="coa2-resizer" role="separator" aria-orientation="vertical" aria-label="Resize account name column" onPointerDown={startResize}/></span><span><Tag/> Code <ChevronsUpDown/></span><span><Filter/> Type <Filter className="f"/></span><span><FolderTree/> Parent Account <Filter className="f"/></span><span><Network/> Sub-accounts</span><span className="num"><Coins/> Balance (PKR) <ChevronsUpDown/></span><span><TrendingUp/> Change</span><span><CalendarDays/> Last Modified</span><span><Activity/> Status</span><span className="c-actions">Actions</span></div>
   {rows.map(({m,depth,last,trail})=>{const Icon=iconOf(m),kids=childrenOf(m.code).length,isOpen=open.has(m.code),chg=changeOf(m),mod=modifiedOf(m),parent=accounts.find(a=>a.code===m.parent);return <div key={m.code} className={`coa2-tr depth-${depth} ${selected.has(m.code)?'sel':''} ${m.level===1?'root':''}`}>
    <span className="c-check"><label className="coa2-check"><input type="checkbox" aria-label={`Select ${m.name}`} checked={selected.has(m.code)} onChange={()=>toggleSel(m.code)}/><i><Check/></i></label></span>
    <span className="c-name" style={{paddingLeft:10+(depth-1)*30}}>{trail.map((cont,k)=>{const own=k===depth-2;if(!own&&!cont)return null;return <i key={k} className={`coa2-guide ${own?(last?'end':''):''} ${own&&!kids?'elbow':''}`} style={{left:10+k*30+12}}/>})}{kids?<button type="button" aria-label={`${isOpen?'Collapse':'Expand'} ${m.name}`} onClick={()=>toggle(m.code)}>{isOpen?<ChevronDown/>:<ChevronRight/>}</button>:<i className="coa2-nochev"/>}<span className={`coa2-icon ${toneOf(m)}`}><Icon/></span><span className="coa2-name"><b>{m.name}</b>{descriptions[m.name]&&<small>{descriptions[m.name]}</small>}</span></span>
    <span className="c-code">{m.code}</span>
    <span><span className={`coa2-kind ${kindOf(m).toLowerCase()}`}>{kindOf(m)}</span></span>
    <span className="c-parent">{parent?`${parent.name} (${parent.code})`:'—'}</span>
    <span><span className={`coa2-count ${kids?'on':''}`}>{kids}</span></span>
    <span className="num c-balance">{money(valueOfTree(m.code,m.level??1))}</span>
    <span className={`c-change ${chg>0?'up':chg<0?'down':'flat'}`}><em>{chg>0?'▲':chg<0?'▼':'●'} {chg>0?'+':''}{chg.toFixed(1)}%</em>{chg===0?<i className="coa2-flat"/>:spark(chg<0?'red':'green')}</span>
    <span className="c-mod"><b>{mod.date}</b><small>by {mod.by}</small></span>
    <span><span className={`coa2-status ${m.status==='Active'?'on':'off'}`}>● {m.status}</span></span>
    <span className="c-actions"><button type="button" aria-label={`Actions for ${m.name}`} onClick={()=>m.level===4?navigate(`/finance/accounts/${m.code}`):setDel(m)}><EllipsisVertical/></button></span>
   </div>})}
   {!rows.length&&<div className="empty-state">No accounts match your filters.</div>}
   <div className="coa2-foot"><span>Showing {flat.length?(cur-1)*rowsPer+1:0}–{Math.min(cur*rowsPer,flat.length)} of {flat.length} accounts</span>
    <div className="coa2-foot-right"><span>Rows per page</span><label className="coa2-select plain sm"><select aria-label="Rows per page" value={rowsPer} onChange={e=>{setRowsPer(+e.target.value);setPage(1)}}>{[10,25,50,100].map(n=><option key={n}>{n}</option>)}</select><ChevronDown/></label>
     <div className="coa2-pager"><button aria-label="First page" disabled={cur===1} onClick={()=>setPage(1)}><ChevronsLeft/></button><button aria-label="Previous page" disabled={cur===1} onClick={()=>setPage(cur-1)}><ChevronLeft/></button>{Array.from({length:Math.min(5,pages)},(_,i)=>i+1).map(n=><button key={n} className={n===cur?'active':''} onClick={()=>setPage(n)}>{n}</button>)}<button aria-label="Next page" disabled={cur===pages} onClick={()=>setPage(cur+1)}><ChevronRight/></button><button aria-label="Last page" disabled={cur===pages} onClick={()=>setPage(pages)}><ChevronsRight/></button></div>
     <span>Go to page</span><input className="coa2-goto" aria-label="Go to page" value={cur} onChange={e=>setPage(Math.max(1,Math.min(pages,+e.target.value||1)))}/></div></div>
  </section>}

  {modal&&<MasterModal open={!!modal} list={accounts} presetType={modal.type==='Asset'?'Asset':'Account'} presetLevel={modal.level} presetParent={modal.parent} onClose={()=>setModal(null)} onSave={m=>onAdd(m)}/>}
  {del&&<Modal title={`Delete account — ${del.name}`} onClose={()=>setDel(null)}>
   <p style={{fontSize:12.5,color:'#334155',lineHeight:1.6}}>You are about to delete <b>{del.name}</b> ({del.code}, level {del.level}).</p>
   {deleteBlock(del)?<p style={{fontSize:12.5,color:'#92400e',background:'#FFF7E6',borderRadius:10,padding:12,lineHeight:1.5}}>⛔ {deleteBlock(del)}</p>:<p style={{fontSize:11.5,color:'#526470'}}>This account has no sub-accounts and no posted transactions, so it can be deleted.</p>}
   <div className="modal-foot"><Button kind="secondary" onClick={()=>setDel(null)}>Cancel</Button><Button kind="danger" disabled={!!deleteBlock(del)} onClick={()=>{onRemove(del.code);setSelected(s=>{const n=new Set(s);n.delete(del.code);return n});setDel(null)}}>Delete account</Button></div>
  </Modal>}
 </div>
}

function ChevronsUpDown(){return <svg className="coa2-sort" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>}
