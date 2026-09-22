'use client'
/* Route /approvals — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { ApprovalQueue } from '@/screens/control-pages'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL"><ApprovalQueue data={f.data} onVoucher={(id)=>f.patchVoucher(id,{status:'Posted' as const,posting:'Posted' as const},true)} onPO={(id)=>f.patchPO(id,{status:'Sent' as const})} onPurchase={(id)=>f.postPurchaseDraft(id)} canPost={f.act('voucher:create')}/></Guard>
}
