/*
 * Component tests for the Cash Book's Cash In / Cash Out entry panels — the Accounting seat's
 * conditions for allowing this form to post a real Journal Voucher (M2-UI coordinator review):
 *   1. the confirm dialog shows the real two Dr/Cr lines, not a paraphrase;
 *   2. the counter-account picker never offers a control account (AR/AP) — a manual JV is
 *      rejected server-side (ACCOUNT_CONTROL_MANUAL_FORBIDDEN);
 *   3. the posted payload is a plain two-line JV, nothing else stored.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { CashBook } from '@/screens/cashbook'
import { setAccessToken } from '@/lib/api/session'

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
    // A control account — must never appear in the Income/Expense account picker.
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
      id: 'a4100',
      code: '4100',
      name: 'Sales Revenue',
      type: 'INCOME',
      normalBalance: 'CREDIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: null,
      restricted: false,
      parentId: null,
      isActive: true,
    },
    {
      id: 'a6300',
      code: '6300',
      name: 'Office Expenses',
      type: 'EXPENSE',
      normalBalance: 'DEBIT',
      kind: 'POSTABLE',
      controlKind: 'NONE',
      role: null,
      restricted: false,
      parentId: null,
      isActive: true,
    },
  ],
}
const EMPTY_LEDGER = {
  accountId: 'a1110',
  code: '1110',
  name: 'Cash in Hand',
  type: 'ASSET',
  openingBalance: '0.0000',
  closingBalance: '0.0000',
  lines: [],
  nextCursor: null,
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

interface PostedBody {
  occurredAt: string
  narration: string
  reference: string | null
  lines: unknown[]
}

function mockFetch(onPost?: (body: PostedBody) => void) {
  const fetchMock = fetch as ReturnType<typeof vi.fn>
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/journals' && init?.method === 'POST') {
      onPost?.(JSON.parse(init.body as string))
      return Promise.resolve(
        jsonResponse(200, {
          outcome: 'POSTED',
          id: 'new-id',
          entryNumber: 'JV-2027-000009',
          lines: [],
        }),
      )
    }
    if (url.startsWith('/api/accounts')) return Promise.resolve(jsonResponse(200, ACCOUNTS))
    if (url.startsWith('/api/ledgers/')) return Promise.resolve(jsonResponse(200, EMPTY_LEDGER))
    throw new Error(`unexpected fetch: ${url} ${init?.method}`)
  })
  return fetchMock
}

describe('Cash Book entry — control accounts excluded from the picker', () => {
  it('never offers the AR control account as an Income or Expense account', async () => {
    mockFetch()
    renderScreen()

    await waitFor(() => expect(screen.getByLabelText('Income account')).toBeInTheDocument())
    const incomeOptions = [...screen.getByLabelText('Income account').querySelectorAll('option')]
      .map((o) => o.textContent)
    expect(incomeOptions.some((l) => l?.includes('Accounts Receivable'))).toBe(false)
    expect(incomeOptions.some((l) => l?.includes('Sales Revenue'))).toBe(true)

    const expenseOptions = [...screen.getByLabelText('Expense account').querySelectorAll('option')]
      .map((o) => o.textContent)
    expect(expenseOptions.some((l) => l?.includes('Accounts Receivable'))).toBe(false)
    expect(expenseOptions.some((l) => l?.includes('Office Expenses'))).toBe(true)
  })
})

describe('Cash Book entry — Cash In', () => {
  it('previews Dr Cash / Cr the income account, then posts a plain two-line JV', async () => {
    let posted: { occurredAt: string; narration: string; lines: unknown[] } | null = null
    mockFetch((body) => {
      posted = body
    })
    renderScreen()

    await waitFor(() => expect(screen.getByLabelText('Income account')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Income account'), { target: { value: 'a4100' } })
    fireEvent.change(screen.getByLabelText('Cash in amount'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: /save cash in/i }))

    const dialog = await screen.findByRole('dialog', { name: /confirm cash in/i })
    // The real lines, not a sentence: Cash in Hand Dr 5000, Sales Revenue Cr 5000.
    const rows = within(dialog).getAllByRole('row')
    expect(within(rows[1]).getByText('Cash in Hand')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Rs 5,000.00')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Sales Revenue')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /post entry/i }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted!.lines).toEqual([
      { accountId: 'a1110', debit: '5000' },
      { accountId: 'a4100', credit: '5000' },
    ])
  })
})

describe('Cash Book entry — Cash Out', () => {
  it('previews Dr the expense account / Cr Cash, then posts a plain two-line JV', async () => {
    let posted: { lines: unknown[] } | null = null
    mockFetch((body) => {
      posted = body
    })
    renderScreen()

    await waitFor(() => expect(screen.getByLabelText('Expense account')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Expense account'), { target: { value: 'a6300' } })
    fireEvent.change(screen.getByLabelText('Cash out amount'), { target: { value: '1200' } })
    fireEvent.click(screen.getByRole('button', { name: /save cash out/i }))

    const dialog = await screen.findByRole('dialog', { name: /confirm cash out/i })
    const rows = within(dialog).getAllByRole('row')
    expect(within(rows[1]).getByText('Cash in Hand')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Office Expenses')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Rs 1,200.00')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /post entry/i }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted!.lines).toEqual([
      { accountId: 'a6300', debit: '1200' },
      { accountId: 'a1110', credit: '1200' },
    ])
  })
})

describe('Cash Book entry — Payment Mode and Party are not sent', () => {
  it('posts only the account/amount lines and a narration — no payment-mode or party field', async () => {
    let posted: { narration: string; reference: string | null; lines: unknown[] } | null = null
    mockFetch((body) => {
      posted = body
    })
    renderScreen()

    await waitFor(() => expect(screen.getByLabelText('Income account')).toBeInTheDocument())
    expect(screen.getByLabelText('Income account')).not.toBeDisabled()
    // Party and Payment Mode render disabled — never editable, so never part of the payload.
    const panel = screen.getByText('Cash In').closest('form')!
    const partyInput = within(panel).getByPlaceholderText('Walk-in Customer')
    expect(partyInput).toBeDisabled()
    const modeSelect = within(panel).getByDisplayValue('Cash') as HTMLSelectElement
    expect(modeSelect).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Income account'), { target: { value: 'a4100' } })
    fireEvent.change(screen.getByLabelText('Cash in amount'), { target: { value: '750' } })
    fireEvent.click(screen.getByRole('button', { name: /save cash in/i }))
    const dialog = await screen.findByRole('dialog', { name: /confirm cash in/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /post entry/i }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted!.lines).toHaveLength(2)
    expect(posted!.narration.toLowerCase()).not.toContain('payment mode')
  })
})
