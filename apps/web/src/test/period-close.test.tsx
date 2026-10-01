/* Component tests for /period-close (docs/design-system/pages/period-close/README.md). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { PeriodClose } from '@/screens/trade-pages'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'

/*
 * M4-W: PeriodTable now gates Close/Reopen on `useAuth().can(...)` (GET
 * /api/me/permissions), so these tests need an AuthContext in the tree — a fake one, same
 * seam apps/web/src/test/harness.tsx uses, since jsdom cannot answer a real `GET
 * /api/auth/me`. `can` defaults to true so every EXISTING assertion below (which predates
 * permission gating and asserts on order, not on who can act) keeps seeing the same
 * buttons it always did; the one new test at the bottom overrides it to prove the gating
 * itself.
 */
function authValue(can: (code: string) => boolean): AuthContextValue {
  return {
    status: 'authenticated',
    user: { id: 'test-user', fullName: 'Test User', email: 'test.user@example.com' },
    tenant: { id: 'test-tenant', code: 'TEST', name: 'Test Tenant' },
    sessionId: 'test-session',
    permissionVersion: 1,
    permissions: ['all'],
    errorMessage: null,
    retry: () => {},
    syncAfterLogin: async () => {},
    signOut: async () => {},
    can,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const PERIODS = {
  periods: [
    {
      id: 'p1',
      fiscalYear: 2027,
      periodIndex: 1,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      label: '2026-07',
      status: 'CLOSED',
    },
    {
      id: 'p2',
      fiscalYear: 2027,
      periodIndex: 2,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      label: '2026-08',
      status: 'OPEN',
    },
    {
      id: 'p3',
      fiscalYear: 2027,
      periodIndex: 3,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      label: '2026-09',
      status: 'OPEN',
    },
  ],
}

beforeEach(() => {
  setAccessToken('tok-1')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={['/period-close']}>
      <AuthContext.Provider value={authValue(can)}>
        <PeriodClose />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('PeriodClose', () => {
  it('lists periods and offers Close only on the earliest OPEN one', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, PERIODS))

    renderScreen()

    await waitFor(() => expect(screen.getByText('2026-07')).toBeInTheDocument())
    const closeButtons = screen.getAllByRole('button', { name: 'Close' })
    expect(closeButtons).toHaveLength(2) // both OPEN rows render the button...
    expect(closeButtons[0]).toBeEnabled() // ...but only 2026-08 (earliest open) is enabled
    expect(closeButtons[1]).toBeDisabled() // 2026-09 is out of order
  })

  it('offers Reopen only on the latest CLOSED period', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        periods: [
          {
            id: 'p1',
            fiscalYear: 2027,
            periodIndex: 1,
            periodStart: '2026-07-01',
            periodEnd: '2026-07-31',
            label: '2026-07',
            status: 'CLOSED',
          },
          {
            id: 'p2',
            fiscalYear: 2027,
            periodIndex: 2,
            periodStart: '2026-08-01',
            periodEnd: '2026-08-31',
            label: '2026-08',
            status: 'CLOSED',
          },
          {
            id: 'p3',
            fiscalYear: 2027,
            periodIndex: 3,
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            label: '2026-09',
            status: 'OPEN',
          },
        ],
      }),
    )
    renderScreen()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(1))
  })

  it('closes the earliest open period and refreshes', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/close'))
        return Promise.resolve(jsonResponse(200, { ...PERIODS.periods[1], status: 'CLOSED' }))
      return Promise.resolve(jsonResponse(200, PERIODS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Close' })[0]).toBeEnabled())
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[0] as string).endsWith('/close') &&
            (call[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('requires a reason to reopen, then posts it', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let reopenBody: unknown = null
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/reopen')) {
        reopenBody = JSON.parse(init!.body as string)
        return Promise.resolve(jsonResponse(200, { ...PERIODS.periods[0], status: 'OPEN' }))
      }
      return Promise.resolve(jsonResponse(200, PERIODS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reopen period' }))
    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^reason/i), {
      target: { value: 'Correcting an error' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen period' }))

    await waitFor(() => expect(reopenBody).toEqual({ reason: 'Correcting an error' }))
  })

  it('shows a clear, specific message when a non-Owner reopen attempt gets the server 403', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/reopen')) {
        return Promise.resolve(
          jsonResponse(403, {
            statusCode: 403,
            error: 'forbidden',
            message: 'You do not have permission to do that.',
          }),
        )
      }
      return Promise.resolve(jsonResponse(200, PERIODS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Trying anyway' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen period' }))

    // Not the generic ApiError message — a clear, action-specific one naming who actually can.
    await waitFor(() =>
      expect(screen.getByText('Only the Owner can reopen a period.')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/you do not have permission to do that/i)).not.toBeInTheDocument()
  })

  it('shows the empty state when no periods exist', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { periods: [] }))
    renderScreen()
    await waitFor(() => expect(screen.getByText(/No fiscal periods exist yet/)).toBeInTheDocument())
  })

  it('shows the forbidden state on a 403', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }),
    )
    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })

  it('never offers Reopen to a caller without period.reopen — not even on the latest CLOSED period', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        periods: [
          { ...PERIODS.periods[0], status: 'CLOSED' },
          { ...PERIODS.periods[1], status: 'OPEN' },
        ],
      }),
    )
    // Holds period.close but not period.reopen — an Accountant, not the Owner.
    renderScreen((code) => code === 'period.close')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument()
  })

  it('offers neither Close nor Reopen to a caller with no period permissions', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        periods: [
          { ...PERIODS.periods[0], status: 'CLOSED' },
          { ...PERIODS.periods[1], status: 'OPEN' },
        ],
      }),
    )
    renderScreen(() => false)
    await waitFor(() => expect(screen.getByText('2026-07')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument()
  })
})
