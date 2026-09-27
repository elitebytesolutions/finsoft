'use client'
/* Route /login — docs/design-system/pages/login/README.md. New screen, no prototype
 * source. Thin per finsoft-screen's convention: guard + screen. There is no `<Guard
 * module="...">` here because this route has no permission — it is reachable by anyone,
 * by definition, before a session exists. */
import { LoginScreen } from '@/screens/login'
import './login.css'

export default function Page() {
  return <LoginScreen />
}
