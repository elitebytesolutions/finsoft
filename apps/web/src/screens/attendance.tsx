'use client'
import { useMemo, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
 ArrowRight, ArrowUpDown, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, Ellipsis, FileText, ListFilter, LogOut, MapPin, MessageSquareText, Phone, Plus, Route, Search, Users, UsersRound, type LucideIcon,
} from 'lucide-react'

type Status='On Field'|'Checked Out'|'Absent'|'Not Checked In'
type Visit={time:string;kind:'in'|'visit'|'out';title:string;sub:string;place?:string;note?:string}
type Salesman={id:string;name:string;area:string;city:string;status:Status;inAt:string;outAt:string;active:string;km:number;visits:Visit[];notes:{title:string;sub:string;time:string}[];records:{title:string;sub:string;time:string;icon:'file'|'pin'}[]}

const areas:[string,string][]=[['Model Town','Lahore North'],['DHA Phase 5','Lahore'],['Johar Town','Lahore'],['Gulberg','Lahore'],['Shalimar','Lahore'],['Faisal Town','Lahore'],['Samanabad','Lahore'],['Wapda Town','Lahore'],['Iqbal Town','Lahore'],['Cantt','Lahore'],['Bahria Town','Lahore'],['Township','Lahore']]
const names=['Ali Hassan','Fahad Ahmed','Sameer Bashir','Mubeen Khan','Rizwan Ali','Hamza Siddiqui','Tahir Abbas','Usman Saleem','Hassan Khan','Bilal Ahmed','Kamran Shah','Zain Malik','Adeel Raza','Farhan Iqbal','Noman Tariq','Saad Butt','Junaid Akram','Imran Qureshi','Waqas Ali','Shahid Mehmood','Asim Nawaz','Danish Javed','Faisal Rauf','Yasir Hameed']
const statusPlan:Status[]=['Checked Out','On Field','Checked Out','Absent','On Field','Checked Out','On Field','Not Checked In','Checked Out','On Field','On Field','On Field','Checked Out','On Field','On Field','Absent','On Field','On Field','Checked Out','On Field','On Field','Not Checked In','On Field','On Field']
const customers=['Al-Falah Super Store','Rashid Traders','Khan & Sons','City Pharmacy','Medicare Plus','Noor Medical Store','Shifa Pharmacy','Hamza General Store']
const pad=(n:number)=>String(n).padStart(2,'0')
const clock=(h:number,m:number)=>{const hh=((h+11)%12)+1;return `${pad(hh)}:${pad(m)} ${h>=12?'PM':'AM'}`}
const build=(i:number):Salesman=>{
 const status=statusPlan[i];const [area,city]=areas[i%areas.length]
 const inH=8,inM=(15+i*17)%50,outH=17+(i%3),outM=(20+i*13)%60
 const inAt=status==='Absent'||status==='Not Checked In'?'':clock(inH,inM)
 const outAt=status==='Checked Out'?clock(outH,outM):''
 const mins=status==='Checked Out'?(outH*60+outM)-(inH*60+inM):status==='On Field'?(15*60+30)-(inH*60+inM):0
 const active=mins?`${Math.floor(mins/60)}h ${mins%60}m`:'--'
 const visits:Visit[]=inAt?[{time:inAt,kind:'in',title:'Checked In',sub:area,note:'Check-in via mobile app'}]:[]
 if(inAt){const stops=[[10,35],[13,20],[16,10]] as const;const n=status==='On Field'?2:3;for(let k=0;k<n;k++){const c=customers[(i+k)%customers.length];visits.push({time:clock(stops[k][0],stops[k][1]),kind:'visit',title:'Visited Customer',sub:c,place:areas[(i+k+1)%areas.length][0],note:['Meeting & product discussion',`Order placed - PKR ${(18+((i*7+k*5)%30)).toLocaleString()},000`,'New outlet discussion'][k]})}}
 if(outAt)visits.push({time:outAt,kind:'out',title:'Checked Out',sub:area,note:`End of day - Total ${active}`})
 return {id:`SM-${String(i+1).padStart(3,'0')}`,name:names[i],area,city,status,inAt,outAt,active,km:inAt?18+((i*11)%30):0,visits,
  notes:inAt?[{title:`Met with ${customers[i%customers.length]}`,sub:'Discussed new product range. Positive response.',time:clock(10,35)},{title:'Client interested in premium line',sub:'Follow up next week with sample.',time:clock(16,10)}]:[],
  records:[{title:'Manual entry added',sub:inAt?'Check-out time updated by admin':'Marked absent by admin',time:'2 min ago',icon:'file'},...(inAt?[{title:'Location verified',sub:`${area} (${inAt})`,time:'15 min ago',icon:'pin' as const}]:[])]}
}
const salesmen:Salesman[]=names.map((_,i)=>build(i))

