'use client'
/* Route /dashboard — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Dashboard } from '@/screens/app-screens'
import { useFinsoft } from '@/app-context'
import { useNavigate } from '@/lib/router'

export default function Page() {
  const f = useFinsoft()
  const navigate = useNavigate()
  return <Dashboard go={navigate} data={f.data}/>
}
