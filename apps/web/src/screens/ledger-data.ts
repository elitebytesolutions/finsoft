'use client'
import type { Journal, Master } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

type Net={dr:number;cr:number}
export const netOf=(journals:Journal[],name:string):Net=>journals.reduce<Net>((a,j)=>({dr:a.dr+(j.debit===name?j.amount:0),cr:a.cr+(j.credit===name?j.amount:0)}),{dr:0,cr:0})
export const entriesOf=(journals:Journal[],name:string,side?:'Dr'|'Cr'):number=>journals.filter(j=>j.debit===name||j.credit===name).reduce((a,j)=>a+((side==='Dr'?j.debit===name:side==='Cr'?j.credit===name:true)?1:0),0)

type Side='Dr'|'Cr'
export type LedgerRow={date:string;ref:string;desc:string;toBy:string;dr:number;cr:number;running:number;side:Side}
export function buildLedger(journals:Journal[],name:string,opening:number){
 const entries=journals.filter(j=>j.debit===name||j.credit===name)
  .map(j=>({date:j.date,id:j.id,ref:j.reference||j.id,desc:j.description,toBy:`${j.debit===name?'To':'By'} ${j.debit===name?j.credit:j.debit}`,dr:j.debit===name?j.amount:0,cr:j.credit===name?j.amount:0}))
  .sort((a,b)=>a.date===b.date?a.id.localeCompare(b.id):a.date.localeCompare(b.date))
 let running=opening
 const rows:LedgerRow[]=entries.map(e=>{running=running+e.dr-e.cr;return {...e,running,side:running>=0?'Dr':'Cr'}})
 const closing=opening+entries.reduce((a,e)=>a+e.dr-e.cr,0)
 return {rows,closing,side:(closing>=0?'Dr':'Cr') as Side,count:entries.length}
}

export const rootOf=(masters:Master[],m:Master):Master=>{let cur=m;let guard=0;while(cur.parent&&cur.level&&cur.level>1&&guard++<10){cur=masters.find(x=>x.code===cur.parent)??cur}return cur}

export function exportLedgerCsv(data:AppData,master:Master){
 const opening=master.balance||0
 const {rows,closing}=buildLedger(data.journals,master.name,opening)
 const csv=['Date,Voucher,Particulars,Debit,Credit,Balance',...rows.map(r=>[r.date,`"${r.ref}"`,`"${r.desc} — ${r.toBy}"`,r.dr?String(r.dr):'',r.cr?String(r.cr):'',String(Math.abs(r.running))].join(',')),`Closing balance,,,,,${Math.abs(closing)}`].join('\n')
 const blob=new Blob([csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${master.code}-ledger.csv`;a.click();URL.revokeObjectURL(a.href)
}
