'use client'
import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from '@/lib/router'
import { AlertTriangle, ArrowRight, BarChart3, Boxes, Calculator, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Clock3, Ellipsis, FileText, Landmark, ListChecks, Package, Percent, Plus, RefreshCw, ShoppingCart, Sparkles, UserPlus, Users, WalletCards, type LucideIcon } from 'lucide-react'
import type { AppData } from '@/mocks/api'
import { Button, Modal } from '@finsoft/ui'
import { money } from '@finsoft/ui'

type Priority='High'|'Medium'|'Low'
type Status='Pending'|'In Progress'|'Completed'|'Overdue'
type Task={id:string;title:string;detail:string;module:string;icon:LucideIcon;priority:Priority;due:string;status:Status;path:string}
type Filter='All'|'Pending'|'In Progress'|'Completed'|'Overdue'

const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const greeting=(h:number)=>h<12?'Good morning':h<17?'Good afternoon':'Good evening'
const longDate=(d:Date)=>`${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
const shortMonth=(d:Date)=>MONTHS[d.getMonth()].slice(0,3)

function buildTasks(data:AppData):Task[]{
 const drafts=data.vouchers.filter(v=>v.status==='Draft').length+data.pos.filter(p=>p.status==='Draft').length+data.purchases.filter(p=>p.status==='Draft').length
 const cheques=data.cheques.filter(c=>c.status==='Presented'||c.status==='In hand').length
 const lowStock=data.products.filter(p=>p.stock<=p.reorder).length
 const credit=data.sales.filter(s=>s.status==='Credit')
 return [
  {id:'t1',title:`Post received cheques (${cheques})`,detail:'Clear and post pending cheques',module:'Banking',icon:Landmark,priority:'High',due:'10:00 AM',status:cheques?'Pending':'Completed',path:'/cheque-clearing'},
  {id:'t2',title:`Approve drafts (${drafts})`,detail:'Vouchers, POs & purchase invoices',module:'Accounting',icon:FileText,priority:'Medium',due:'11:30 AM',status:drafts?'Pending':'Completed',path:'/approvals'},
  {id:'t3',title:`Update low stock items (${lowStock})`,detail:'Check items below reorder level',module:'Inventory',icon:Package,priority:'High',due:'01:00 PM',status:lowStock?'Overdue':'Completed',path:'/procurement'},
  {id:'t4',title:`Follow-up with ${credit.length} credit customers`,detail:`${money(credit.reduce((a,s)=>a+s.amount,0))} outstanding`,module:'Customers',icon:Users,priority:'Medium',due:'03:00 PM',status:credit.length?'Pending':'Completed',path:'/receivables'},
  {id:'t5',title:'Reconcile cash-book',detail:'Match cash transactions',module:'Accounting',icon:WalletCards,priority:'Low',due:'05:00 PM',status:'Completed',path:'/cash-book'},
 ]
}

const priorityTone:Record<Priority,string>={High:'red',Medium:'blue',Low:'green'}
const statusTone:Record<Status,string>={Pending:'amber','In Progress':'blue',Completed:'green',Overdue:'red'}

export function TodayWork({data,canPost}:{data:AppData;canPost:boolean}){
 const navigate=useNavigate()
 const now=useMemo(()=>new Date(),[])
 const [extra,setExtra]=useState<Task[]>([])
 const [done,setDone]=useState<Record<string,boolean>>({})
 const [filter,setFilter]=useState<Filter>('All')
 const [adding,setAdding]=useState(false)
 const tasks=useMemo(()=>[...buildTasks(data),...extra].map(t=>({...t,status:done[t.id]===undefined?t.status:done[t.id]?'Completed':t.status==='Completed'?'Pending':t.status} as Task)),[data,extra,done])
 const counts=(s:Filter)=>s==='All'?tasks.length:tasks.filter(t=>t.status===s).length
 const visible=filter==='All'?tasks:tasks.filter(t=>t.status===filter)
 const completed=counts('Completed'),overdue=counts('Overdue'),pct=tasks.length?Math.round(completed/tasks.length*100):0
 const addTask=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);setExtra(x=>[...x,{id:`x${Date.now()}`,title:String(f.get('title')),detail:String(f.get('detail')||''),module:String(f.get('module')),icon:ClipboardList,priority:f.get('priority') as Priority,due:String(f.get('due')),status:'Pending',path:'/today'}]);setAdding(false)}

 const quick:[string,string,LucideIcon,string][]=[['Create Invoice','/sales',FileText,'green'],['Record Payment','/payments',WalletCards,'blue'],['Add Customer','/customers',UserPlus,'teal'],['Add Product','/products',Package,'orange'],['Stock Adjustment','/inventory/count',Boxes,'mint'],['View Reports','/reports',BarChart3,'purple']]
 const recent:[string,string,string][]=[['Voucher register','2 hours ago','/vouchers'],['Today\'s Tasks (This Screen)','Just now','/today'],['Sales report','1 day ago','/reports'],['Customer details','2 days ago','/customers'],['Inventory overview','3 days ago','/inventory']]
 const agenda=[['10:00 AM','Month-end stock verification'],['11:30 AM','Send supplier payments'],['03:00 PM','Weekly sales meeting'],['05:00 PM','Reconcile cash-book']]
 const upcoming:[number,string,string,LucideIcon,string][]=[[1,'Month-end stock verification','Inventory  •  10:00 AM',Clock3,'/inventory/count'],[2,'Send supplier payments','Purchases  •  11:00 AM',ShoppingCart,'/payables'],[2,'Weekly sales meeting','Meeting  •  03:00 PM',Users,'/hr'],[4,'Generate financial statements','Accounting  •  11:00 AM',FileText,'/reports']]

 return <div className="tw">
  <aside className="tw-col">
   <section className="tw-card"><div className="tw-card-head"><h3>Quick Actions</h3><button className="tw-more" aria-label="More quick actions"><Ellipsis/></button></div>
    <div className="tw-quick">{quick.map(([label,path,Icon,tone])=><button key={label} className={`tw-quick-btn ${tone}`} onClick={()=>navigate(path)}><Icon/><span>{label}</span></button>)}</div></section>
   <CalcPad/>
  </aside>

  <div className="tw-col tw-main">
   <section className="tw-hero">
    <div><span className="tw-greet">{greeting(now.getHours())}, Sarah!</span><h1>Today’s Tasks</h1><strong>{longDate(now)}</strong><p>Here’s what’s on your plate today. Keep moving forward!</p></div>
    <div className="tw-hero-art"><span className="tw-note">A more organized day brings bigger tomorrows.</span><span className="tw-leaf a"/><span className="tw-leaf b"/><span className="tw-blob"/></div>
   </section>
   <section className="tw-stats">
    <Stat icon={ListChecks} tone="green" value={tasks.length-completed} label="Tasks Due Today"/>
    <Stat icon={AlertTriangle} tone="red" value={overdue} label="Overdue"/>
    <Stat icon={ListChecks} tone="blue" value={completed} label="Completed"/>
    <Stat icon={CalendarDays} tone="purple" value={tasks.length+upcoming.length} label="Scheduled This Week"/>
    <div className="tw-progress"><span className="tw-ring" style={{background:`conic-gradient(#15803D ${pct*3.6}deg,#e5eee9 0)`}}><b>{pct}%</b></span><div><b>Daily Progress</b><small>{completed} of {tasks.length} completed</small><i><i style={{width:`${pct}%`}}/></i></div></div>
   </section>

   <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><Sparkles/></span><div><h3>Recently worked on</h3><p>Screens and records you’ve opened recently</p></div></div><button className="tw-link" onClick={()=>navigate('/vouchers')}>View All <ArrowRight/></button></div>
    <div className="tw-recent">{recent.map(([label,when,path])=><button key={label} className={`tw-recent-card ${path==='/today'?'current':''}`} onClick={()=>navigate(path)}><span className="tw-thumb"><i/><i/><i/><i/></span><b>{label}</b><small>{when}</small></button>)}</div></section>

   <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><ClipboardList/></span><h3>Today’s Task List</h3></div><div className="tw-head-actions"><Button onClick={()=>setAdding(true)}><Plus/> Add Task</Button><button className="tw-more" aria-label="Task list options"><Ellipsis/></button></div></div>
    <div className="tw-pills">{(['All','Pending','In Progress','Completed','Overdue'] as Filter[]).map(f=><button key={f} className={filter===f?'active':''} onClick={()=>setFilter(f)}>{f} ({counts(f)})</button>)}</div>
    <div className="table-wrap tw-table"><table><thead><tr><th/><th>#</th><th>Task</th><th>Module</th><th>Priority</th><th>Due Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>
     {visible.map((t,i)=><tr key={t.id} className={t.status==='Completed'?'done':''}><td><input type="checkbox" aria-label={`Mark ${t.title} ${t.status==='Completed'?'pending':'complete'}`} checked={t.status==='Completed'} onChange={()=>setDone(d=>({...d,[t.id]:t.status!=='Completed'}))}/></td><td>{i+1}</td><td><div className="tw-task"><span className="tw-task-icon"><t.icon/></span><div><b>{t.title}</b><small>{t.detail}</small></div></div></td><td>{t.module}</td><td><span className={`tw-dot ${priorityTone[t.priority]}`}>{t.priority}</span></td><td>{t.due}</td><td><span className={`tw-status ${statusTone[t.status]}`}>{t.status}</span></td><td><button className="tw-more" aria-label={`Open ${t.title}`} disabled={!canPost&&t.path==='/approvals'} onClick={()=>navigate(t.path)}><ArrowRight/></button></td></tr>)}
     {!visible.length&&<tr><td colSpan={8}><div className="empty-state">No {filter.toLowerCase()} tasks.</div></td></tr>}
    </tbody></table></div></section>
  </div>

  <aside className="tw-col">
   <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><CalendarDays/></span><h3>Today’s Agenda</h3></div><button className="tw-link" onClick={()=>navigate('/hr')}>View All</button></div>
    <ul className="tw-agenda">{agenda.map(([time,what])=><li key={time}><span/><time>{time}</time><b>{what}</b></li>)}</ul></section>
   <MiniCalendar today={now}/>
   <section className="tw-card"><div className="tw-card-head"><h3>Upcoming Work</h3><button className="tw-link" onClick={()=>navigate('/approvals')}>View All</button></div>
    <div className="tw-upcoming">{upcoming.map(([offset,title,sub,Icon,path])=>{const d=new Date(now);d.setDate(d.getDate()+offset);return <button key={title} onClick={()=>navigate(path)}><span className="tw-date"><b>{d.getDate()}</b><small>{shortMonth(d)}</small></span><span className="tw-up-icon"><Icon/></span><div><b>{title}</b><small>{sub}</small></div><ChevronRight/></button>})}</div></section>
   <TaxCalc/>
  </aside>

  {adding&&<Modal title="Add task" onClose={()=>setAdding(false)}><form className="form-grid" onSubmit={addTask}>
   <label className="span-2">Task title<input name="title" required placeholder="e.g. Send supplier statements"/></label>
   <label className="span-2">Details<input name="detail" placeholder="Optional note"/></label>
   <label>Module<select name="module" defaultValue="Accounting">{['Accounting','Banking','Sales','Purchases','Inventory','Customers','HR'].map(m=><option key={m}>{m}</option>)}</select></label>
   <label>Priority<select name="priority" defaultValue="Medium">{['High','Medium','Low'].map(p=><option key={p}>{p}</option>)}</select></label>
   <label>Due time<input name="due" defaultValue="04:00 PM"/></label>
   <div className="modal-foot span-2"><Button kind="secondary" onClick={()=>setAdding(false)}>Cancel</Button><Button type="submit">Add task</Button></div>
  </form></Modal>}
 </div>
}

