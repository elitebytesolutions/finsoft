/* Component tests for /accounts (docs/design-system/pages/chart-of-accounts/README.md) —
 * every state, plus the read-only fact this screen commits to (coa-standard.md §5). Mocks
 * `fetch`, matching trial-balance.test.tsx's convention. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { ChartOfAccounts } from '@/screens/chart-of-accounts'
import { setAccessToken } from '@/lib/api/session'

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/accounts']}>
      <ChartOfAccounts />
    </MemoryRouter>,
  )
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ACCOUNTS = {
  accounts: [
    {
      id: 'a1000',
      code: '1000',
      name: 'Assets',
      type: 'ASSET',
      normalBalance: 'DEBIT',
      kind: 'HEADER',
      controlKind: 'NONE',
      role: null,
      restricted: false,
      parentId: null,
      isActive: true,
    },
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
      parentId: 'a1000',
      isActive: true,
    },
  ],
}
const TRIAL_BALANCE = {
  asOf: '2026-09-29',
  lines: [
    {
      accountId: 'a1110',
      code: '1110',
      name: 'Cash in Hand',
      type: 'ASSET',
      debit: '5000.0000',
      credit: '0.0000',
    },
  ],
  totalDebit: '5000.0000',
  totalCredit: '5000.0000',
}

beforeEach(() => {
  setAccessToken('tok-1')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockBothCalls() {
  const fetchMock = fetch as ReturnType<typeof vi.fn>
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
    if (url.startsWith('/api/reports/trial-balance'))
      return Promise.resolve(jsonResponse(200, TRIAL_BALANCE))
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe('ChartOfAccounts', () => {
  it('shows loading, then the tree with a resolved balance', async () => {
    mockBothCalls()
    renderScreen()

    expect(screen.getByText(/loading the chart of accounts/i)).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('Cash in Hand')).toBeInTheDocument())
    expect(screen.getByText('Assets')).toBeInTheDocument()
    expect(screen.getByText('Rs 5,000.00')).toBeInTheDocument()
  })

  it('shows an em dash for an account with no activity in the trial balance', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url.startsWith('/api/reports/trial-balance'))
        return Promise.resolve(
          jsonResponse(200, {
            asOf: '2026-09-29',
            lines: [],
            totalDebit: '0.0000',
            totalCredit: '0.0000',
          }),
        )
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText('Cash in Hand')).toBeInTheDocument())
    // The header row and the postable row both show em dash — no activity anywhere.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('has no add/edit/delete affordance — the chart is read-only', async () => {
    mockBothCalls()
    renderScreen()
    await waitFor(() => expect(screen.getByText('Cash in Hand')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /add account/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/not available yet/i)).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { statusCode: 500, error: 'internal', message: 'boom' }),
    )

    renderScreen()
    await waitFor(() =>
      expect(screen.getByText(/we could not load the chart of accounts/i)).toBeInTheDocument(),
    )
  })

  it('shows the forbidden state on a 403', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })
})