const initials=(n:string)=>n.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase()
const tone=(s:Status)=>s==='On Field'?'field':s==='Checked Out'?'out':s==='Absent'?'absent':'none'
const StatusPill=({s}:{s:Status})=><span className={`at-status ${tone(s)}`}><i/>{s}</span>
const Spark=({tone}:{tone:string})=><svg className={`at-spark ${tone}`} viewBox="0 0 80 28" preserveAspectRatio="none" aria-hidden="true"><path d="M0 22 C10 20 14 10 22 12 S34 24 42 18 S56 4 64 8 S74 18 80 6" fill="none" strokeWidth="2"/><path d="M0 22 C10 20 14 10 22 12 S34 24 42 18 S56 4 64 8 S74 18 80 6 V28 H0 Z" stroke="none" opacity=".18"/></svg>

export function SalesmanAttendance(){
 const navigate=useNavigate()
 const [tab,setTab]=useState<'all'|'in'|'field'|'out'|'absent'>('all'),[q,setQ]=useState(''),[sort,setSort]=useState<'default'|'status'|'name'|'time'>('default'),[page,setPage]=useState(1),[per,setPer]=useState(10),[sel,setSel]=useState(salesmen[0].id),[dtab,setDtab]=useState<'activity'|'locations'|'notes'|'records'>('activity')
 const counts={all:salesmen.length,in:salesmen.filter(s=>s.status==='On Field'||s.status==='Checked Out').length,field:salesmen.filter(s=>s.status==='On Field').length,out:salesmen.filter(s=>s.status==='Checked Out').length,absent:salesmen.filter(s=>s.status==='Absent'||s.status==='Not Checked In').length}
 const list=useMemo(()=>{const qq=q.trim().toLowerCase();const order:Status[]=['On Field','Checked Out','Not Checked In','Absent']
  return salesmen.filter(s=>tab==='all'||(tab==='in'&&(s.status==='On Field'||s.status==='Checked Out'))||(tab==='field'&&s.status==='On Field')||(tab==='out'&&s.status==='Checked Out')||(tab==='absent'&&(s.status==='Absent'||s.status==='Not Checked In')))
   .filter(s=>!qq||s.name.toLowerCase().includes(qq)||s.id.toLowerCase().includes(qq)||s.area.toLowerCase().includes(qq))
   .sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='time'?(a.inAt||'zz').localeCompare(b.inAt||'zz'):sort==='status'?order.indexOf(a.status)-order.indexOf(b.status):0)},[tab,q,sort])
 const pages=Math.max(1,Math.ceil(list.length/per));const cur=Math.min(page,pages);const rows=list.slice((cur-1)*per,cur*per)
 const s=salesmen.find(x=>x.id===sel)??salesmen[0]
 const kpis:[string,number,string,LucideIcon,string][]=[['Total Salesmen',counts.all,'Active in system',UsersRound,'green'],['Checked In',counts.in,`${Math.round(counts.in/counts.all*100)}% of total`,CheckCircle2,'green'],['On Field',counts.field,`${Math.round(counts.field/counts.all*100)}% of total`,Clock3,'amber'],['Not Checked In',counts.absent,`${Math.round(counts.absent/counts.all*100)}% of total`,Users,'grey'],['Checked Out',counts.out,`${Math.round(counts.out/counts.all*100)}% of total`,LogOut,'red']]
 const visited=s.visits.filter(v=>v.kind==='visit')
 return <div className="at-page">
  <div className="at-head"><div><h1>Salesman Attendance</h1><p>Monitor your field team's presence, activity and performance in real time.</p></div>
   <div className="at-head-tools"><div className="at-date"><CalendarDays/><span>Mon, 15 Sep 2026</span><button type="button" aria-label="Previous day"><ChevronLeft/></button><button type="button" aria-label="Next day"><ChevronRight/></button></div><button type="button" className="at-btn soft"><Download/> Export</button><button type="button" className="at-btn solid" onClick={()=>navigate('/hr/attendance/entry')}><Plus/> Add Manual Entry</button></div></div>
  <div className="at-kpis">{kpis.map(([label,value,sub,Icon,t])=><div className={`at-kpi ${t}`} key={label}><span className="at-kpi-icon"><Icon/></span><div><small>{label}</small><b>{value}</b><em>{sub}</em></div><span className="at-kpi-pct">{Math.round(value/counts.all*100)}%</span><Spark tone={t}/></div>)}</div>
  <div className="at-body">
   <section className="at-card at-list">
    <div className="at-list-head"><h2>Salesmen Attendance</h2><p>View and manage attendance status of your field team</p></div>
    <div className="at-tabs" role="tablist">{([['all','All Salesmen'],['in','Checked In'],['field','On Field'],['out','Checked Out'],['absent','Absent']] as const).map(([k,l])=><button type="button" role="tab" aria-selected={tab===k} key={k} className={tab===k?'active':''} onClick={()=>{setTab(k);setPage(1)}}>{l} ({counts[k]})</button>)}</div>
    <div className="at-tools"><label className="at-search"><Search/><input aria-label="Search salesmen" placeholder="Search by name, code or area..." value={q} onChange={e=>{setQ(e.target.value);setPage(1)}}/></label><button type="button" className="at-btn soft"><ListFilter/> Filters</button><label className="at-sort"><ArrowUpDown/><span>Sort:</span><select aria-label="Sort" value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="default">Status</option><option value="status">Status group</option><option value="name">Name</option><option value="time">Check-in time</option></select><ChevronDown/></label></div>
    <div className="at-rows">{rows.map(r=><div key={r.id} className={`at-row ${r.id===sel?'sel':''}`} onClick={()=>setSel(r.id)}>
     <span className="at-avatar">{initials(r.name)}</span><div className="at-who"><b>{r.name}</b><small>{r.id}</small></div><StatusPill s={r.status}/>
     <div className="at-time"><Clock3/><div>{r.inAt?<><b>{r.inAt} – {r.outAt||'--'}</b><small>Today</small></>:<><b>--</b><small>Not checked in</small></>}</div></div>
     <div className="at-place"><MapPin/><div>{r.inAt?<><b>{r.area}</b><small>{r.city}</small></>:<><b>-</b><small>-</small></>}</div></div>
     <button type="button" className="at-more" aria-label={`More for ${r.name}`} onClick={e=>e.stopPropagation()}><Ellipsis/></button><button type="button" className={`at-view ${r.id===sel?'solid':''}`} onClick={e=>{e.stopPropagation();setSel(r.id);setDtab('activity')}}>View <ArrowRight/></button></div>)}
     {!rows.length&&<div className="at-empty">No salesmen match this filter.</div>}</div>
    <div className="at-pager"><span>Showing {list.length?(cur-1)*per+1:0} to {Math.min(cur*per,list.length)} of {list.length} salesmen</span><div className="at-pages"><button type="button" aria-label="Previous page" disabled={cur===1} onClick={()=>setPage(cur-1)}><ChevronLeft/></button>{Array.from({length:pages},(_,i)=>i+1).map(p=><button type="button" key={p} className={p===cur?'active':''} onClick={()=>setPage(p)}>{p}</button>)}<button type="button" aria-label="Next page" disabled={cur===pages} onClick={()=>setPage(cur+1)}><ChevronRight/></button><label className="at-per"><select aria-label="Rows per page" value={per} onChange={e=>{setPer(Number(e.target.value));setPage(1)}}><option value={10}>10 / page</option><option value={25}>25 / page</option></select><ChevronDown/></label></div></div>
   </section>
   <section className="at-card at-detail">
    <div className="at-detail-head"><span className="at-avatar big">{initials(s.name)}</span><div><h2>{s.name} <span className={`at-online ${s.inAt&&!s.outAt?'on':''}`}><i/>{s.inAt&&!s.outAt?'Online':'Offline'}</span></h2><p><span>{s.id}</span><i/><span>{s.area}</span></p></div>
     <div className="at-detail-actions"><button type="button" className="at-btn soft"><Phone/> Call</button><button type="button" className="at-btn soft"><MessageSquareText/> Message</button><button type="button" className="at-btn soft icon" aria-label="More actions"><Ellipsis/></button></div></div>
    <div className="at-stats"><div className="green"><span><CheckCircle2/></span><div><small>Checked In</small><b>{s.inAt||'--'}</b></div></div><div className="amber"><span><Clock3/></span><div><small>On Field</small><b>{s.active}</b></div></div><div className="red"><span><LogOut/></span><div><small>Checked Out</small><b>{s.outAt||'--'}</b></div></div></div>
    <div className="at-dtabs" role="tablist">{([['activity',"Today's Activity"],['locations',`Visited Locations (${visited.length})`],['notes',`Notes (${s.notes.length})`],['records',`Saved Records (${s.records.length})`]] as const).map(([k,l])=><button type="button" role="tab" aria-selected={dtab===k} key={k} className={dtab===k?'active':''} onClick={()=>setDtab(k)}>{l}</button>)}</div>
    {dtab==='activity'&&<div className="at-activity">
     <div className="at-panel at-timeline"><h3>Today's Attendance Timeline</h3>
      {s.visits.length?<ol>{s.visits.map((v,i)=><li key={i} className={v.kind}><span className="at-dot"/><time>{v.time}</time><div className={`at-ev ${v.kind}`}><b>{v.title}</b><small>{v.sub}</small>{v.place&&<em><MapPin/>{v.place}</em>}{v.note&&<p>{v.note}</p>}</div></li>)}</ol>:<div className="at-empty">No activity recorded today.</div>}</div>
     <div className="at-rightcol">
      <div className="at-panel at-route"><div className="at-panel-head"><h3>Today's Route</h3><button type="button" className="at-link">View Full Map</button></div>
       <div className="at-map" role="img" aria-label="Route map"><svg viewBox="0 0 360 180" preserveAspectRatio="none"><defs><pattern id="at-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#DCE6EE" strokeWidth="1"/></pattern></defs><rect width="360" height="180" fill="#EEF3F7"/><rect width="360" height="180" fill="url(#at-grid)"/><path d="M0 60 H360 M0 120 H360 M90 0 V180 M210 0 V180 M300 0 V180" stroke="#fff" strokeWidth="6"/><path d="M0 60 H360 M0 120 H360 M90 0 V180 M210 0 V180 M300 0 V180" stroke="#D5DFE8" strokeWidth="1"/>{s.inAt&&<path d="M62 118 C120 100 150 60 210 52 S280 110 300 122" fill="none" stroke="#12A64C" strokeWidth="3" strokeLinecap="round"/>}</svg>
        {s.inAt&&<><span className="at-pin" style={{left:'17%',top:'65%'}}><MapPin/><span><b>{s.area}</b><small>{s.inAt}</small></span></span><span className="at-pin" style={{left:'58%',top:'29%'}}><MapPin/><span><b>{visited[0]?.place??'Gulberg'}</b><small>{visited[0]?.time??''}</small></span></span><span className="at-pin" style={{left:'72%',top:'70%'}}><MapPin/><span><b>{visited[1]?.place??'DHA Phase 5'}</b><small>{visited[1]?.time??''}</small></span></span></>}</div>
       <div className="at-route-stats"><div><span><MapPin/></span><div><b>{visited.length}</b><small>Locations Visited</small></div></div><div><span><Route/></span><div><b>{s.km} km</b><small>Total Distance</small></div></div><div><span><Clock3/></span><div><b>{s.active}</b><small>Active Duration</small></div></div></div></div>
      <div className="at-panel"><div className="at-panel-head"><h3>Today's Notes</h3><button type="button" className="at-link" onClick={()=>setDtab('notes')}>View All</button></div>
       {s.notes.length?<ul className="at-notes">{s.notes.map((n,i)=><li key={i}><span><FileText/></span><div><b>{n.title}</b><small>{n.sub}</small></div><time>{n.time}</time></li>)}</ul>:<div className="at-empty">No notes today.</div>}</div>
      <div className="at-panel"><div className="at-panel-head"><h3>Saved Attendance Records</h3><button type="button" className="at-link" onClick={()=>setDtab('records')}>View All</button></div>
       <ul className="at-notes">{s.records.map((n,i)=><li key={i}><span>{n.icon==='pin'?<MapPin/>:<FileText/>}</span><div><b>{n.title}</b><small>{n.sub}</small></div><time>{n.time}</time></li>)}</ul></div>
     </div></div>}
    {dtab==='locations'&&<div className="at-panel"><h3>Visited Locations</h3>{visited.length?<ul className="at-notes">{visited.map((v,i)=><li key={i}><span><MapPin/></span><div><b>{v.sub}</b><small>{v.place} · {v.note}</small></div><time>{v.time}</time></li>)}</ul>:<div className="at-empty">No locations visited today.</div>}</div>}
    {dtab==='notes'&&<div className="at-panel"><h3>Notes</h3>{s.notes.length?<ul className="at-notes">{s.notes.map((n,i)=><li key={i}><span><FileText/></span><div><b>{n.title}</b><small>{n.sub}</small></div><time>{n.time}</time></li>)}</ul>:<div className="at-empty">No notes today.</div>}</div>}
    {dtab==='records'&&<div className="at-panel"><h3>Saved Records</h3><ul className="at-notes">{s.records.map((n,i)=><li key={i}><span>{n.icon==='pin'?<MapPin/>:<FileText/>}</span><div><b>{n.title}</b><small>{n.sub}</small></div><time>{n.time}</time></li>)}</ul></div>}
   </section>
  </div>
 </div>
}
