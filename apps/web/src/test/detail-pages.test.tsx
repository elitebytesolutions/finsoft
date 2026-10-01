import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { afterEach, describe, expect, it } from 'vitest'
import App from './harness'
import { nav } from '@/mocks/api'

afterEach(cleanup)

function renderAt(path = '/dashboard') {
  localStorage.clear()
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('Finsoft detail pages', () => {
  it('renders a purchase invoice detail page', () => {
    renderAt('/purchases/PUR-2026-0184')
    expect(screen.getByText('Purchase PUR-2026-0184')).toBeInTheDocument()
    expect(screen.getByText('Getz Pharma')).toBeInTheDocument()
    expect(screen.getByText('Ledger impact')).toBeInTheDocument()
  })

  it('renders a sales invoice detail with ledger impact', () => {
    renderAt('/sales/INV-26814')
    expect(screen.getByText('Invoice INV-26814')).toBeInTheDocument()
    expect(screen.getByText('Shifa Medical Centre')).toBeInTheDocument()
    expect(screen.getByText('Sales Revenue')).toBeInTheDocument()
  })

  it('renders a product detail page with batch ledger', () => {
    renderAt('/products/MED-1002')
    expect(screen.getByText('Augmentin 625mg')).toBeInTheDocument()
    expect(screen.getByText('Co-amoxiclav')).toBeInTheDocument()
    expect(screen.getByText('Batch ledger')).toBeInTheDocument()
    expect(screen.getAllByText(/AU-6(10B|14A)/).length).toBeGreaterThan(0)
  })

  it('renders the movement ledger from store data', () => {
    renderAt('/inventory/movements/history')
    expect(screen.getByText('Movement ledger')).toBeInTheDocument()
    expect(screen.getByText('PUR-2026-0184')).toBeInTheDocument()
  })

  it('shows a friendly not-found state for unknown records', () => {
    renderAt('/sales/INV-99999')
    expect(screen.getByText('Record not found')).toBeInTheDocument()
  })

  it('enforces role guards on detail routes', () => {
    localStorage.setItem('finsoft-role', 'Salesman')
    render(
      <MemoryRouter initialEntries={['/finance/accounts/BNK-001']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByText('Access restricted')).toBeInTheDocument()
  })

  it('navigates from the purchase register to the detail page', () => {
    renderAt('/purchasing')
    fireEvent.click(screen.getByRole('button', { name: /view pur-2026-0184/i }))
    expect(screen.getByText('Purchase PUR-2026-0184')).toBeInTheDocument()
  })

  // "renders the four-level chart of accounts hierarchy" (/accounts) and "renders the
  // voucher register with posted entries" (/vouchers) were removed here — M2-S wired both
  // routes to the real API (GET /api/accounts, GET /api/journals), so they no longer render
  // synchronously from mock data and this harness does not stub `fetch`. Their states are
  // covered by chart-of-accounts.test.tsx and voucher-register.test.tsx instead, which mock
  // `fetch` directly (matching trial-balance.test.tsx's approach) rather than rendering
  // through the full App+router harness.

  it('renders every module and child in the sidebar', () => {
    renderAt('/dashboard')
    for (const grp of nav)
      for (const it of grp.items) {
        expect(screen.getAllByText(it.label).length).toBeGreaterThan(0)
        for (const c of it.children ?? [])
          expect(screen.getAllByText(c.label).length).toBeGreaterThan(0)
      }
    // One getAllByText per nav entry over the whole rendered shell: the nav has grown to
    // the point where this legitimately takes 5-8 s under load. Same assertions, longer budget.
  }, 20_000)

  // The voucher-register filter/accordion tests, the voucher-detail test and the two
  // new-voucher-form tests were removed here — M2-S wired /vouchers, /vouchers/:id and
  // /vouchers/new to the real journals API (GET/POST /api/journals, POST /.../reverse), so
  // none of them render synchronously from mock data any more, and the mock's own affordances
  // (multiple voucher types, Save Draft) no longer exist on these screens (journal-voucher.md
  // §1: single-step post, JV only). Covered instead by voucher-register.test.tsx,
  // voucher-detail.test.tsx and voucher-new.test.tsx.

  // "renders customers directory from master accounts" and "creates a customer through the
  // wizard and opens its detail page" were removed here — M4-W wired /customers to the real
  // customers API (GET/POST /api/customers, per PartyList's own comments in parties.tsx), so
  // it no longer renders synchronously from `data.masters` and this harness does not stub
  // `fetch`. Covered instead by customers.test.tsx and customer-detail.test.tsx, which mock
  // `fetch` directly (matching trial-balance.test.tsx's approach).

  it('renders vendors directory from supplier masters', () => {
    renderAt('/vendors')
    expect(screen.getByRole('heading', { name: 'Vendors' })).toBeInTheDocument()
    expect(screen.getAllByText('Getz Pharma').length).toBeGreaterThan(0)
  })

  it('opens the vendor detail page from the vendor list', () => {
    renderAt('/vendors')
    fireEvent.click(screen.getByRole('button', { name: 'Getz Pharma' }))
    expect(screen.getByRole('heading', { name: 'Getz Pharma' })).toBeInTheDocument()
    expect(screen.getByText('Vendor Information')).toBeInTheDocument()
    expect(screen.getByText('Aging Summary')).toBeInTheDocument()
  })

  it('renders field sales', () => {
    renderAt('/field-sales')
    expect(screen.getByText('Representative performance')).toBeInTheDocument()
  })
  // The period-close assertion here was removed — M2-S wired /period-close to the real
  // periods API (GET/POST /api/periods/...), which no longer renders a checklist
  // (periods.md §7: no close checklist exists in M2). Covered by period-close.test.tsx.

  it('renders accounts receivable from credit sales', () => {
    renderAt('/receivables')
    expect(screen.getByText('Accounts receivable')).toBeInTheDocument()
    expect(screen.getAllByText('Shifa Medical Centre').length).toBeGreaterThan(0)
  })

  it('renders accounts payable from posted purchases', () => {
    renderAt('/payables')
    expect(screen.getByText('Accounts payable')).toBeInTheDocument()
    expect(screen.getAllByText('GlaxoSmithKline').length).toBeGreaterThan(0)
  })

  it('shows every sidebar group header', () => {
    renderAt('/dashboard')
    for (const grp of nav) {
      if (!grp.group) continue
      expect(screen.getAllByText(grp.group).length).toBeGreaterThan(0)
    }
  })

  it('runs a live report from store data', () => {
    renderAt('/reports/sales-register')
    expect(screen.getAllByText('Sales register').length).toBeGreaterThan(0)
    expect(screen.getByText('INV-26814')).toBeInTheDocument()
  })

  it('renders the report studio with sources and columns', () => {
    renderAt('/reports/studio')
    expect(screen.getByText('Report studio')).toBeInTheDocument()
    expect(screen.getAllByText('1 · Data source').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Customer').length).toBeGreaterThan(0)
  })

  it('renders the income statement from the journal ledger', () => {
    renderAt('/reports/profit-loss')
    expect(screen.getAllByText('Income statement').length).toBeGreaterThan(0)
    expect(screen.getByText('Sales revenue')).toBeInTheDocument()
    expect(screen.getByText('Net profit for the period')).toBeInTheDocument()
    expect(screen.getAllByText('Rs 3,220,930').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Rs 300,671').length).toBeGreaterThan(0)
  })

  it('reports centre features live financial statement summaries', () => {
    renderAt('/reports')
    expect(screen.getAllByText('Income statement').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Balance sheet').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Trial balance').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Rs 3,220,930').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Rs 7,060,671').length).toBeGreaterThan(0)
  })

  it('renders the balance sheet with assets tying to liabilities + net worth', () => {
    renderAt('/reports/balance-sheet')
    expect(screen.getAllByText('ASSETS').length).toBeGreaterThan(0)
    expect(screen.getAllByText('NET WORTH').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Rs 7,060,671').length).toBeGreaterThanOrEqual(2)
  })

  it('renders a balanced trial balance across the full ledger', () => {
    renderAt('/reports/trial-balance')
    expect(screen.getAllByText('Total').length).toBeGreaterThan(0)
    expect(screen.getByText(/trial balance is balanced/)).toBeInTheDocument()
  })

  it('renders payments & receipts with open invoice allocation', () => {
    renderAt('/payments')
    expect(screen.getByText('Payments & receipts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /new receipt/i }))
    expect(screen.getByRole('dialog', { name: /new receipt/i })).toBeInTheDocument()
    expect(screen.getByText(/Allocate against open documents/)).toBeInTheDocument()
  })

  it('renders purchase orders register', () => {
    renderAt('/po')
    expect(screen.getByRole('heading', { name: 'Purchase Orders', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new purchase order/i })).toBeInTheDocument()
    expect(screen.getAllByText('PO-00048').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Pending \(/).length).toBeGreaterThan(0)
  })

  // "blocks deletion of an account that has posted transactions" was removed here — M2-S
  // wired /accounts to the real, read-only accounts API (GET /api/accounts); there is no
  // delete affordance any more (coa-standard.md §5). Covered by chart-of-accounts.test.tsx.
  it('opens the add-master modal from the masters page', () => {
    renderAt('/masters?new=vendor')
    expect(screen.getByRole('dialog', { name: 'Create master record' })).toBeInTheDocument()
    expect(screen.getAllByText('Supplier').length).toBeGreaterThan(0)
  })
})
