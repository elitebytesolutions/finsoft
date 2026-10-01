/* Component tests for /sales/voucher (SalesVoucher — M4-W2, real service-mode invoices). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { SalesVoucher } from '@/screens/sales-voucher'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'
import { FinsoftProvider } from '@/app-context'

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

const CUSTOMERS_PAGE = {
  items: [
    {
      id: 'cus-1',
      code: 'CUST-000001',
      name: 'Shifa Medical Centre',
      phone: null,
      city: 'Lahore',
      status: 'ACTIVE',
      balance: '0.0000',
      balanceAsOf: '2026-09-01',
    },
  ],
  nextCursor: null,
}

function calcResponse(lineNet = '10000.0000') {
  return {
    lines: [{ lineNo: 1, quantity: '2.000000', unitPrice: '5000.0000', lineNet }],
    netAmount: lineNet,
    problems: [],
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

function renderScreen(path = '/sales/voucher', can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ ...fakeAuth, can }}>
        {/* SalesVoucher's outer mode-switch wrapper reads useFinsoft() even in Service mode
            (it needs `data` to hand ProductSalesVoucher if the user switches), same nesting
            order as harness.tsx's App (AuthContext outside FinsoftProvider — FinsoftProvider
            itself reads useAuth()). */}
        <FinsoftProvider>
          <SalesVoucher />
        </FinsoftProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

