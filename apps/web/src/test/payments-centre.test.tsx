/* Component tests for /payments (PaymentsCentre — M4-W2, real receipts API). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { PaymentsCentre } from '@/screens/transactions-pages'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'

const fakeAuth: AuthContextValue = {
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
  can: () => true,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const RECEIPTS_PAGE = {
  items: [
    {
      id: 'rct-1',
      number: 'RCT-000001',
      status: 'POSTED',
      customer: { id: 'cus-1', code: 'CUST-000001', name: 'Shifa Medical Centre' },
      receiptDate: '2026-09-15',
      method: 'BANK',
      amount: '6000.0000',
    },
  ],
  nextCursor: null,
}

const CUSTOMERS_PAGE = {
  items: [
    {
      id: 'cus-1',
      code: 'CUST-000001',
      name: 'Shifa Medical Centre',
      phone: null,
      city: 'Lahore',
      status: 'ACTIVE',
      balance: '0.0000',
      balanceAsOf: '2026-09-01',
    },
  ],
  nextCursor: null,
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    openInvoices: [
      {
        invoiceId: 'inv-1',
        number: 'INV-000001',
        invoiceDate: '2026-09-01',
        dueDate: '2026-09-30',
        netAmount: '10000.0000',
        outstanding: '10000.0000',
      },
    ],
    allocations: [{ invoiceId: 'inv-1', amount: '6000.0000' }],
    suggested: true,
    allocatedTotal: '6000.0000',
    unallocated: '0.0000',
    problems: [],
    ...overrides,
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
    <MemoryRouter initialEntries={['/payments']}>
      <AuthContext.Provider value={{ ...fakeAuth, can }}>
        <PaymentsCentre />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function baseRouter(overrides: {
  create?: (body: Record<string, unknown>) => unknown
  post?: (id: string) => unknown
} = {}) {
  return (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/receipts/preview') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(200, preview()))
    }
    if (url === '/api/receipts' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      const result = overrides.create?.(body) ?? {
        id: 'rct-new',
        number: null,
        status: 'DRAFT',
        version: 1,
      }
      return Promise.resolve(jsonResponse(200, result))
    }
    if (url.match(/\/api\/receipts\/[^/]+\/post$/) && init?.method === 'POST') {
      const id = url.split('/')[3]
      const result = overrides.post?.(id) ?? {
        id,
        number: 'RCT-000002',
        status: 'POSTED',
        version: 2,
      }
      return Promise.resolve(jsonResponse(200, result))
    }
    if (url.startsWith('/api/receipts')) return Promise.resolve(jsonResponse(200, RECEIPTS_PAGE))
    if (url.startsWith('/api/customers')) return Promise.resolve(jsonResponse(200, CUSTOMERS_PAGE))
    throw new Error(`unexpected fetch: ${url} ${init?.method}`)
  }
}

describe('PaymentsCentre', () => {
  it('lists real receipts (R1) and links to their detail page', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(baseRouter())

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'RCT-000001' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Shifa Medical Centre (CUST-000001)')).toBeInTheDocument()
  })

  it('disables New Receipt without payment.receive', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(baseRouter())

    renderScreen((code) => code !== 'payment.receive')

    await waitFor(() => expect(screen.getByRole('button', { name: /RCT-000001/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /new receipt/i })).toBeDisabled()
  })

  it('previews open invoices (R2) once a customer is picked and suggests an allocation', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(baseRouter())

    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new receipt/i }))
    const dialog = screen.getByRole('dialog', { name: /new receipt/i })

    fireEvent.change(within(dialog).getByLabelText('Customer'), {
      target: { value: 'Shifa Medical Centre (CUST-000001)' },
    })

    await waitFor(() =>
      expect(within(dialog).getByText('INV-000001')).toBeInTheDocument(),
    )
    expect(within(dialog).getByDisplayValue('6000.0000')).toBeInTheDocument()
    expect(within(dialog).getByText('Rs 6,000.00')).toBeInTheDocument() // Allocated
  })

  it('Save draft posts to /api/receipts with the current allocation', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(baseRouter())

    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new receipt/i }))
    const dialog = screen.getByRole('dialog', { name: /new receipt/i })
    fireEvent.change(within(dialog).getByLabelText('Customer'), {
      target: { value: 'Shifa Medical Centre (CUST-000001)' },
    })
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '6000' } })
    await waitFor(() => expect(within(dialog).getByText('INV-000001')).toBeInTheDocument())

    fireEvent.click(within(dialog).getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/receipts' && (c[1] as RequestInit)?.method === 'POST',
      )
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as RequestInit).body as string)
      expect(body.customerId).toBe('cus-1')
      expect(body.allocations).toEqual([{ invoiceId: 'inv-1', amount: '6000.0000' }])
    })
  })

  it('Post receipt confirms, warning when unallocated would be nonzero', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(
      baseRouter({
        create: () => ({ id: 'rct-new', number: null, status: 'DRAFT', version: 1 }),
      }),
    )
    // Override preview to leave something unallocated.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/receipts/preview') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(200, preview({ allocatedTotal: '4000.0000', unallocated: '2000.0000' })),
        )
      }
      return baseRouter()(url, init)
    })

    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new receipt/i }))
    const dialog = screen.getByRole('dialog', { name: /new receipt/i })
    fireEvent.change(within(dialog).getByLabelText('Customer'), {
      target: { value: 'Shifa Medical Centre (CUST-000001)' },
    })
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '6000' } })
    await waitFor(() => expect(within(dialog).getByText('INV-000001')).toBeInTheDocument())

    fireEvent.click(within(dialog).getByRole('button', { name: /post receipt/i }))
    const confirm = await screen.findByRole('dialog', { name: 'Post receipt' })
    expect(within(confirm).getByText(/will remain unallocated/)).toBeInTheDocument()
  })
})
