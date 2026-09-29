/* Component tests for /ledgers (docs/design-system/pages/account-ledger/README.md). Mocks
 * `fetch`, matching the rest of the M2-S suite. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { AccountLedger } from '@/screens/account-ledger'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ACCOUNTS = {
  accounts: [
    { id: 'a1110', code: '1110', name: 'Cash in Hand', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'CASH_DEFAULT', restricted: false, parentId: null, isActive: true },
    { id: 'a1120', code: '1120', name: 'Bank — Current Account', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'BANK_DEFAULT', restricted: false, parentId: null, isActive: true },
  ],
}
function ledgerResponse(accountId: string) {
  return {
    accountId,
    code: '1110',
    name: 'Cash in Hand',
    type: 'ASSET',
    openingBalance: '1000.0000',
    closingBalance: '6000.0000',
    lines: [
      {
        lineId: 'l1',
        entryId: 'e1',
        entryNumber: 'JV-2027-000001',
        entryStatus: 'POSTED',
        occurredAt: '2026-09-05',
        narration: 'Owner capital contribution',
        sourceType: 'journal_voucher',
        sourceId: 'e1',
        reversalOf: null,
        reversedBy: null,
        debit: '5000.0000',
        credit: '0.0000',
        runningBalance: '6000.0000',
      },
    ],
    nextCursor: null,
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

function renderScreen(path = '/ledgers') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AccountLedger />
    </MemoryRouter>,
  )
}

describe('AccountLedger', () => {
  it('loads accounts, defaults to the first one, and shows its statement', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url.startsWith('/api/ledgers/')) return Promise.resolve(jsonResponse(200, ledgerResponse('a1110')))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()

    await waitFor(() => expect(screen.getByText('Owner capital contribution')).toBeInTheDocument())
    expect(screen.getByText('JV-2027-000001')).toBeInTheDocument()
    expect(screen.getByText('Rs 5,000.00')).toBeInTheDocument() // debit column
  })

  it('preselects the account named by ?account=', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    const calledUrls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      calledUrls.push(url)
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url.startsWith('/api/ledgers/a1120')) return Promise.resolve(jsonResponse(200, ledgerResponse('a1120')))
      if (url.startsWith('/api/ledgers/')) return Promise.resolve(jsonResponse(200, ledgerResponse('a1110')))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen('/ledgers?account=1120')

    await waitFor(() => expect(screen.getByLabelText('Switch account')).toHaveValue('1120'))
  })

  it('shows the empty state when the account has no postings in range', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
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
    await waitFor(() => expect(screen.getByText(/No postings on 1110/)).toBeInTheDocument())
  })

  it('shows the forbidden state on a 403 from the ledger endpoint', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url.startsWith('/api/ledgers/'))
        return Promise.resolve(jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() =>
      expect(screen.getByText(/your role does not have permission to view this ledger/i)).toBeInTheDocument(),
    )
  })
})
