/* Component tests for /login (docs/design-system/pages/login/README.md) — rendering,
 * every §6 state, and the interaction that gets you between them.
 *
 * Mocks `fetch`, not the `@/lib/api/client` module (matching api-client.test.tsx's
 * approach) — the real `login()` runs against a stubbed transport, so this exercises the
 * genuine integration between the screen and the client, not a hand-shaped stand-in
 * for it. `setAccessToken(null)` resets the in-memory session module between tests. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { LoginScreen } from '@/screens/login'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  setAccessToken(null)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderLogin(path = '/login', authOverrides: Partial<AuthContextValue> = {}) {
  const syncAfterLogin = vi.fn().mockResolvedValue(undefined)
  const auth: AuthContextValue = {
    status: 'unauthenticated',
    user: null,
    tenant: null,
    sessionId: null,
    permissionVersion: null,
    errorMessage: null,
    retry: vi.fn(),
    syncAfterLogin,
    signOut: vi.fn(),
    ...authOverrides,
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={auth}>
        <LoginScreen />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  return { syncAfterLogin }
}

function fillAndSubmit(values: { tenantCode?: string; email?: string; password?: string }) {
  if (values.tenantCode !== undefined) {
    fireEvent.change(screen.getByLabelText(/tenant code/i), {
      target: { value: values.tenantCode },
    })
  }
  if (values.email !== undefined) {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: values.email } })
  }
  if (values.password !== undefined) {
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: values.password } })
  }
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('LoginScreen', () => {
  it('idle: renders the three fields, no banner, no "remember me", no sign-up link', () => {
    renderLogin()
    expect(screen.getByLabelText(/tenant code/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText(/remember me/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument()
  })

  it('shows the session-expired banner only when ?reason=expired is present', () => {
    renderLogin('/login?reason=expired')
    expect(screen.getByText(/your session ended/i)).toBeInTheDocument()
  })

  it('does not show the session-expired banner on a plain visit', () => {
    renderLogin('/login')
    expect(screen.queryByText(/your session ended/i)).not.toBeInTheDocument()
  })

  it('validates presence client-side and never calls the API with a blank field', () => {
    renderLogin()
    fillAndSubmit({ tenantCode: '', email: '', password: '' })
    expect(screen.getByText('Tenant code is required.')).toBeInTheDocument()
    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password is required.')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows a generic invalid-credentials message on 401 — never which field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(401, {
        error: 'invalid_credentials',
        message: 'Incorrect tenant code, email or password.',
      }),
    )
    renderLogin()
    fillAndSubmit({ tenantCode: 'ACME', email: 'a@b.com', password: 'wrong' })

    expect(await screen.findByText('Incorrect tenant code, email or password.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
  })

  it('maps a 400 validation_failed detail to the matching field, not a form banner', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'validation_failed',
        message: 'The request body did not match the expected shape.',
        details: [
          {
            path: 'tenantCode',
            code: 'invalid_string',
            message: 'tenantCode must match ^[A-Z][A-Z0-9_]{1,15}$',
          },
        ],
      }),
    )
    renderLogin()
    fillAndSubmit({ tenantCode: '1', email: 'a@b.com', password: 'x' })

    expect(
      await screen.findByText('tenantCode must match ^[A-Z][A-Z0-9_]{1,15}$'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
  })

  it('shows the rate-limit banner with a counting-down retry time and disables submit', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(429, { message: 'Too many attempts.' }, { 'Retry-After': '30' }),
    )
    renderLogin()
    fillAndSubmit({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' })

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again in 30s/i })).toBeDisabled()
  })

  it('shows a network-error message with a Try again action on a transport failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('failed to fetch'))
    renderLogin()
    fillAndSubmit({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' })

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('on success, calls the API once then syncAfterLogin(), and navigates away via the session', async () => {
    let resolveLogin: (() => void) | undefined
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = () =>
          resolve(
            jsonResponse(200, {
              accessToken: 'tok',
              expiresIn: 900,
              user: { id: 'u1', fullName: 'Ada', email: 'a@b.com' },
              tenant: { id: 't1', code: 'ACME', name: 'Acme' },
            }),
          )
      }),
    )
    const { syncAfterLogin } = renderLogin()
    fillAndSubmit({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' })

    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled())
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/auth/login')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      tenantCode: 'ACME',
      email: 'a@b.com',
      password: 'x',
    })

    resolveLogin?.()
    await waitFor(() => expect(syncAfterLogin).toHaveBeenCalledTimes(1))
  })

  it('disables the submit button and shows "Signing in…" while a request is in flight', async () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {})) // never resolves
    renderLogin()
    fillAndSubmit({ tenantCode: 'ACME', email: 'a@b.com', password: 'x' })

    await waitFor(() => expect(screen.getByText(/signing in/i)).toBeInTheDocument())
    expect(screen.getByRole('button')).toBeDisabled()
  })
})
