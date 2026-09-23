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

  it('renders the four-level chart of accounts hierarchy', () => {
    renderAt('/accounts')
    expect(screen.getByRole('heading', { name: 'Chart of Accounts' })).toBeInTheDocument()
    for (const label of ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText('Postable').length).toBeGreaterThan(0)
    expect(screen.getByText('Cash in Hand')).toBeInTheDocument()
  })

  it('renders the voucher register with posted entries', () => {
    renderAt('/vouchers')
    expect(screen.getAllByText('Voucher Register').length).toBeGreaterThan(0)
    expect(screen.getAllByText('JV-2026-0409').length).toBeGreaterThan(0)
    expect(screen.getAllByText('JV-2026-0413').length).toBeGreaterThan(0)
  })

  it('renders every module and child in the sidebar', () => {
    renderAt('/dashboard')
    for (const grp of nav)
      for (const it of grp.items) {
        expect(screen.getAllByText(it.label).length).toBeGreaterThan(0)
        for (const c of it.children ?? [])
          expect(screen.getAllByText(c.label).length).toBeGreaterThan(0)
      }
  })

  it('offers voucher-type filters inside the register', () => {
    renderAt('/vouchers')
    for (const t of [
      'All Status',
      'All Voucher Types',
      'Journal Voucher',
      'Receipt Voucher',
      'Payment Voucher',
      'Contra Voucher',
    ]) {
      expect(screen.getAllByText(t).length).toBeGreaterThan(0)
    }
  })

  it('opens an accordion row to reveal accounting entries', () => {
    renderAt('/vouchers')
    fireEvent.click(screen.getByRole('button', { name: /jv-2026-0412/i }))
    expect(screen.getAllByText('Rent Expense').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Office Rent Payment').length).toBeGreaterThan(0)
  })

  it('renders a voucher detail page with entries and audit', () => {
    renderAt('/vouchers/JV-2026-0413')
    expect(screen.getAllByText('Staff Salary Payment').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Salaries Expense').length).toBeGreaterThan(0)
    expect(screen.getByText('Status & audit')).toBeInTheDocument()
  })

  it('renders the new journal voucher entry form', () => {
    renderAt('/vouchers/new')
    expect(screen.getByText('New Journal Voucher')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add line/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save & post/i })).toBeInTheDocument()
  })

  it('saves a balanced voucher from independent debit and credit rows', () => {
    renderAt('/vouchers/new')
    fireEvent.change(screen.getByLabelText('Narration'), {
      target: { value: 'Office equipment purchase' },
    })
    fireEvent.change(screen.getByLabelText('Debit line 1'), { target: { value: '25000' } })
    fireEvent.change(screen.getByLabelText('Credit line 2'), { target: { value: '25000' } })
    expect(screen.getByText('Balanced')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /save draft/i }))
    expect(screen.getAllByText('Office equipment purchase').length).toBeGreaterThan(0)
  })

  it('renders customers directory from master accounts', () => {
    renderAt('/customers')
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeInTheDocument()
    expect(screen.getAllByText('Shifa Medical Centre').length).toBeGreaterThan(0)
    expect(screen.getByText('Ahmed Traders')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'Gulberg' } })
    expect(screen.getAllByText('Shifa Medical Centre').length).toBeGreaterThan(0)
    expect(screen.queryByText('Ahmed Traders')).not.toBeInTheDocument()
  })

  it('renders vendors directory from supplier masters', () => {
    renderAt('/vendors')
    expect(screen.getByRole('heading', { name: 'Vendors' })).toBeInTheDocument()
    expect(screen.getAllByText('Getz Pharma').length).toBeGreaterThan(0)
  })

  it('creates a customer through the wizard and opens its detail page', () => {
    renderAt('/customers')
    fireEvent.click(screen.getByRole('button', { name: /New Customer/ }))
    expect(screen.getByText('Basic Information')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Ahmed Traders'), {
      target: { value: 'Zeta Traders' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: /Create Customer/ }))
    expect(screen.getByRole('heading', { name: 'Zeta Traders' })).toBeInTheDocument()
    expect(screen.getByText('Customer Snapshot')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Account Ledger' })).toBeInTheDocument()
  })

  it('opens the vendor detail page from the vendor list', () => {
    renderAt('/vendors')
    fireEvent.click(screen.getByRole('button', { name: 'Getz Pharma' }))
    expect(screen.getByRole('heading', { name: 'Getz Pharma' })).toBeInTheDocument()
    expect(screen.getByText('Vendor Information')).toBeInTheDocument()
    expect(screen.getByText('Aging Summary')).toBeInTheDocument()
  })

  it('renders field sales and period close', () => {
    renderAt('/field-sales')
    expect(screen.getByText('Representative performance')).toBeInTheDocument()
    renderAt('/period-close')
    expect(screen.getByText('Period close')).toBeInTheDocument()
    expect(screen.getByText('Pre-close checklist')).toBeInTheDocument()
  })

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

  it('blocks deletion of an account that has posted transactions', () => {
    renderAt('/accounts')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Cash in Hand' }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
    expect(screen.getByText(/Transactions have been posted/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled()
  })
  it('opens the add-master modal from the masters page', () => {
    renderAt('/masters?new=vendor')
    expect(screen.getByRole('dialog', { name: 'Create master record' })).toBeInTheDocument()
    expect(screen.getAllByText('Supplier').length).toBeGreaterThan(0)
  })
})
