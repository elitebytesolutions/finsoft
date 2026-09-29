/* Component tests for /trial-balance (docs/design-system/pages/trial-balance/README.md) —
 * every state this screen commits to. Mocks `fetch`, not accounting-client, matching
 * api-client.test.tsx / login.test.tsx's convention. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrialBalance } from '@/screens/trial-balance'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  setAccessToken('tok-1')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TrialBalance', () => {
  it('shows a loading state, then the balanced report', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(200, {
        asOf: '2026-09-29',
        lines: [
          {
            accountId: 'a1',
            code: '1120',
            name: 'Bank — Current Account',
            type: 'ASSET',
            debit: '455000.0000',
            credit: '0.0000',
          },
          {
            accountId: 'a2',
            code: '3100',
            name: "Owner's Capital",
            type: 'EQUITY',
            debit: '0.0000',
            credit: '455000.0000',
          },
        ],
        totalDebit: '455000.0000',
        totalCredit: '455000.0000',
      }),
    )

    render(<TrialBalance />)

    expect(screen.getByText(/loading the trial balance/i)).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.getByText(/balanced — total debit equals total credit/i)).toBeInTheDocument(),
    )

    expect(screen.getByText('Bank — Current Account')).toBeInTheDocument()
    expect(screen.getByText("Owner's Capital")).toBeInTheDocument()
    expect(screen.getAllByText('Rs 455,000.00').length).toBeGreaterThan(0)
  })

  it('shows the empty state when there is no activity yet', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(200, {
        asOf: '2026-09-29',
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
      }),
    )

    render(<TrialBalance />)

    await waitFor(() =>
      expect(screen.getByText(/No activity as of 2026-09-29/i)).toBeInTheDocument(),
    )
  })

  it('shows an error state with a retry that re-fetches', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { statusCode: 500, error: 'internal', message: 'boom' }),
    )

    render(<TrialBalance />)

    await waitFor(() =>
      expect(screen.getByText(/we could not load the trial balance/i)).toBeInTheDocument(),
    )

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        asOf: '2026-09-29',
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
      }),
    )
    screen.getByRole('button', { name: /try again/i }).click()

    await waitFor(() =>
      expect(screen.getByText(/No activity as of 2026-09-29/i)).toBeInTheDocument(),
    )
  })

  it('shows the forbidden state on a 403, without a retry', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }),
    )

    render(<TrialBalance />)

    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })
})