function fetchRouter(
  overrides: {
    create?: (body: Record<string, unknown>) => unknown
    post?: (id: string) => unknown
  } = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/customers')) return Promise.resolve(jsonResponse(200, CUSTOMERS_PAGE))
    if (url === '/api/invoices/calculate' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(200, calcResponse()))
    }
    if (url === '/api/invoices' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      const result = overrides.create?.(body) ?? {
        id: 'inv-new',
        number: null,
        status: 'DRAFT',
        version: 1,
        netAmount: '10000.0000',
      }
      return Promise.resolve(jsonResponse(200, result))
    }
    if (url.match(/\/api\/invoices\/[^/]+\/post$/) && init?.method === 'POST') {
      const id = url.split('/')[3]
      const result = overrides.post?.(id) ?? {
        id,
        number: 'INV-000001',
        status: 'POSTED',
        version: 2,
      }
      return Promise.resolve(jsonResponse(200, result))
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method}`)
  }
}

async function fillOneLine() {
  await waitFor(() => expect(screen.getByLabelText('Customer')).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText('Customer'), {
    target: { value: 'Shifa Medical Centre (CUST-000001)' },
  })
  fireEvent.change(screen.getByLabelText('Description 1'), { target: { value: 'Consulting' } })
  fireEvent.change(screen.getByLabelText('Qty 1'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Rate 1'), { target: { value: '5000' } })
}

describe('SalesVoucher', () => {
  it('shows Access restricted without invoice.create', () => {
    renderScreen('/sales/voucher', () => false)
    expect(screen.getByText('Access restricted')).toBeInTheDocument()
  })

  it('Product mode shows the restored prototype, with Save/Post disabled and never calling the API', async () => {
    renderScreen()
    await waitFor(() => expect(screen.getByLabelText('Customer')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Product' }))

    expect(screen.getByText('Prototype — not connected to the ledger')).toBeInTheDocument()
    // The restored product/batch/GST form, not the service-line form.
    expect(screen.getByText('Fulfillment & Sales Team')).toBeInTheDocument()
    expect(screen.getByText('Sale No')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /GST %/ })).toBeInTheDocument()
    // Accounting review (66019c0): the fake INV-... number is gone, replaced with a neutral
    // placeholder — this prototype has never created a real invoice, so it must never claim one.
    expect(screen.getByText('Assigned on posting')).toBeInTheDocument()
    expect(screen.queryByText(/^INV-\d+$/)).not.toBeInTheDocument()

    const saveDraft = screen.getByRole('button', { name: /save draft/i })
    const savePost = screen.getByRole('button', { name: /save & post/i })
    expect(saveDraft).toBeDisabled()
    expect(savePost).toBeDisabled()
    expect(saveDraft).toHaveAttribute('title', 'Coming with inventory and tax (Waves 5–9)')
    expect(savePost).toHaveAttribute('title', 'Coming with inventory and tax (Waves 5–9)')

    const fetchMock = fetch as ReturnType<typeof vi.fn>
    expect(fetchMock).not.toHaveBeenCalled()

    // Switching back to Service restores the real form and drops the banner.
    fireEvent.click(screen.getByRole('button', { name: 'Service' }))
    expect(screen.queryByText('Prototype — not connected to the ledger')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Customer')).toBeInTheDocument()
  })

  it('calculates the line net amount and invoice total via I6, never in the browser', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(fetchRouter())

    renderScreen()
    await fillOneLine()

    await waitFor(() => expect(screen.getAllByText('Rs 10,000.00').length).toBeGreaterThan(0))
  })

  it('Save Draft posts to /api/invoices with the entered line', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(fetchRouter())

    renderScreen()
    await fillOneLine()
    await waitFor(() => expect(screen.getAllByText('Rs 10,000.00').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/invoices' && (c[1] as RequestInit)?.method === 'POST',
      )
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as RequestInit).body as string)
      expect(body.customerId).toBe('cus-1')
      expect(body.lines).toEqual([{ description: 'Consulting', quantity: '2', unitPrice: '5000' }])
    })
    await waitFor(() => expect(screen.getByText('Saved as draft.')).toBeInTheDocument())
  })

  it('Save & Post confirms first, then creates and posts the invoice', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(fetchRouter())

    renderScreen()
    await fillOneLine()
    await waitFor(() => expect(screen.getAllByText('Rs 10,000.00').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: /save & post/i }))
    const dialog = await screen.findByRole('dialog', { name: /post invoice/i })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post invoice' }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) =>
        (c[0] as string).match(/\/api\/invoices\/[^/]+\/post$/),
      )
      expect(postCall).toBeTruthy()
      const headers = (postCall![1] as RequestInit).headers as Headers
      expect(headers.get('Idempotency-Key')).toBeTruthy()
    })
  })

  it("calculates and posts over complete lines only, and quotes the saved draft's own figure", async () => {
    // Accounting review (66019c0): /calculate used to include an incomplete line padded with
    // '0' defaults while Post sent only complete lines — the two totals could disagree. The
    // fix sends /calculate over complete lines only, and the confirm dialog quotes the SAVED
    // draft's own netAmount, not a parallel /calculate figure — proven here by making them
    // different: calc says 10,000 (one line), the draft the server actually saved says
    // 12,000, as if a server-side rounding or a second viewer's edit made them diverge.
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(
      fetchRouter({
        create: () => ({
          id: 'inv-new',
          number: null,
          status: 'DRAFT',
          version: 1,
          netAmount: '12000.0000',
        }),
      }),
    )

    renderScreen()
    await fillOneLine()
    await waitFor(() => expect(screen.getAllByText('Rs 10,000.00').length).toBeGreaterThan(0))

    // A second, incomplete line — description only, no qty/rate. Adding it reruns the
    // debounced /calculate effect (still over the one complete line) — wait for THAT to settle
    // before posting, the same way a real user's click would land after, not during, typing.
    fireEvent.click(screen.getByRole('button', { name: /add row/i }))
    fireEvent.change(screen.getByLabelText('Description 2'), {
      target: { value: 'Follow-up (not priced yet)' },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /save & post/i })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: /save & post/i }))

    const dialog = await screen.findByRole('dialog', { name: /post invoice/i })
    // The dialog quotes the DRAFT's server figure (12,000), not the /calculate figure (10,000).
    expect(within(dialog).getByText(/Rs 12,000\.00/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Rs 10,000\.00/)).not.toBeInTheDocument()

    // Neither /calculate nor the POST that created the draft ever carried the incomplete
    // second row — not even padded with '0' defaults.
    const calcCall = fetchMock.mock.calls.find((c) => c[0] === '/api/invoices/calculate')
    expect(calcCall).toBeTruthy()
    expect(JSON.parse((calcCall![1] as RequestInit).body as string).lines).toEqual([
      { description: 'Consulting', quantity: '2', unitPrice: '5000' },
    ])
    const createCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/invoices' && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(createCall).toBeTruthy()
    expect(JSON.parse((createCall![1] as RequestInit).body as string).lines).toEqual([
      { description: 'Consulting', quantity: '2', unitPrice: '5000' },
    ])
  })

  it('keeps Save & Post disabled while a calculation is pending', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let resolveCalc: ((v: unknown) => void) | null = null
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/invoices/calculate' && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCalc = resolve
        })
      }
      return fetchRouter()(url, init)
    })

    renderScreen()
    await fillOneLine()

    // The debounced /calculate call is now in flight and never resolved — Post must stay
    // disabled for as long as that's true.
    await waitFor(() => expect(resolveCalc).not.toBeNull())
    expect(screen.getByRole('button', { name: /save & post/i })).toBeDisabled()

    resolveCalc!(
      new Response(JSON.stringify(calcResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /save & post/i })).toBeEnabled())
  })

  it('disables the Post button without invoice.post', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(fetchRouter())

    renderScreen('/sales/voucher', (code) => code !== 'invoice.post')
    await fillOneLine()

    expect(screen.getByRole('button', { name: /save & post/i })).toBeDisabled()
  })

  it('loads an existing draft for editing via ?invoice=', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/invoices/draft-1') {
        return Promise.resolve(
          jsonResponse(200, {
            id: 'draft-1',
            number: null,
            status: 'DRAFT',
            settlement: null,
            customer: { id: 'cus-1', code: 'CUST-000001', name: 'Shifa Medical Centre' },
            invoiceDate: '2026-09-01',
            dueDate: null,
            narration: 'Existing narration',
            lines: [
              {
                lineNo: 1,
                kind: 'SERVICE',
                description: 'Prior consult',
                quantity: '1.000000',
                unitPrice: '4000.0000',
                lineNet: '4000.0000',
              },
            ],
            netAmount: '4000.0000',
            outstanding: null,
            allocations: [],
            journalEntry: null,
            reversal: null,
            reversalBlockedBy: [],
            posted: null,
            version: 3,
            createdAt: '2026-09-01T00:00:00Z',
            createdBy: 'u1',
            updatedAt: '2026-09-01T00:00:00Z',
            updatedBy: 'u1',
          }),
        )
      }
      if (url.startsWith('/api/customers'))
        return Promise.resolve(jsonResponse(200, CUSTOMERS_PAGE))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderScreen('/sales/voucher?invoice=draft-1')

    await waitFor(() => expect(screen.getByDisplayValue('Prior consult')).toBeInTheDocument())
    expect(screen.getByDisplayValue('Shifa Medical Centre (CUST-000001)')).toBeInTheDocument()
  })
})
