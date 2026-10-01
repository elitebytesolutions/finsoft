/* Component tests for /customers (docs/design-system/pages/customers/README.md, as amended
 * by docs/design/M3/ui-plan.md §3). PartyList's markup is the ported prototype's — these
 * tests exercise it against a mocked `GET /api/customers` / `POST /api/customers`, the same
 * way trial-balance.test.tsx and period-close.test.tsx exercise their own real-API screens. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { PartyList } from '@/screens/parties'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'
import type { AppData } from '@/mocks/api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyAppData(): AppData {
  return {
    products: [],
    purchases: [],
    purchaseReturns: [],
    sales: [],
    movements: [],
    journals: [],
    vouchers: [],
    masters: [],
    employees: [],
    pos: [],
    payments: [],
    templates: [],
    cheques: [],
  }
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

const CUSTOMERS = {
  items: [
    {
      id: 'c1',
      code: 'CUST-000001',
      name: 'Adeel Pharmacy',
      phone: '0300-1111111',
      city: 'Lahore',
      status: 'ACTIVE',
      balance: '4000.0000',
      balanceAsOf: '2026-09-29',
    },
    {
      id: 'c2',
      code: 'CUST-000002',
      name: 'Zeta Traders',
      phone: '0300-2222222',
      city: 'Karachi',
      status: 'INACTIVE',
      balance: '0.0000',
      balanceAsOf: '2026-09-29',
    },
  ],
  nextCursor: null,
}

beforeEach(() => {
  setAccessToken('tok-1')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(can: (code: string) => boolean = () => true, canCreate = true) {
  return render(
    <MemoryRouter initialEntries={['/customers']}>
      <AuthContext.Provider value={authValue(can)}>
        <PartyList data={emptyAppData()} kind="Customer" onAdd={() => {}} canCreate={canCreate} />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('PartyList (Customer) — real API', () => {
  it('lists real customers, with the server balance shown Dr/Cr in the list view', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, CUSTOMERS))

    renderScreen()

    await waitFor(() => expect(screen.getByText('Adeel Pharmacy')).toBeInTheDocument())
    expect(screen.getByText('Zeta Traders')).toBeInTheDocument()

    // Switch to the list view to see CustomerTable's columns (the default is the card grid).
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByText('Rs 4,000.00')).toBeInTheDocument()
    expect(screen.getAllByText('Dr').length).toBeGreaterThan(0)
  })

  it('shows the empty state when the tenant has no customers', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }))

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no customers match/i)).toBeInTheDocument())
  })

  it('shows the forbidden state for a caller without customer.view', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(
      jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })

  it('creates a customer through the wizard, sending only the fields the real schema accepts', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let createBody: unknown = null
    let createHeaders: HeadersInit | undefined
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/customers') {
        createBody = JSON.parse(init.body as string)
        createHeaders = init.headers
        return Promise.resolve(
          jsonResponse(201, {
            id: 'c9',
            code: 'CUST-000009',
            name: 'Zeta Traders',
            phone: null,
            email: null,
            address: null,
            city: null,
            ntn: null,
            creditDays: 0,
            status: 'ACTIVE',
            balance: '0.0000',
            balanceAsOf: '2026-09-29',
            version: 1,
            createdAt: '2026-09-29T00:00:00.000Z',
            createdBy: 'u1',
            updatedAt: '2026-09-29T00:00:00.000Z',
            updatedBy: 'u1',
          }),
        )
      }
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no customers match/i)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /New Customer/ }))
    expect(screen.getByText('Basic Information')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Ahmed Traders'), {
      target: { value: 'Zeta Traders' },
    })
    // The code field is not editable — the server assigns it.
    expect(screen.getByDisplayValue('Assigned automatically on save')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: /Create Customer/ }))

    await waitFor(() => expect(createBody).not.toBeNull())
    expect(createBody).toEqual({
      name: 'Zeta Traders',
      phone: null,
      email: null,
      address: null,
      city: null,
      ntn: null,
      creditDays: 30,
    })
    expect(new Headers(createHeaders).get('Idempotency-Key')).toBeTruthy()
  })

  it('offers New customer only when canCreate is true', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }))

    renderScreen(() => true, false)
    await waitFor(() => expect(screen.getByText(/no customers match/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /New Customer/ })).toBeDisabled()
  })

  it('hides the deactivate/reactivate row menu for a caller without customer.create', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, CUSTOMERS))

    renderScreen(() => false)
    await waitFor(() => expect(screen.getByText('Adeel Pharmacy')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))

    const row = screen.getByText('Adeel Pharmacy').closest('tr') as HTMLElement
    const more = within(row).getByRole('button', { name: /More for/ })
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('deactivates a customer and refuses with the server balance on CUSTOMER_HAS_BALANCE', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/deactivate')) {
        return Promise.resolve(
          jsonResponse(409, {
            statusCode: 409,
            error: 'CUSTOMER_HAS_BALANCE',
            message: 'Customer has a balance.',
            details: { balance: '4000.0000' },
          }),
        )
      }
      return Promise.resolve(jsonResponse(200, CUSTOMERS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText('Adeel Pharmacy')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))

    const row = screen.getByText('Adeel Pharmacy').closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: /More for/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    await waitFor(() => expect(screen.getByText(/still has a balance of/i)).toBeInTheDocument())
  })
})
