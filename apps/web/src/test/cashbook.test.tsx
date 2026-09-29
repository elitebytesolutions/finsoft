/* Component tests for /cash-book (docs/design-system/pages/cash-book/README.md). */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { CashBook } from '@/screens/cashbook'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
    <MemoryRouter initialEntries={['/cash-book']}>
      <CashBook />
    </MemoryRouter>,
  )
}

describe('CashBook', () => {
  it('resolves the account by CASH_DEFAULT role and shows its ledger', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts'))
        return Promise.resolve(
          jsonResponse(200, {
            accounts: [
              { id: 'a1110', code: '1110', name: 'Cash in Hand', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'CASH_DEFAULT', restricted: false, parentId: null, isActive: true },
              { id: 'a1120', code: '1120', name: 'Bank', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'BANK_DEFAULT', restricted: false, parentId: null, isActive: true },
            ],
          }),
        )
      if (url.startsWith('/api/ledgers/a1110'))
        return Promise.resolve(
          jsonResponse(200, {
            accountId: 'a1110',
            code: '1110',
            name: 'Cash in Hand',
            type: 'ASSET',
            openingBalance: '0.0000',
            closingBalance: '2000.0000',
            lines: [
              {
                lineId: 'l1',
                entryId: 'e1',
                entryNumber: 'JV-2027-000002',
                entryStatus: 'POSTED',
                occurredAt: '2026-09-10',
                narration: 'Cash sale',
                sourceType: 'journal_voucher',
                sourceId: 'e1',
                reversalOf: null,
                reversedBy: null,
                debit: '2000.0000',
                credit: '0.0000',
                runningBalance: '2000.0000',
              },
            ],
            nextCursor: null,
          }),
        )
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()

    await waitFor(() => expect(screen.getByText('Cash sale')).toBeInTheDocument())
    expect(screen.getByText('JV-2027-000002')).toBeInTheDocument()
    expect(screen.queryByText(/resolved by code/i)).not.toBeInTheDocument()
  })

  it('falls back to code 1110 and warns when no account holds the CASH_DEFAULT role', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts'))
        return Promise.resolve(
          jsonResponse(200, {
            accounts: [
              { id: 'a1110', code: '1110', name: 'Cash in Hand', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: null, restricted: false, parentId: null, isActive: true },
            ],
          }),
        )
      if (url.startsWith('/api/ledgers/'))
        return Promise.resolve(
          jsonResponse(200, {
            accountId: 'a1110',
            code: '1110',
            name: 'Cash in Hand',
            type: 'ASSET',
            openingBalance: '0.0000',
            closingBalance: '0.0000',
            lines: [],
            nextCursor: null,
          }),
        )
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/resolved by code 1110/i)).toBeInTheDocument())
  })

  it('shows an empty state naming the fact there is nothing to see, without a fabricated chart mismatch', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { accounts: [] }))

    renderScreen()
    await waitFor(() => expect(screen.getByText(/No account holds the Cash in Hand role/)).toBeInTheDocument())
  })
})
