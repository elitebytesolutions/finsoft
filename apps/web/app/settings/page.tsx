'use client'
/* Route /settings — generated from the prototype route table in
 * ui-prototype/src/App.tsx. The screen and its props are unchanged. */
import { SettingsPage } from '@/screens/control-pages'
import { Guard } from '@/components/guard'

export default function Page() {
  return (
    <Guard module="Admin & Control">
      <SettingsPage />
    </Guard>
  )
}
