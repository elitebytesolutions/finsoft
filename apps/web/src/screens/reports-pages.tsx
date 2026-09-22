'use client'
import { useState } from 'react'
import { useNavigate, useParams } from '@/lib/router'
import { Activity, ArrowRight, BookOpen, Boxes, ChartNoAxesCombined, ChartPie, CheckCircle2, ChevronDown, CircleDollarSign, Clock3, Download, FileText, Landmark, Plus, Printer, ReceiptText, Scale, Search, Settings2, ShieldCheck, ShoppingBag, Trash2, TrendingUp, Users, WalletCards, type LucideIcon } from 'lucide-react'
import { reportSources, reports as builtins, type ColDef, type ReportTemplate } from '@/mocks/api'
import type { AppData } from '@/mocks/api'
import { financialSummary, runReport, exportCsv, sourceMeta } from './report-engine'
import { Badge, Button, PageHead, Panel, Table } from '@finsoft/ui'
import { money } from '@finsoft/ui'

const icons:Record<string,LucideIcon>={ChartNoAxesCombined,Users,Boxes,Clock3,Landmark,FileText,WalletCards,ReceiptText,ShoppingBag}
const catColor=(c:string):'good'|'info'|'warn'|'neutral'=>c==='Finance'?'info':c==='Sales'||c==='Purchasing'?'good':c==='HR'?'warn':'neutral'
const STATEMENT_SLUGS=['profit-loss','balance-sheet','trial-balance']

