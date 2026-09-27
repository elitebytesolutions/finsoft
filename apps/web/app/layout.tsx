import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '@finsoft/ui/tokens.css'
import '@finsoft/ui/kit.css'
import '@finsoft/ui/employee-wizard.css'
import { FinsoftProvider } from '@/app-context'
import { AppFrame } from '@/components/app-frame'
import { AuthProvider } from '@/lib/api/auth-context'

export const metadata: Metadata = {
  title: 'Finsoft — Bhatti Traders',
  description: 'Pharmacy trading, inventory, finance, payroll and reporting for Bhatti Traders.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#287c72',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Caveat is the only webfont the prototype loads. Inter is named first in
            the stack but never fetched, so it resolves to the local UI font —
            fetching it here would change every glyph in the app. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      {/* suppressHydrationWarning covers this element's OWN attributes only; it does
          not cascade to children, so a genuine mismatch inside the app still reports.
          Browser extensions (ColorZilla's cz-shortcut-listen, Grammarly, password
          managers) write attributes onto <body> before React hydrates, and there is
          no way to prevent that from the page. */}
      <body suppressHydrationWarning>
        {/* AuthProvider owns the real session (identity, tenant, sign-out) and the
            client-side "you need a session" redirect; it wraps FinsoftProvider, whose
            mock role/`can()`/`act()` still drive the prototype screens underneath
            (docs/briefs/M1-W-web-infra.md — no new mock-only screens, existing ones are
            not rebuilt here). */}
        <AuthProvider>
          <FinsoftProvider>
            <AppFrame>{children}</AppFrame>
          </FinsoftProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