function Stat({icon:Icon,tone,value,label}:{icon:LucideIcon;tone:string;value:number;label:string}){
 return <div className="tw-stat"><span className={`tw-stat-icon ${tone}`}><Icon/></span><div><b>{value}</b><small>{label}</small></div></div>
}

function MiniCalendar({today}:{today:Date}){
 const [view,setView]=useState(()=>new Date(today.getFullYear(),today.getMonth(),1))
 const first=view.getDay(),days=new Date(view.getFullYear(),view.getMonth()+1,0).getDate(),prevDays=new Date(view.getFullYear(),view.getMonth(),0).getDate()
 const cells:{n:number;out:boolean}[]=[]
 for(let i=first-1;i>=0;i--)cells.push({n:prevDays-i,out:true})
 for(let i=1;i<=days;i++)cells.push({n:i,out:false})
 while(cells.length%7)cells.push({n:cells.length-first-days+1,out:true})
 const marks:Record<number,string[]>={[today.getDate()-2]:['task'],[today.getDate()+2]:['meet'],[today.getDate()+6]:['task','meet'],[today.getDate()-6]:['deadline'],[today.getDate()+5]:['deadline','meet'],[today.getDate()+8]:['overdue'],[today.getDate()+12]:['deadline']}
 const sameMonth=view.getMonth()===today.getMonth()&&view.getFullYear()===today.getFullYear()
 const shift=(n:number)=>setView(v=>new Date(v.getFullYear(),v.getMonth()+n,1))
 return <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><CalendarDays/></span><h3>Calendar</h3></div><div className="tw-cal-nav"><button onClick={()=>setView(new Date(today.getFullYear(),today.getMonth(),1))}>Today</button><button aria-label="Previous month" onClick={()=>shift(-1)}><ChevronLeft/></button><button aria-label="Next month" onClick={()=>shift(1)}><ChevronRight/></button></div></div>
  <h4 className="tw-cal-month">{MONTHS[view.getMonth()]} {view.getFullYear()}</h4>
  <div className="tw-cal">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><span key={d} className="dow">{d}</span>)}{cells.map((c,i)=><span key={i} className={`${c.out?'out':''} ${!c.out&&sameMonth&&c.n===today.getDate()?'today':''}`}>{c.n}{!c.out&&sameMonth&&marks[c.n]&&<i>{marks[c.n].map(m=><b key={m} className={m}/>)}</i>}</span>)}</div>
  <div className="tw-legend"><span><b className="task"/>Tasks</span><span><b className="meet"/>Meetings</span><span><b className="deadline"/>Deadlines</span><span><b className="overdue"/>Overdue</span></div></section>
}

