/* Component tests for /sales/:id (SaleDetail — M4-W2, real invoices API). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { SaleDetail } from '@/screens/detail-pages'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'
import type { Invoice } from '@/lib/api/invoices-types'

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

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    number: 'INV-000001',
    status: 'POSTED',
    settlement: 'OPEN',
    customer: { id: 'cus-1', code: 'CUST-000001', name: 'Shifa Medical Centre' },
    invoiceDate: '2026-09-01',
    dueDate: '2026-09-30',
    narration: 'Consulting services',
    lines: [
      {
        lineNo: 1,
        kind: 'SERVICE',
        description: 'Consulting',
        quantity: '2.000000',
        // 6dp UnitCost, as the real API sends it — NOT 4dp Money (regression: moneyFromString
        // would throw AmountError on this via Money.from's scale-4 check; caught by
        // tests/e2e/m4-invoices.spec.ts against a real posted invoice, "10000.000000").
        unitPrice: '5000.000000',
        lineNet: '10000.0000',
      },
    ],
    netAmount: '10000.0000',
    outstanding: '10000.0000',
    allocations: [],
    journalEntry: { id: 'je-1', number: 'JE-2027-000001' },
    reversal: null,
    reversalBlockedBy: [],
    posted: { at: '2026-09-01T10:00:00Z', by: 'user-1' },
    version: 1,
    createdAt: '2026-09-01T09:00:00Z',
    createdBy: 'user-1',
    updatedAt: '2026-09-01T10:00:00Z',
    updatedBy: 'user-1',
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

function renderScreen(path = '/sales/inv-1', can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ ...fakeAuth, can }}>
        <SaleDetail data={{} as never} />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('SaleDetail', () => {
  it('renders a posted invoice with lines, totals, allocations and the journal link', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, invoice())))

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'INV-000001' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Shifa Medical Centre (CUST-000001)')).toBeInTheDocument()
    expect(screen.getByText('Consulting')).toBeInTheDocument()
    // Regression: unitPrice is a 6dp UnitCost string, not 4dp Money — this must round through
    // UnitCost, not crash moneyFromString's Money.from scale-4 check.
    expect(screen.getByText('Rs 5,000.00')).toBeInTheDocument()
    // Regression (design-system review, 66019c0): quantity is a 6dp string ("2.000000") —
    // trailing zeros trimmed for display, never parsed into a JS number to do it.
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('2.000000')).not.toBeInTheDocument()
    expect(screen.getAllByText('Rs 10,000.00').length).toBeGreaterThan(0)
    expect(screen.getByText('JE-2027-000001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument()
  })

  it('shows which receipts must be reversed first and disables Reverse', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, invoice({ reversalBlockedBy: [{ id: 'r1', number: 'RCT-000001' }] })),
      ),
    )

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'INV-000001' })).toBeInTheDocument(),
    )
    expect(screen.getByText(/Reverse RCT-000001 first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('offers "Edit draft" instead of Reverse for a draft invoice', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, invoice({ status: 'DRAFT', number: null, posted: null }))),
    )

    renderScreen()

    await waitFor(() => expect(screen.getByText('Draft invoice')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('never offers Reverse without voucher.reverse, even on a posted invoice', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, invoice())))

    renderScreen('/sales/inv-1', (code) => code !== 'voucher.reverse')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'INV-000001' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('opens the reverse dialog, requires a reason and confirmation, then posts', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let reversed = false
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/reverse')) {
        reversed = true
        return Promise.resolve(jsonResponse(200, invoice({ status: 'REVERSED' })))
      }
      return Promise.resolve(
        jsonResponse(200, invoice({ status: reversed ? 'REVERSED' : 'POSTED' })),
      )
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reverse invoice' }))
    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Wrong customer' } })
    fireEvent.click(screen.getByLabelText(/I understand this cannot be undone/i))
    fireEvent.click(screen.getByRole('button', { name: 'Reverse invoice' }))

    await waitFor(() => expect(reversed).toBe(true))
  })

  it('maps invoice_has_live_allocations to the PO-mandated copy', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/reverse'))
        return Promise.resolve(
          jsonResponse(409, {
            statusCode: 409,
            error: 'invoice_has_live_allocations',
            message: 'Invoice has live allocations',
          }),
        )
      return Promise.resolve(jsonResponse(200, invoice()))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }))
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'test' } })
    fireEvent.click(screen.getByLabelText(/I understand this cannot be undone/i))
    fireEvent.click(screen.getByRole('button', { name: 'Reverse invoice' }))

    await waitFor(() => expect(screen.getByText(/reverse the receipt first/i)).toBeInTheDocument())
  })

  it('shows Record not found for a missing invoice', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(404, {
          statusCode: 404,
          error: 'invoice_not_found',
          message: 'Invoice not found.',
        }),
      ),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText('Record not found')).toBeInTheDocument())
  })
})
