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
    // "Assets" also names an <option> in the restored screen's category filter (absent from the
    // M2-S-era read-only screen, which had no such filter) — getAllBy, not getBy.
    expect(screen.getAllByText('Assets').length).toBeGreaterThanOrEqual(2)
    // The side is shown alongside the amount — Cash in Hand's normal side is Dr, and the trial
    // balance mock below has it in the debit column, so this is its normal (not abnormal) case.
    // The restored screen's own "Total Assets" summary card is Assets' only child rolled up —
    // in this two-account fixture that rollup is numerically identical to Cash in Hand's own
    // row, so the same formatted string legitimately appears twice (row + KPI card); `getAllBy`
    // rather than `getBy`, unlike the M2-S-era read-only screen which had no summary cards at
    // all. See the M2-UI report's DECISIONS.
    expect(screen.getAllByText('Rs 5,000.00 Dr').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Cr, not Dr, for an abnormal balance — a credit on an asset must read as abnormal', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url.startsWith('/api/reports/trial-balance'))
        return Promise.resolve(
          jsonResponse(200, {
            asOf: '2026-09-29',
            // Cash in Hand overdrawn: net is a CREDIT, even though its normal side is debit.
            lines: [
              {
                accountId: 'a1110',
                code: '1110',
                name: 'Cash in Hand',
                type: 'ASSET',
                debit: '0.0000',
                credit: '1500.0000',
              },
            ],
            totalDebit: '0.0000',
            totalCredit: '1500.0000',
          }),
        )
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText('Cash in Hand')).toBeInTheDocument())
    // See the note in the previous test — the "Total Assets" KPI card duplicates the row here.
    expect(screen.getAllByText('Rs 1,500.00 Cr').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Rs 1,500.00 Dr')).not.toBeInTheDocument()
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

  // M2-UI brief: the PO now wants account creation in the MVP, so the original screen's
  // Add/Edit/Move/Activate/Deactivate affordances are restored to the DOM — but every one is
  // disabled behind ACCOUNT_CREATE_ENABLED (feature-flags.ts) until a real POST /api/accounts
  // exists (coa-standard.md §5 is still read-only today). This replaces the M2-S-era assertion
  // that these buttons were entirely absent — see the M2-UI report's DECISIONS for why that
  // assertion changed rather than just its selectors. Delete is not one of them: accounts are
  // never hard-deleted (CLAUDE.md), so there is no Delete button at all, disabled or otherwise
  // (coordinator review, M2-UI).
  it('shows Add/Edit as present but disabled, and no Delete button at all — the chart is still read-only server-side', async () => {
    mockBothCalls()
    renderScreen()
    await waitFor(() => expect(screen.getByText('Cash in Hand')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /add account/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
    expect(screen.getByText('Adding and editing accounts is coming soon.')).toBeInTheDocument()
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
