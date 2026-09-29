/* Component tests for /vouchers/:id (docs/design-system/pages/voucher-detail/README.md). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { VoucherDetail } from '@/screens/vouchers'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ACCOUNTS = {
  accounts: [
    {
      id: 'a1110',
      code: '1110',
      name: 'Cash in Hand',
      type: 'ASSET',
      normalBalance: 'DEBIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: 'CASH_DEFAULT',
      restricted: false,
      parentId: null,
      isActive: true,
    },
    {
      id: 'a3100',
      code: '3100',
      name: "Owner's Capital",
      type: 'EQUITY',
      normalBalance: 'CREDIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: null,
      restricted: false,
      parentId: null,
      isActive: true,
    },
  ],
}
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    entryNumber: 'JV-2027-000001',
    postingRule: 'JOURNAL_VOUCHER_POSTED@1',
    event: 'JOURNAL_VOUCHER_POSTED',
    occurredAt: '2026-09-29',
    status: 'POSTED',
    narration: 'Owner capital contribution',
    reference: null,
    sourceType: 'journal_voucher',
    sourceId: 'e1',
    reversalOf: null,
    reversedBy: null,
    reversalReason: null,
    lines: [
      {
        lineNumber: 1,
        accountId: 'a1110',
        debit: '50000.0000',
        credit: '0.0000',
        partyId: null,
        memo: null,
      },
      {
        lineNumber: 2,
        accountId: 'a3100',
        debit: '0.0000',
        credit: '50000.0000',
        partyId: null,
        memo: null,
      },
    ],
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

function renderScreen(path = '/vouchers/e1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <VoucherDetail />
    </MemoryRouter>,
  )
}

describe('VoucherDetail', () => {
  it('renders the entry with resolved account names and a Reverse action', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals/')) return Promise.resolve(jsonResponse(200, detail()))
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'JV-2027-000001' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Cash in Hand (1110)')).toBeInTheDocument()
    expect(screen.getByText("Owner's Capital (3100)")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument()
  })

  it('does not offer Reverse on an already-reversed entry', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals/'))
        return Promise.resolve(jsonResponse(200, detail({ status: 'REVERSED', reversedBy: 'rv1' })))
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'JV-2027-000001' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('does not offer Reverse on a reversal entry itself', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals/'))
        return Promise.resolve(
          jsonResponse(
            200,
            detail({ entryNumber: 'RV-2027-000001', reversalOf: 'e0', reversalReason: 'oops' }),
          ),
        )
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'RV-2027-000001' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })

  it('opens the reverse dialog, requires a reason and confirmation, then posts', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let reversed = false
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/reverse')) {
        reversed = true
        return Promise.resolve(
          jsonResponse(200, { ...detail({ status: 'REVERSED' }), disclosure: null }),
        )
      }
      if (url.startsWith('/api/journals/'))
        return Promise.resolve(
          jsonResponse(200, detail({ status: reversed ? 'REVERSED' : 'POSTED' })),
        )
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      throw new Error(`unexpected fetch: ${url} ${init?.method}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }))

    // Submitting with no reason / no confirmation is refused client-side.
    fireEvent.click(screen.getByRole('button', { name: 'Reverse voucher' }))
    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Wrong account' } })
    fireEvent.click(screen.getByLabelText(/I understand this cannot be undone/i))
    fireEvent.click(screen.getByRole('button', { name: 'Reverse voucher' }))

    await waitFor(() => expect(reversed).toBe(true))
  })

  it('shows Not found for entry_not_found', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals/'))
        return Promise.resolve(
          jsonResponse(404, { statusCode: 404, error: 'entry_not_found', message: 'Not found' }),
        )
      return Promise.resolve(jsonResponse(200, ACCOUNTS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText('Record not found')).toBeInTheDocument())
  })
})
