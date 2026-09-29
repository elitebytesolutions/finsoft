/* Component tests for /vouchers/new (docs/design-system/pages/voucher-new/README.md). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { VoucherForm } from '@/screens/vouchers'
import { setAccessToken } from '@/lib/api/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ACCOUNTS = {
  accounts: [
    { id: 'a1110', code: '1110', name: 'Cash in Hand', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'NONE', role: 'CASH_DEFAULT', restricted: false, parentId: null, isActive: true },
    { id: 'a3100', code: '3100', name: "Owner's Capital", type: 'EQUITY', normalBalance: 'CREDIT', kind: 'POSTABLE', controlKind: 'NONE', role: null, restricted: false, parentId: null, isActive: true },
    // Not selectable: a control account and a header.
    { id: 'a1200', code: '1200', name: 'Accounts Receivable', type: 'ASSET', normalBalance: 'DEBIT', kind: 'POSTABLE', controlKind: 'AR', role: 'AR_CONTROL', restricted: false, parentId: null, isActive: true },
    { id: 'a1000', code: '1000', name: 'Assets', type: 'ASSET', normalBalance: 'DEBIT', kind: 'HEADER', controlKind: 'NONE', role: null, restricted: false, parentId: null, isActive: true },
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
    <MemoryRouter initialEntries={['/vouchers/new']}>
      <VoucherForm />
    </MemoryRouter>,
  )
}

describe('VoucherForm (New Voucher)', () => {
  it('only offers postable, non-control accounts in the picker', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ACCOUNTS))

    renderScreen()

    await waitFor(() => expect(screen.getByLabelText('Account line 1')).toBeInTheDocument())
    const options = screen.getAllByLabelText('Account line 1')[0].querySelectorAll('option')
    const labels = [...options].map((o) => o.textContent)
    expect(labels).toContain('Cash in Hand (1110)')
    expect(labels).toContain("Owner's Capital (3100)")
    expect(labels.some((l) => l?.includes('Accounts Receivable'))).toBe(false)
    expect(labels.some((l) => l?.includes('Assets'))).toBe(false)
  })

  it('keeps Post disabled until the entered lines balance exactly', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ACCOUNTS))

    renderScreen()
    await waitFor(() => expect(screen.getByLabelText('Account line 1')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^narration/i), { target: { value: 'Owner capital' } })
    fireEvent.change(screen.getByLabelText('Account line 1'), { target: { value: 'a1110' } })
    fireEvent.change(screen.getByLabelText('Debit line 1'), { target: { value: '50000' } })
    fireEvent.change(screen.getByLabelText('Account line 2'), { target: { value: 'a3100' } })
    fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '49000' } })

    expect(screen.getByText('Unbalanced')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /post voucher/i })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '50000' } })
    expect(screen.getByText('Balanced')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /post voucher/i })).toBeEnabled()
  })

  it('posts with an Idempotency-Key and navigates to the new voucher on success', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url === '/api/journals' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(200, {
            outcome: 'POSTED',
            id: 'new-entry-id',
            entryNumber: 'JV-2027-000005',
            lines: [],
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByLabelText('Account line 1')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^narration/i), { target: { value: 'Owner capital' } })
    fireEvent.change(screen.getByLabelText('Account line 1'), { target: { value: 'a1110' } })
    fireEvent.change(screen.getByLabelText('Debit line 1'), { target: { value: '50000' } })
    fireEvent.change(screen.getByLabelText('Account line 2'), { target: { value: 'a3100' } })
    fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '50000' } })

    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))

    const findPostCall = () =>
      fetchMock.mock.calls.find(
        (call) => call[0] === '/api/journals' && (call[1] as RequestInit | undefined)?.method === 'POST',
      )

    await waitFor(() => expect(findPostCall()).toBeTruthy())
    const postInit = findPostCall()![1] as RequestInit
    const headers = postInit.headers as Headers
    expect(headers.get('Idempotency-Key')).toBeTruthy()
    const body = JSON.parse(postInit!.body as string)
    expect(body.lines).toEqual([
      { accountId: 'a1110', debit: '50000' },
      { accountId: 'a3100', credit: '50000' },
    ])
  })

  it('maps a jv_unbalanced server rejection to the totals bar message', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url === '/api/journals' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(409, {
            statusCode: 409,
            error: 'jv_unbalanced',
            message: 'Debits and credits differ.',
            details: { totalDebit: '50000.0000', totalCredit: '49999.0000' },
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await waitFor(() => expect(screen.getByLabelText('Account line 1')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^narration/i), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Account line 1'), { target: { value: 'a1110' } })
    fireEvent.change(screen.getByLabelText('Debit line 1'), { target: { value: '50000' } })
    fireEvent.change(screen.getByLabelText('Account line 2'), { target: { value: 'a3100' } })
    fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '50000' } })
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))

    await waitFor(() => expect(screen.getByText(/debits and credits differ/i)).toBeInTheDocument())
    expect(screen.getByText(/50000.0000/)).toBeInTheDocument()
  })

  it('shows the forbidden state when the account list itself 403s', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { statusCode: 403, error: 'forbidden', message: 'nope' }),
    )

    renderScreen()
    await waitFor(() => expect(screen.getByText(/access restricted/i)).toBeInTheDocument())
  })
})
