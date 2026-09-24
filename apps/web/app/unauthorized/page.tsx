'use client'
/* Route /unauthorized — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { Button } from '@finsoft/ui'
import { LockKeyhole } from 'lucide-react'
import { useFinsoft } from '@/app-context'
import { useNavigate } from '@/lib/router'

export default function Page() {
  const f = useFinsoft()
  const navigate = useNavigate()
  return (
    <div className="state-page">
      <span>
        <LockKeyhole />
      </span>
      <h1>Access restricted</h1>
      <p>The {f.role} role does not have permission to open this module.</p>
      <Button onClick={() => navigate('/dashboard')}>Return to dashboard</Button>
    </div>
  )
}
