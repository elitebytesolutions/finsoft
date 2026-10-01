/* Component tests for app-context.tsx's FinsoftProvider — specifically the mock `role`'s
 * lifetime across sign-out. Security seat follow-up: the role switched into by one person
 * on a shared browser must not survive into the next session in THIS tab's memory, not
 * only in localStorage (fixed separately in auth-context.tsx's signOut()) — a client-side
 * routed sign-out never reloads the page, so a value already in React state would
 * otherwise outlive the session that chose it. */
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FinsoftProvider, useFinsoft } from '@/app-context'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'

afterEach(cleanup)

function authValue(status: AuthContextValue['status']): AuthContextValue {
  return {
    status,
    user: status === 'authenticated' ? { id: 'u1', fullName: 'Ada', email: 'a@b.com' } : null,
    tenant: null,
    sessionId: null,
    permissionVersion: null,
    permissions: null,
    errorMessage: null,
    retry: () => {},
    syncAfterLogin: async () => {},
    signOut: async () => {},
    can: () => false,
  }
}

function RoleProbe() {
  const { role, setRole } = useFinsoft()
  return (
    <div>
      <span data-testid="role">{role}</span>
      <button onClick={() => setRole('Accountant')}>switch to accountant</button>
    </div>
  )
}

describe('FinsoftProvider — mock role lifetime', () => {
  it('resets the in-memory role to Owner when the real session goes unauthenticated (sign-out)', () => {
    localStorage.clear()
    const { rerender } = render(
      <AuthContext.Provider value={authValue('authenticated')}>
        <FinsoftProvider>
          <RoleProbe />
        </FinsoftProvider>
      </AuthContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'switch to accountant' }))
    expect(screen.getByTestId('role')).toHaveTextContent('Accountant')

    // The session ends — sign-out or expiry, same outcome either way — without a page
    // reload, exactly as client-side routing gives it.
    rerender(
      <AuthContext.Provider value={authValue('unauthenticated')}>
        <FinsoftProvider>
          <RoleProbe />
        </FinsoftProvider>
      </AuthContext.Provider>,
    )

    expect(screen.getByTestId('role')).toHaveTextContent('Owner')
  })

  it('does not reset the role while the session stays authenticated', () => {
    localStorage.clear()
    render(
      <AuthContext.Provider value={authValue('authenticated')}>
        <FinsoftProvider>
          <RoleProbe />
        </FinsoftProvider>
      </AuthContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'switch to accountant' }))
    expect(screen.getByTestId('role')).toHaveTextContent('Accountant')
  })
})
