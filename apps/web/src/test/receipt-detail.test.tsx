/* Component tests for /receipts/:id (ReceiptDetail — M4-W2, new; real receipts API). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { ReceiptDetail } from '@/screens/detail-pages'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'
import type { Receipt } from '@/lib/api/receipts-types'

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

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 'rct-1',
    number: 'RCT-000001',
    status: 'POSTED',
    customer: { id: 'cus-1', code: 'CUST-000001', name: 'Shifa Medical Centre' },
    receiptDate: '2026-09-15',
    method: 'BANK',
    amount: '6000.0000',
    reference: 'TRF-9981',
    narration: 'Partial settlement',
    proposals: [],
    proposalProblems: [],
    allocations: [
      {
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-000001',
        invoiceDate: '2026-09-01',
        amount: '6000.0000',
        status: 'LIVE',
      },
    ],
    journalEntry: { id: 'je-2', number: 'JE-2027-000002' },
    reversal: null,
    posted: { at: '2026-09-15T10:00:00Z', by: 'user-1' },
    version: 1,
    createdAt: '2026-09-15T09:00:00Z',
    createdBy: 'user-1',
    updatedAt: '2026-09-15T10:00:00Z',
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

function renderScreen(path = '/receipts/rct-1', can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ ...fakeAuth, can }}>
        <ReceiptDetail />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('ReceiptDetail', () => {
  it('renders a posted receipt with its allocation and the journal link', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, receipt())))

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'RCT-000001' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Shifa Medical Centre (CUST-000001)')).toBeInTheDocument()
    expect(screen.getByText('INV-000001')).toBeInTheDocument()
    expect(screen.getByText('JE-2027-000002')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument()
  })

  it('never offers Reverse without voucher.reverse', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, receipt())))

    renderScreen('/receipts/rct-1', (code) => code !== 'voucher.reverse')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'RCT-000001' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('does not offer Reverse on a draft receipt', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, receipt({ status: 'DRAFT', number: null, posted: null }))),
    )

    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByText('This receipt is a draft. It has not been posted to the ledger.'),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('opens the reverse dialog, requires a reason and confirmation, then posts', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let reversed = false
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/reverse')) {
        reversed = true
        return Promise.resolve(jsonResponse(200, receipt({ status: 'REVERSED' })))
      }
      return Promise.resolve(
        jsonResponse(200, receipt({ status: reversed ? 'REVERSED' : 'POSTED' })),
      )
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reverse receipt' }))
    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Duplicate entry' } })
    fireEvent.click(screen.getByLabelText(/I understand this cannot be undone/i))
    fireEvent.click(screen.getByRole('button', { name: 'Reverse receipt' }))

    await waitFor(() => expect(reversed).toBe(true))
  })

  it('shows Record not found for a missing receipt', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(404, {
          statusCode: 404,
          error: 'receipt_not_found',
          message: 'Receipt not found.',
        }),
      ),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText('Record not found')).toBeInTheDocument())
  })
})
