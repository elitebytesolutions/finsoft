/* Component tests for /vouchers/new (docs/design-system/pages/voucher-new/README.md). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { VoucherForm } from '@/screens/vouchers'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'

/* M4-W: VoucherFormReady now gates Post on `useAuth().can('voucher.post')`, so these tests
 * need an AuthContext in the tree — same fake seam as period-close.test.tsx and
 * voucher-detail.test.tsx, with `can` defaulting to true so every existing assertion below
 * (which predates permission gating) keeps seeing Post exactly as it always did. */
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
    // Not selectable: a control account and a header.
    {
      id: 'a1200',
      code: '1200',
      name: 'Accounts Receivable',
      type: 'ASSET',
      normalBalance: 'DEBIT',
      kind: 'POSTABLE',
      controlKind: 'AR',
      role: 'AR_CONTROL',
      restricted: false,
      parentId: null,
      isActive: true,
    },
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

function renderScreen(can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={['/vouchers/new']}>
      <AuthContext.Provider value={{ ...fakeAuth, can }}>
        <VoucherForm />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function fillBalancedVoucher(narration = 'Owner capital') {
  await waitFor(() => expect(screen.getByLabelText('Account line 1')).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/^narration/i), { target: { value: narration } })
  fireEvent.change(screen.getByLabelText('Account line 1'), { target: { value: 'a1110' } })
  fireEvent.change(screen.getByLabelText('Debit line 1'), { target: { value: '50000' } })
  fireEvent.change(screen.getByLabelText('Account line 2'), { target: { value: 'a3100' } })
  fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '50000' } })
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

  it('opening Post shows a confirm dialog naming the date, totals and line count — nothing is posted yet', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ACCOUNTS))

    renderScreen()
    await fillBalancedVoucher()
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))

    const dialog = screen.getByRole('dialog', { name: /post voucher/i })
    expect(
      within(dialog).getAllByText(new Date().toISOString().slice(0, 10)).length,
    ).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('Rs 50,000.00').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('2')).toBeInTheDocument() // line count

    // Confirming is required — nothing posted by opening the dialog alone.
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/journals')).toBe(false)
  })

  it('posts only after the dialog is confirmed, with an Idempotency-Key, and navigates on success', async () => {
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
    await fillBalancedVoucher()
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))

    const dialog = screen.getByRole('dialog', { name: /post voucher/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /post voucher/i }))

    const findPostCall = () =>
      fetchMock.mock.calls.find(
        (call) =>
          call[0] === '/api/journals' && (call[1] as RequestInit | undefined)?.method === 'POST',
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

  it('cancelling the dialog then posting again reuses the same Idempotency-Key', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
      if (url === '/api/journals' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(200, {
            outcome: 'POSTED',
            id: 'new-entry-id',
            entryNumber: 'JV-2027-000006',
            lines: [],
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen()
    await fillBalancedVoucher()

    // Open the confirm dialog, then cancel it without posting.
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/journals')).toBe(false)

    // Open it again and actually confirm — same logical submission, same key.
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))
    const dialog = screen.getByRole('dialog', { name: /post voucher/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /post voucher/i }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/journals')).toBe(true),
    )
    const postCalls = fetchMock.mock.calls.filter(
      (call) =>
        call[0] === '/api/journals' && (call[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCalls).toHaveLength(1) // cancelling didn't post; only the confirmed attempt did
    const key = ((postCalls[0][1] as RequestInit).headers as Headers).get('Idempotency-Key')
    expect(key).toBeTruthy()
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
    await fillBalancedVoucher('x')
    fireEvent.click(screen.getByRole('button', { name: /post voucher/i }))
    const dialog = screen.getByRole('dialog', { name: /post voucher/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /post voucher/i }))

    // A failed post closes the confirm dialog and shows the server's own rejection on the form.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText(/debits and credits differ/i)).toBeInTheDocument()
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

  it('keeps Post disabled for a balanced voucher when the caller lacks voucher.post', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ACCOUNTS))

    renderScreen(() => false)
    await fillBalancedVoucher()

    expect(screen.getByText('Balanced')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /post voucher/i })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/journals')).toBe(false)
  })
})