function CalcPad(){
 const [display,setDisplay]=useState('0')
 const [acc,setAcc]=useState<number|null>(null)
 const [op,setOp]=useState<string|null>(null)
 const [fresh,setFresh]=useState(true)
 const apply=(a:number,b:number,o:string)=>o==='+'?a+b:o==='−'?a-b:o==='×'?a*b:o==='÷'?(b?a/b:0):b
 const digit=(d:string)=>{setDisplay(v=>fresh||v==='0'?(d==='.'?'0.':d):v.includes('.')&&d==='.'?v:v+d);setFresh(false)}
 const operate=(o:string)=>{const cur=parseFloat(display);const next=acc!==null&&op&&!fresh?apply(acc,cur,op):cur;setAcc(next);setDisplay(String(+next.toFixed(6)));setOp(o);setFresh(true)}
 const equals=()=>{if(acc===null||!op)return;const r=apply(acc,parseFloat(display),op);setDisplay(String(+r.toFixed(6)));setAcc(null);setOp(null);setFresh(true)}
 const percent=()=>setDisplay(v=>String(parseFloat(v)/100))
 const clear=()=>{setDisplay('0');setAcc(null);setOp(null);setFresh(true)}
 const keys=['7','8','9','÷','4','5','6','×','1','2','3','−','0','.','%','+']
 return <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><Calculator/></span><h3>Calculator</h3></div><button className="tw-chip" onClick={clear}>Clear</button></div>
  <output className="tw-calc-display" aria-live="polite">{display}</output>
  <div className="tw-calc"><div className="tw-keys">{keys.map(k=><button key={k} className={'÷×−+'.includes(k)?'op':''} onClick={()=>'÷×−+'.includes(k)?operate(k):k==='%'?percent():digit(k)}>{k}</button>)}</div><button className="tw-equals" onClick={equals} aria-label="Equals">=</button></div></section>
}

