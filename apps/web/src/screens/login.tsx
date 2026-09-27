'use client'
/* /login — docs/design-system/pages/login/README.md. No prototype ancestor (§Prototype
 * source: "none"); this is a new screen, not a port.
 *
 * Renders outside <Shell> (apps/web/src/components/app-frame.tsx) and outside the
 * session-required guard (apps/web/src/lib/api/auth-context.tsx PUBLIC_ROUTES) — it is
 * the one screen reachable with no session by definition. */
import { useEffect, useState, type FormEvent } from 'react'
import { Activity } from 'lucide-react'
import { Banner, Button, Field, TextInput } from '@finsoft/ui'
import { useSearchParams } from '@/lib/router'
import { login } from '@/lib/api/client'
import { useAuth } from '@/lib/api/auth-context'
import { ApiError } from '@/lib/api/types'

interface FieldErrors {
  tenantCode?: string
  email?: string
  password?: string
}

// One id per field, owned here (packages/ui's Field/TextInput split ownership of
// id/htmlFor between the two components deliberately — see the design-system
// agent's note on components.tsx — so the page picks the string once and passes
// it to both halves of each pair).
const FIELD_ID = {
  tenantCode: 'login-tenant-code',
  email: 'login-email',
  password: 'login-password',
} as const

// Presence + shape only, for speed of feedback (page doc §4). Not authoritative — the
// server's rejection is the truth, and there is no packages/validation login schema yet
// for this page to adopt (the auth lane owns that contract).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(tenantCode: string, email: string, password: string): FieldErrors {
  const errors: FieldErrors = {}
  if (!tenantCode.trim()) errors.tenantCode = 'Tenant code is required.'
  if (!email.trim()) errors.email = 'Email is required.'
  else if (!EMAIL_SHAPE.test(email.trim())) errors.email = 'Enter a valid email address.'
  if (!password) errors.password = 'Password is required.'
  return errors
}

export function LoginScreen() {
  const { syncAfterLogin } = useAuth()
  const [params] = useSearchParams()
  const sessionExpired = params.get('reason') === 'expired'

  const [tenantCode, setTenantCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [retryIn, setRetryIn] = useState(0)

  // TextInput takes no ref and no autoFocus prop (packages/ui/src/components.tsx is
  // plain function components, not forwardRef) — focusing the first field on mount,
  // per page doc §9, is done by id here instead of forking the kit for a ref.
  useEffect(() => {
    document.getElementById(FIELD_ID.tenantCode)?.focus()
  }, [])

  // Rate-limit countdown. Submit stays disabled until it reaches zero (page doc §6).
  useEffect(() => {
    if (retryIn <= 0) return
    const id = setInterval(() => setRetryIn((seconds) => Math.max(0, seconds - 1)), 1000)
    return () => clearInterval(id)
  }, [retryIn])

  useEffect(() => {
    if (retryIn === 0 && formError?.code === 'rate_limited') setFormError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryIn])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting || retryIn > 0) return

    setFormError(null)
    const errors = validate(tenantCode, email, password)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)
    try {
      await login({ tenantCode: tenantCode.trim(), email: email.trim(), password })
      // Re-confirms the session via GET /auth/me (real sessionId, permissionVersion)
      // and flips AuthProvider's status to 'authenticated'. That status change is what
      // actually navigates away (auth-context.tsx's "already-authenticated on /login"
      // effect, honouring `?next=`) — not this handler, so there is exactly one place
      // that decides where a signed-in user goes.
      await syncAfterLogin()
      // `submitting` intentionally stays true here — the page is navigating away, and
      // re-enabling the button just to flash it disabled again on unmount serves nobody.
    } catch (err) {
      const apiError =
        err instanceof ApiError ? err : new ApiError('unknown', 'Something went wrong. Try again.')
      setFormError(apiError)
      if (apiError.code === 'rate_limited' && apiError.retryAfterSeconds) {
        setRetryIn(apiError.retryAfterSeconds)
      }
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand" aria-hidden="true">
          <Activity />
          <b>Finsoft</b>
        </div>
        <h1>Sign in</h1>

        {sessionExpired && !formError && (
          <Banner tone="info">Your session ended. Sign in again to continue.</Banner>
        )}

        {formError && formError.code === 'rate_limited' && (
          <Banner tone="warn">
            Too many attempts. Try again in <span aria-live="off">{retryIn}</span>s.
          </Banner>
        )}

        {formError && formError.code === 'network_error' && (
          <Banner tone="danger">
            {formError.message}{' '}
            <Button kind="ghost" onClick={() => setFormError(null)}>
              Try again
            </Button>
          </Banner>
        )}

        {formError && formError.code !== 'rate_limited' && formError.code !== 'network_error' && (
          <Banner tone="danger">{formError.message}</Banner>
        )}

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <Field
            label="Tenant code"
            htmlFor={FIELD_ID.tenantCode}
            required
            error={fieldErrors.tenantCode}
          >
            <TextInput
              id={FIELD_ID.tenantCode}
              value={tenantCode}
              onChange={setTenantCode}
              name="tenantCode"
              autoComplete="organization"
              disabled={submitting}
              required
              aria-invalid={!!fieldErrors.tenantCode}
              aria-describedby={fieldErrors.tenantCode ? `${FIELD_ID.tenantCode}-error` : undefined}
            />
          </Field>
          <Field label="Email" htmlFor={FIELD_ID.email} required error={fieldErrors.email}>
            <TextInput
              id={FIELD_ID.email}
              type="email"
              value={email}
              onChange={setEmail}
              name="email"
              autoComplete="username"
              disabled={submitting}
              required
              aria-invalid={!!fieldErrors.email}
              aria-describedby={fieldErrors.email ? `${FIELD_ID.email}-error` : undefined}
            />
          </Field>
          <Field label="Password" htmlFor={FIELD_ID.password} required error={fieldErrors.password}>
            <TextInput
              id={FIELD_ID.password}
              type="password"
              value={password}
              onChange={setPassword}
              name="password"
              autoComplete="current-password"
              disabled={submitting}
              required
              aria-invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? `${FIELD_ID.password}-error` : undefined}
            />
          </Field>

          <Button type="submit" busy={submitting} disabled={retryIn > 0}>
            {retryIn > 0 ? `Try again in ${retryIn}s` : submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="login-footnote">
          Access is invite-only. Contact your administrator for an account.
        </p>
      </div>
    </div>
  )
}
