/* Component tests for /vouchers (docs/design-system/pages/voucher-register/README.md). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { VoucherRegister } from '@/screens/voucher-register'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const LIST = {
  items: [
    {
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
    },
  ],
  nextCursor: null,
}
const ACCOUNTS = {
  accounts: [
    { id: 'a1110', code: '1110', name: 'Cash in Hand', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'CASH_DEFAULT', restricted: false, parentId: null, isActive: true },
  ],
}
const DETAIL = {
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
    { lineNumber: 1, accountId: 'a1110', debit: '50000.0000', credit: '0.0000', partyId: null, memo: null },
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

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/vouchers']}>
      <VoucherRegister />
    </MemoryRouter>,
  )
}

describe('VoucherRegister', () => {
  it('lists vouchers and opens the inspector with real lines', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals/')) return Promise.resolve(jsonResponse(200, DETAIL))
      if (url.startsWith('/api/journals')) return Promise.resolve(jsonResponse(200, LIST))
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()

    await waitFor(() => expect(screen.getByText('JV-2027-000001')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Owner capital contribution'))

    await waitFor(() => expect(screen.getByText('Cash in Hand (1110)')).toBeInTheDocument())
    expect(screen.getByText('Rs 50,000.00')).toBeInTheDocument()
  })

  it('shows the empty state when there are no vouchers', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals')) return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, { accounts: [] }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/No vouchers yet/)).toBeInTheDocument())
  })

  it('re-fetches with the status filter', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    const urls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      urls.push(url)
      if (url.startsWith('/api/journals')) return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, { accounts: [] }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/No vouchers yet/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reversed' }))
    await waitFor(() => expect(urls.some((u) => u.includes('status=REVERSED'))).toBe(true))
  })

  it('shows the forbidden state on a 403', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/journals'))
        return Promise.resolve(jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }))
      return Promise.resolve(jsonResponse(200, { accounts: [] }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })
})
