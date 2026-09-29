/* Component tests for /period-close (docs/design-system/pages/period-close/README.md). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { PeriodClose } from '@/screens/trade-pages'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const PERIODS = {
  periods: [
    { id: 'p1', fiscalYear: 2027, periodIndex: 1, periodStart: '2026-07-01', periodEnd: '2026-07-31', label: '2026-07', status: 'CLOSED' },
    { id: 'p2', fiscalYear: 2027, periodIndex: 2, periodStart: '2026-08-01', periodEnd: '2026-08-31', label: '2026-08', status: 'OPEN' },
    { id: 'p3', fiscalYear: 2027, periodIndex: 3, periodStart: '2026-09-01', periodEnd: '2026-09-30', label: '2026-09', status: 'OPEN' },
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
    <MemoryRouter initialEntries={['/period-close']}>
      <PeriodClose />
    </MemoryRouter>,
  )
}

describe('PeriodClose', () => {
  it('lists periods and offers Close only on the earliest OPEN one', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, PERIODS))

    renderScreen()

    await waitFor(() => expect(screen.getByText('2026-07')).toBeInTheDocument())
    const closeButtons = screen.getAllByRole('button', { name: 'Close' })
    expect(closeButtons).toHaveLength(2) // both OPEN rows render the button...
    expect(closeButtons[0]).toBeEnabled() // ...but only 2026-08 (earliest open) is enabled
    expect(closeButtons[1]).toBeDisabled() // 2026-09 is out of order
  })

  it('offers Reopen only on the latest CLOSED period', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        periods: [
          { id: 'p1', fiscalYear: 2027, periodIndex: 1, periodStart: '2026-07-01', periodEnd: '2026-07-31', label: '2026-07', status: 'CLOSED' },
          { id: 'p2', fiscalYear: 2027, periodIndex: 2, periodStart: '2026-08-01', periodEnd: '2026-08-31', label: '2026-08', status: 'CLOSED' },
          { id: 'p3', fiscalYear: 2027, periodIndex: 3, periodStart: '2026-09-01', periodEnd: '2026-09-30', label: '2026-09', status: 'OPEN' },
        ],
      }),
    )
    renderScreen()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(1))
  })

  it('closes the earliest open period and refreshes', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/close')) return Promise.resolve(jsonResponse(200, { ...PERIODS.periods[1], status: 'CLOSED' }))
      return Promise.resolve(jsonResponse(200, PERIODS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Close' })[0]).toBeEnabled())
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => (call[0] as string).endsWith('/close') && (call[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('requires a reason to reopen, then posts it', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let reopenBody: unknown = null
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/reopen')) {
        reopenBody = JSON.parse(init!.body as string)
        return Promise.resolve(jsonResponse(200, { ...PERIODS.periods[0], status: 'OPEN' }))
      }
      return Promise.resolve(jsonResponse(200, PERIODS))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reopen period' }))
    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Correcting an error' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen period' }))

    await waitFor(() => expect(reopenBody).toEqual({ reason: 'Correcting an error' }))
  })

  it('shows the empty state when no periods exist', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { periods: [] }))
    renderScreen()
    await waitFor(() => expect(screen.getByText(/No fiscal periods exist yet/)).toBeInTheDocument())
  })

  it('shows the forbidden state on a 403', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }))
    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })
})