function TaxCalc(){
 const [amount,setAmount]=useState('100000')
 const [rate,setRate]=useState('17')
 const [type,setType]=useState('Sales Tax (VAT)')
 const net=parseFloat(amount)||0,tax=net*(parseFloat(rate)||0)/100
 const reset=()=>{setAmount('100000');setRate('17');setType('Sales Tax (VAT)')}
 return <section className="tw-card"><div className="tw-card-head"><div className="tw-title"><span className="tw-title-icon"><Percent/></span><div><h3>Tax Calculator</h3><p>Calculate tax amount and total instantly.</p></div></div><button className="tw-more" aria-label="Reset tax calculator" onClick={reset}><RefreshCw/></button></div>
  <div className="tw-tax-form"><label>Amount<span className="tw-amount"><i>PKR</i><input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></span></label><label>Tax %<span className="tw-amount"><input inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)}/><i>%</i></span></label><label>Tax Type<select value={type} onChange={e=>setType(e.target.value)}>{['Sales Tax (VAT)','Income Tax','Withholding Tax','Excise Duty'].map(t=><option key={t}>{t}</option>)}</select></label></div>
  <div className="tw-tax-out"><div><small>Net Amount</small><b>{money(net)}</b></div><div><small>Tax Amount</small><b>{money(tax)}</b></div><div><small>Total Amount</small><b>{money(net+tax)}</b></div></div></section>
}