function TemplateCard({t,onRun,onDelete,onClone}:{t:ReportTemplate;onRun:()=>void;onDelete?:()=>void;onClone?:()=>void}){
 const Icon=icons[t.icon]??FileText
 return <article className="report-card"><span className="report-icon"><Icon/></span><Badge tone={catColor(t.category)}>{t.category}</Badge><h3>{t.name}</h3><p>{t.description}</p><div style={{display:'flex',justifyContent:'space-between',marginTop:12}}><button className="linkable" onClick={onRun}>Run report <ArrowRight size={13}/></button>{t.builtIn?null:<span style={{display:'flex',gap:8}}><button className="linkable" onClick={onClone}>Clone</button><button className="linkable" style={{color:'#b45309'}} onClick={onDelete}><Trash2 size={13}/></button></span>}</div></article>
}
export function ReportsCentre({data,onAddTemplate,onDelete}:{data:AppData;onAddTemplate:(t:ReportTemplate)=>void;onDelete:(id:string)=>void}){
 const navigate=useNavigate()
 const [q,setQ]=useState(''),[pick,setPick]=useState('profit-loss'),[zoom,setZoom]=useState(100),[adv,setAdv]=useState(false)
 const grid=data.templates.filter(t=>!STATEMENT_SLUGS.includes(t.id)&&`${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()))
 const fs=financialSummary(data)
 const clone=(t:ReportTemplate)=>{onAddTemplate({...t,id:`${t.id}-copy`,name:`${t.name} (copy)`,builtIn:false,savedBy:'Ahmed Raza'});void 0}
 const choices:{slug:string;name:string;desc:string;icon:LucideIcon;source:string}[]=[
  {slug:'profit-loss',name:'Income statement',desc:'Revenue, expenses and profit for a period',icon:ChartNoAxesCombined,source:'pnl'},
  {slug:'balance-sheet',name:'Balance sheet',desc:'Assets, liabilities and equity position',icon:FileText,source:'bs'},
  {slug:'trial-balance',name:'Trial balance',desc:'All ledger balances with debit/credit',icon:Scale,source:'trial'},
  {slug:'cash-flow',name:'Cash flow',desc:'Cash inflows and outflows',icon:CircleDollarSign,source:'cashbook'},
  {slug:'account-ledger',name:'Account ledger',desc:'Detailed account transactions',icon:BookOpen,source:'ledger'},
  {slug:'ratio-analysis',name:'Ratio analysis',desc:'Key financial ratios and performance',icon:ChartPie,source:'pnl'},
 ]
 const chosen=choices.find(c=>c.slug===pick)!
 const tpl=builtins.find(b=>b.slug===pick)
 const cols=tpl?.columns??[{key:'heading',label:'Particulars'},{key:'value',label:'Aug 2026 (Rs)'}]
 const preview=runReport(data,chosen.source,cols,'2026-08-01','2026-08-30')
 const fileName=`${chosen.name.replace(/ /g,'_')}_Aug_2026.pdf`
 const recent:[string,string,string,LucideIcon][]=[['Income statement','30 Aug 2026, 4:12 PM','PDF',ChartNoAxesCombined],['Balance sheet','28 Aug 2026, 10:24 AM','PDF',FileText],['Trial balance','25 Aug 2026, 2:41 PM','XLSX',Scale],['Cash flow statement','20 Aug 2026, 9:15 AM','PDF',CircleDollarSign]]
 const kpi=(icon:LucideIcon,label:string,value:string,delta:string,up:boolean)=>{const I=icon;return <div className="fst-kpi"><span className="fst-kpi-ico"><I/></span><div><small>{label}</small><b>{value}</b><em className={up?'up':'down'}>{up?'↑':'↓'} {delta} <span>vs. previous period</span></em></div><svg className="fst-spark" viewBox="0 0 60 20" aria-hidden="true"><path d="M1 14 L10 9 L19 12 L28 6 L37 10 L46 4 L59 8" fill="none" stroke="#1b7f47" strokeWidth="1.5"/></svg></div>}
 return <div className="fst-page">
  <div className="fst-hero">
   <div><span className="fst-eyebrow">Reports / Reports centre</span><h1>Financial Statements</h1><p>Generate, view and share accurate financial reports from your live accounting data — with powerful filters, flexible formats and professional templates.</p></div>
   <div className="fst-hero-actions"><label className="fst-search"><Search/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search reports, templates or accounts..."/><kbd>Ctrl K</kbd></label><Button onClick={()=>navigate(`/reports/${pick}`)}><Plus/> Generate Report</Button><Button kind="secondary"><Download/> Export</Button><Button kind="secondary" onClick={()=>navigate('/reports/templates')}><FileText/> Template Library</Button></div>
   <em className="fst-tagline">Turning numbers<br/>into smarter decisions</em>
  </div>

  <section className="fst-kpis" aria-label="Key figures">
   {kpi(ChartNoAxesCombined,'Revenue',money(fs.revenue),'12%',true)}
   {kpi(WalletCards,'Assets',money(fs.assets),'8%',true)}
   {kpi(FileText,'Liabilities',money(fs.liabilities),'4%',false)}
   {kpi(TrendingUp,'Net Profit',money(fs.net),'18%',true)}
   <div className="fst-kpi status"><span className="fst-kpi-ico"><ShieldCheck/></span><div><small>Status</small><b><i/> {fs.totalDebit===fs.totalCredit?'All systems balanced':'Ledger out of balance'}</b><em>Last updated 30 Aug 2026, 4:12 PM</em></div></div>
  </section>

  <div className="fst-section-head"><h2>Choose a report</h2><button className="linkable" onClick={()=>navigate('/reports/templates')}>View all reports <ArrowRight size={13}/></button></div>
  <div className="fst-choices">{choices.map(c=>{const I=c.icon;return <button key={c.slug} className={pick===c.slug?'on':''} onClick={()=>setPick(c.slug)}><span className="fst-choice-ico"><I/></span><b>{c.name}</b><p>{c.desc}</p><span className="fst-go" onClick={e=>{e.stopPropagation();navigate(`/reports/${c.slug}`)}}><ArrowRight/></span></button>})}</div>

  <div className="fst-work">
   <div className="fst-left">
    <div className="fst-panel">
     <h3>Report settings</h3>
     <label className="fst-row"><span>Report type</span><div className="fst-input"><select value={pick} onChange={e=>setPick(e.target.value)}>{choices.map(c=><option key={c.slug} value={c.slug}>{c.name}</option>)}</select></div></label>
     <label className="fst-row"><span>Date range</span><div className="fst-input"><Clock3/><select defaultValue="1 Aug 2026 – 31 Aug 2026"><option>1 Aug 2026 – 31 Aug 2026</option><option>1 Jul 2026 – 31 Jul 2026</option><option>Year to date</option></select></div></label>
     <label className="fst-row"><span>Comparison</span><div className="fst-input"><select defaultValue="Previous period"><option>Previous period</option><option>Same period last year</option><option>None</option></select></div></label>
     <label className="fst-row"><span>Accounting method</span><div className="fst-input"><select defaultValue="Accrual (Default)"><option>Accrual (Default)</option><option>Cash</option></select></div></label>
     <label className="fst-row"><span>Format</span><div className="fst-input"><FileText/><select defaultValue="PDF (Recommended)"><option>PDF (Recommended)</option><option>Excel (XLSX)</option><option>CSV</option></select></div></label>
     <button className="fst-adv" onClick={()=>setAdv(!adv)} aria-expanded={adv}><Settings2/> Advanced options <ChevronDown className={adv?'open':''}/></button>
     {adv&&<div className="fst-adv-body"><label><input type="checkbox" defaultChecked/> Show zero-balance accounts</label><label><input type="checkbox" defaultChecked/> Include notes and schedules</label><label><input type="checkbox"/> Consolidate all branches</label></div>}
     <Button onClick={()=>navigate(`/reports/${pick}`)}><FileText/> Generate Report</Button>
    </div>
    <div className="fst-panel">
     <div className="fst-panel-head"><h3>Recent generated reports</h3><button className="linkable" onClick={()=>navigate('/reports/templates')}>View all <ArrowRight size={13}/></button></div>
     {recent.map(([n,d,f,I])=><div className="fst-recent" key={n}><span><I/></span><b>{n}</b><small>{d}</small><Badge tone="good">{f}</Badge><button aria-label={`More for ${n}`}>···</button></div>)}
    </div>
   </div>

   <div className="fst-panel fst-preview">
    <div className="fst-preview-bar"><div><b>{fileName}</b><small>Page 1 of 3 &nbsp;|&nbsp; {zoom}%</small></div>
     <span className="fst-zoom"><button aria-label="Zoom out" onClick={()=>setZoom(z=>Math.max(50,z-10))}>−</button><b>{zoom}%</b><button aria-label="Zoom in" onClick={()=>setZoom(z=>Math.min(200,z+10))}>+</button></span>
     <Button kind="secondary" onClick={()=>exportCsv(preview.cols,preview.rows)}><Download/> Download</Button><Button kind="secondary" onClick={()=>window.print()}><Printer/> Print</Button><Button kind="secondary"><FileText/> Export as <ChevronDown/></Button></div>
    <div className="fst-canvas">
     <div className="fst-thumbs">{[1,2,3].map(n=><button key={n} className={n===1?'on':''} aria-label={`Page ${n}`}><span><i/><i/><i/><i/><i/></span><small>{n}</small></button>)}</div>
     <article className="fst-sheet" style={{transform:`scale(${zoom/100})`}}>
      <header><div><b>Bhatti Traders (Pvt) Ltd</b><small>Main Road, Lahore, Pakistan</small><small>Registration No: PV 123456</small></div><div className="fst-sheet-logo"><Activity/><div><b>Bhatti Traders</b><small>Growth Together</small></div></div></header>
      <div className="fst-sheet-title"><div><h2>{chosen.name}</h2><p>For the period 1 August 2026 to 31 August 2026</p></div><small>Generated on: 30 Aug 2026, 4:12 PM<br/>Accounting method: Accrual</small></div>
      <table className="fst-stmt"><thead><tr>{preview.cols.map((c,i)=><th key={c.key} className={i?'num':''}>{i===0?'Particulars':c.label}</th>)}{preview.cols.length===2&&<th className="num">Jul 2026 (Rs)</th>}</tr></thead>
       <tbody>{preview.rows.map((r,i)=>r._sec?<tr className="sec" key={i}><td colSpan={preview.cols.length+1}>{r[preview.cols[0].key]}</td></tr>:<tr key={i} className={r._t?'total':r._b?'sub':''}>{preview.cols.map((c,j)=><td key={c.key} className={j?'num':''}>{r[c.key]}</td>)}{preview.cols.length===2&&<td className="num">{prevOf(r[preview.cols[1].key])}</td>}</tr>)}</tbody></table>
     </article>
    </div>
   </div>
  </div>

  <Panel title="All templates & saved reports" sub={`${grid.length} operational reports · every figure streams from live store data`}>{grid.length?<div className="report-grid">{grid.map(t=><TemplateCard key={t.id} t={t} onRun={()=>navigate(`/reports/${t.id}`)} onDelete={()=>onDelete(t.id)} onClone={()=>clone(t)}/>)}</div>:<div className="empty-state">No templates match your search.</div>}</Panel>
 </div>
}
/* rough prior-period figure for the comparison column: ~87% of current, formatted like the source */
const prevOf=(v?:string)=>{if(!v)return '';const n=Number(String(v).replace(/[^\d.-]/g,''));if(!n)return '—';const p=Math.round(n*0.87);return String(v).replace(/[\d,]+(?:\.\d+)?/,p.toLocaleString('en-PK'))}

const stmtIcon:Record<string,LucideIcon>={pnl:ChartNoAxesCombined,bs:WalletCards,trial:Scale}

export function ReportOutput({data}:{data:AppData}){
 const navigate=useNavigate(),{id}=useParams()
 const [from,setFrom]=useState('2026-08-01'),[to,setTo]=useState('2026-08-30')
 const template=data.templates.find(t=>t.id===id)??builtins.find(b=>b.slug===id) as unknown as ReportTemplate|undefined
 if(!template)return <div className="state-page"><span><FileText/></span><h1>Report not found</h1><p>No report matches that template.</p><Button kind="secondary" onClick={()=>navigate('/reports')}>Back to reports</Button></div>
 const res=runReport(data,template.source,template.columns,from,to)
 const cols=res.cols,rows=res.rows
 const isStatement=template.source==='pnl'||template.source==='bs'||template.source==='trial'
 const total=isStatement?null:numericSum(rows,cols)
 const rightAlign=new Set(['amount','debit','credit','value','total','net','salary','balance','cost','price','gross'])
 const balanced=rows.find(r=>r._t)
 const fs=isStatement?financialSummary(data,from,to):null
 const margin=fs&&fs.revenue?((fs.net/fs.revenue)*100).toFixed(1):'0.0'
 const StmtIcon=stmtIcon[template.source]??FileText
 const isBalanced=template.source==='trial'?balanced?.debit===balanced?.credit:template.source==='bs'?fs&&fs.assets===fs.liabilities+fs.netWorth:true
 return <>
  <PageHead eyebrow="Reports / Output" title={template.name} description={template.description} actions={<><Button kind="secondary"><Printer/> Print</Button><Button onClick={()=>exportCsv(cols,rows)}><Download/> Export CSV</Button></>}/>
  <div className="toolbar"><label className="toolbar-field">From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="toolbar-field">To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><select aria-label="Branch"><option>All branches</option><option>Lahore Main</option><option>Rawalpindi</option></select><span className="record-count">{rows.length} rows · {isStatement?'derived from the posted ledger':'live from store data'}</span></div>

  {isStatement&&fs&&<div className="stmt-hero">
   <span className="stmt-hero-icon"><StmtIcon/></span>
   <div className="stmt-hero-metrics">
    {template.source==='pnl'&&<><div><small>Revenue</small><b>{money(fs.revenue)}</b></div><div><small>Gross profit</small><b>{money(fs.gross)}</b></div><div><small>Net profit</small><b className="pos">{money(fs.net)}</b><em>{margin}% margin</em></div></>}
    {template.source==='bs'&&<><div><small>Total assets</small><b>{money(fs.assets)}</b></div><div><small>Liabilities</small><b>{money(fs.liabilities)}</b></div><div><small>Net worth</small><b className="pos">{money(fs.netWorth)}</b></div></>}
    {template.source==='trial'&&<><div><small>Accounts</small><b>{fs.trialAccounts}</b></div><div><small>Total debit</small><b>{money(fs.totalDebit)}</b></div><div><small>Total credit</small><b>{money(fs.totalCredit)}</b></div></>}
   </div>
   {template.source!=='pnl'&&<span className={`stmt-balance ${isBalanced?'good':'bad'}`}><CheckCircle2/> {isBalanced?'Balanced':'Out of balance'}</span>}
  </div>}

  <Panel title={template.name} sub={`${template.category} · template ${template.builtIn?'(built-in)':'(custom)'}`}><div className={`report-table ${isStatement?'stmt-table':''}`}>{rows.length?<table><thead><tr>{cols.map(c=><th key={c.key} style={rightAlign.has(c.key)?{textAlign:'right'}:undefined}>{c.label}</th>)}</tr></thead><tbody>{rows.map((r,i)=>r._sec?<tr className="rep-sec" key={i}><td colSpan={cols.length}>{r[cols[0].key]}</td></tr>:<tr key={i} className={r._t?'rep-total':r._b?'rep-subtotal':''}>{cols.map(c=><td key={c.key} style={rightAlign.has(c.key)?{textAlign:'right',fontVariantNumeric:'tabular-nums'}:undefined}>{r[c.key]}</td>)}</tr>)}</tbody></table>:<div className="empty-state">No rows for this period — widen the date range or post more entries.</div>}</div>
  {template.source==='trial'&&balanced&&<div className="stmt-footnote"><Scale/> Dr {balanced.debit} · Cr {balanced.credit} — trial balance is {balanced.debit===balanced.credit?'balanced':'unbalanced'}</div>}
  {!isStatement&&typeof total==='number'&&<div className="modal-foot" style={{border:0,padding:'14px 0 0'}}><span className="record-count">Column totals: {money(total)}</span></div>}
  </Panel>
 </>
}
function numericSum(rows:Record<string,string>[],cols:ColDef[]){let s=0,found=false;for(const r of rows)for(const c of cols){const v=parseInt((r[c.key]??'').replace(/[^\d]/g,''),10)||0;if(v){found=true;s+=v}}return found?s:null}

export function ReportStudio({data,onAddTemplate}:{data:AppData;onAddTemplate:(t:ReportTemplate)=>void}){
 const navigate=useNavigate()
 const [source,setSource]=useState('sales'),[name,setName]=useState(''),[desc,setDesc]=useState(''),[category,setCategory]=useState('Sales')
 const meta=sourceMeta[source]??[]
 const [picked,setPicked]=useState<string[]>([])
 const chooseSource=(s:string)=>{setSource(s);setPicked(sourceMeta[s]?.map(c=>c.key)??[])}
 const toggle=(k:string)=>setPicked(p=>p.includes(k)?p.filter(x=>x!==k):[...p,k])
 const preview=runReport(data,source,meta.filter(c=>picked.includes(c.key)))
 const save=()=>{if(!name.trim()||!picked.length)return alert('Give the template a name and pick at least one column.');const cols=meta.filter(c=>picked.includes(c.key));const t:ReportTemplate={id:`tpl-${String(1000+data.templates.filter(x=>!x.builtIn).length).padStart(4,'0')}`,name:name.trim(),description:desc.trim()||'Custom report',icon:category==='Finance'?'Landmark':category==='Inventory'?'Boxes':category==='HR'?'Users':'ChartNoAxesCombined',category,source,columns:cols,savedBy:'Ahmed Raza'};onAddTemplate(t);navigate(`/reports/${t.id}`)}
 return <>
  <PageHead eyebrow="Reports / Studio" title="Report studio" description="Design a report template — pick a data source, choose columns and save it to the library." actions={<Button kind="secondary" onClick={()=>navigate('/reports/templates')}>Templates</Button>}/>
  <div className="rs-grid"><section className="rs-config panel"><h3>1 · Data source</h3><select value={source} onChange={e=>chooseSource(e.target.value)}>{reportSources.map(s=><option key={s} value={s}>{s}</option>)}</select>
   <h3>2 · Columns</h3><div className="tag-list">{meta.map(c=><label key={c.key} className={picked.includes(c.key)?'ck on':'ck'}><input type="checkbox" checked={picked.includes(c.key)} onChange={()=>toggle(c.key)}/>{c.label}</label>)}</div>
   <h3>3 · Save template</h3><div className="form-grid"><label>Name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. High-value sales"/></label><label>Description<input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Short note"/></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}><option>Sales</option><option>Purchasing</option><option>Inventory</option><option>Finance</option><option>HR</option></select></label></div>
   <Button onClick={save}><Plus/> Save template</Button></section>
   <section className="panel rs-preview"><div className="panel-head"><div><h3>Preview</h3><p>{rowsText(preview.rows.length)}</p></div><Button kind="ghost" onClick={()=>exportCsv(preview.cols,preview.rows)}>Export</Button></div><Table headers={preview.cols.map(c=>c.label)} rows={preview.rows.slice(0,12).map(r=>preview.cols.map(c=>r[c.key]??'—'))}/></section></div>
 </>
}
const rowsText=(n:number)=>n===0?'No rows yet':`${n} rows live`

export function ReportTemplates({data,onDelete}:{data:AppData;onDelete:(id:string)=>void}){
 const navigate=useNavigate()
 const [cat,setCat]=useState('All')
 const list=data.templates.filter(t=>cat==='All'||t.category===cat)
 return <>
  <PageHead eyebrow="Reports / Template library" title="Template library" description="Built-in reports and saved templates — organise, clone and delete your layouts." actions={<Button onClick={()=>navigate('/reports/studio')}><Plus/> New template</Button>}/>
  <div className="toolbar"><div className="vou-chips">{['All','Sales','Purchasing','Inventory','Finance','HR'].map(c=><button key={c} className={cat===c?'active':''} onClick={()=>setCat(c)}>{c}</button>)}</div><span className="record-count">{list.length} templates ({data.templates.filter(t=>t.builtIn).length} built-in · {data.templates.filter(t=>!t.builtIn).length} custom)</span></div>
  <div className="report-grid">{list.map(t=><TemplateCard key={t.id} t={t} onRun={()=>navigate(`/reports/${t.id}`)} onDelete={()=>onDelete(t.id)} onClone={()=>{void 0}}/>)}</div>
 </>
}
