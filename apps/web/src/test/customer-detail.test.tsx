/* Component tests for /customers/:id (docs/design-system/pages/customer-detail/README.md,
 * as amended by docs/design/M3/ui-plan.md §3). CustomerDetail fetches by the route id
 * itself (C3, C7, GET /api/audit) — no data props, same self-contained pattern as
 * AccountLedger/PeriodClose. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { CustomerDetail } from '@/screens/parties'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function authValue(can: (code: string) => boolean): AuthContextValue {
  return {
    status: 'authenticated',
    user: { id: 'u1', fullName: 'Test User', email: 'u1@example.com' },
    tenant: { id: 't1', code: 'TEST', name: 'Test Tenant' },
    sessionId: 's1',
    permissionVersion: 1,
    permissions: ['all'],
    errorMessage: null,
    retry: () => {},
    syncAfterLogin: async () => {},
    signOut: async () => {},
    can,
  }
}

const CUSTOMER = {
  id: 'c1',
  code: 'CUST-000001',
  name: 'Adeel Pharmacy',
  phone: '0300-1111111',
  email: 'adeel@example.com',
  address: '12 Mall Road',
  city: 'Lahore',
  ntn: '1234567-8',
  creditDays: 30,
  status: 'ACTIVE',
  balance: '4000.0000',
  balanceAsOf: '2026-09-29',
  version: 3,
  createdAt: '2026-01-05T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2026-01-05T00:00:00.000Z',
  updatedBy: 'u1',
}

const LEDGER = {
  customer: { id: 'c1', code: 'CUST-000001', name: 'Adeel Pharmacy' },
  from: '2026-07-01',
  to: '2026-09-29',
  openingBalance: '0.0000',
  lines: [
    {
      occurredAt: '2026-08-01',
      entryId: 'e1',
      entryNumber: 'JE-2027-000001',
      sourceType: 'sales_invoice',
      sourceId: 'inv1',
      sourceNumber: 'INV-2027-000001',
      narration: 'Service sale',
      debit: '4000.0000',
      credit: '0.0000',
      runningBalance: '4000.0000',
      reversedBy: null,
      reverses: null,
    },
  ],
  totals: { debit: '4000.0000', credit: '0.0000' },
  closingBalance: '4000.0000',
}

const AUDIT = {
  items: [
    {
      id: 'a1',
      seq: 1,
      occurredAt: '2026-01-05T10:00:00.000Z',
      actorUserId: 'user-aaaaaaaa-0000',
      action: 'CUSTOMER_CREATED',
      entityType: 'customer',
      entityId: 'c1',
      beforeJson: null,
      afterJson: null,
      ip: null,
      requestId: null,
      hash: 'x',
    },
  ],
  nextCursor: null,
}

function mockFetches(overrides: Record<string, unknown> = {}) {
  return (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/customers/c1/ledger'))
      return Promise.resolve(jsonResponse(200, LEDGER))
    if (url.startsWith('/api/audit')) return Promise.resolve(jsonResponse(200, AUDIT))
    if (url === '/api/customers/c1' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonResponse(200, overrides.customer ?? CUSTOMER))
    }
    if (url === '/api/customers/c1' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string)
      ;(overrides.onPatch as ((b: unknown) => void) | undefined)?.(body)
      return Promise.resolve(jsonResponse(200, { ...CUSTOMER, ...body }))
    }
    if (url === '/api/customers/c1/deactivate') {
      return (
        (overrides.deactivate as (() => Response) | undefined)?.() ??
        Promise.resolve(jsonResponse(200, { ...CUSTOMER, status: 'INACTIVE' }))
      )
    }
    return Promise.resolve(jsonResponse(404, { statusCode: 404, error: 'not_found', message: 'x' }))
  }
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
    <MemoryRouter initialEntries={['/customers/c1']}>
      <AuthContext.Provider value={authValue(can)}>
        <CustomerDetail />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('CustomerDetail — real API', () => {
  it('renders the customer, its real ledger (server running balance, never computed here) and its activity', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(mockFetches())

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Adeel Pharmacy' })).toBeInTheDocument(),
    )
    expect(screen.getAllByText('CUST-000001').length).toBeGreaterThan(0)
    // Outstanding balance, Dr, straight from the server — no browser arithmetic.
    expect(screen.getAllByText('Rs 4,000.00').length).toBeGreaterThan(0)
    expect(screen.getByText('JE-2027-000001')).toBeInTheDocument()
    expect(screen.getByText('INV-2027-000001')).toBeInTheDocument()
    // Recent Interactions — the real audit trail for this record.
    expect(screen.getByText('Customer created')).toBeInTheDocument()
  })

  it('shows the shared Not found state for an unknown or cross-tenant id', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/customers/c1')
        return Promise.resolve(
          jsonResponse(404, { statusCode: 404, error: 'CUSTOMER_NOT_FOUND', message: 'not found' }),
        )
      return Promise.resolve(jsonResponse(200, AUDIT))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText('Customer not found.')).toBeInTheDocument())
  })

  it('shows the Denied state for a caller without customer.view', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' })),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })

  it('saves the Quick Edit form with the real PATCH and the version it read', async () => {
    let patched: Record<string, unknown> | null = null
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(
      mockFetches({
        onPatch: (b: unknown) => {
          patched = b as Record<string, unknown>
        },
      }),
    )

    renderScreen()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Adeel Pharmacy' })).toBeInTheDocument(),
    )

    fireEvent.change(screen.getByDisplayValue('Adeel Pharmacy'), {
      target: { value: 'Adeel Pharmacy (Updated)' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(patched).not.toBeNull())
    expect(patched).toMatchObject({ version: 3, name: 'Adeel Pharmacy (Updated)' })
  })

  it('deactivates, and shows the server balance on CUSTOMER_HAS_BALANCE', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(
      mockFetches({
        deactivate: () =>
          Promise.resolve(
            jsonResponse(409, {
              statusCode: 409,
              error: 'CUSTOMER_HAS_BALANCE',
              message: 'has balance',
              details: { balance: '4000.0000' },
            }),
          ),
      }),
    )

    renderScreen()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Adeel Pharmacy' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(screen.getByText(/still has a balance of/i)).toBeInTheDocument())
  })

  it('offers no Edit or More action to a caller without customer.create', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(mockFetches())

    renderScreen(() => false)
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Adeel Pharmacy' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  })
})
