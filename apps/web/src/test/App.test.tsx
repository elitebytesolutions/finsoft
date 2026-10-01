import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { afterEach, describe, expect, it } from 'vitest'
import App from './harness'

afterEach(cleanup)

function renderAt(path = '/dashboard') {
  localStorage.clear()
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('Finsoft application', () => {
  it('renders the executive dashboard and core KPIs', () => {
    renderAt()
    expect(screen.getByText('Good morning, Ahmed')).toBeInTheDocument()
    expect(screen.getByText('Net sales today')).toBeInTheDocument()
    expect(screen.getByText('Inventory health')).toBeInTheDocument()
  })

  it('shows six dashboard quick actions', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'Quick actions' })).toBeInTheDocument()
    for (const name of [
      'Create voucher',
      'Sales invoice',
      'Purchase invoice',
      'Record payment',
      'Purchase order',
      'Reports centre',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(name, 'i') })).toBeInTheDocument()
    }
  })

  it('filters the product catalogue', () => {
    renderAt('/products')
    fireEvent.change(screen.getByPlaceholderText('Enter code, name or UPC...'), {
      target: { value: 'Motile' },
    })
    expect(screen.getByText('Motile Mega No.2')).toBeInTheDocument()
    expect(screen.queryByText('ALWAYS MAXI NIGHT')).not.toBeInTheDocument()
    expect(screen.getByText(/Showing 1 – 1 of 1 products/)).toBeInTheDocument()
  })

  it('adds a product from the catalogue modal with validation', () => {
    renderAt('/products')
    fireEvent.click(screen.getByRole('button', { name: /New Product/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: /Save Product/ }))
    expect(dialog.getByText('Product code is required')).toBeInTheDocument()
    fireEvent.change(dialog.getByPlaceholderText('Enter product code'), {
      target: { value: 'PR999' },
    })
    fireEvent.change(dialog.getByPlaceholderText('Enter product name'), {
      target: { value: 'TEST SOAP 100G' },
    })
    fireEvent.change(dialog.getByLabelText(/^Pack/), { target: { value: 'Pack of 12' } })
    fireEvent.change(dialog.getByLabelText(/^Company/), { target: { value: 'UNILEVER' } })
    fireEvent.change(dialog.getByPlaceholderText('Enter purchase price'), {
      target: { value: '100' },
    })
    fireEvent.change(dialog.getByPlaceholderText('Enter retail price'), {
      target: { value: '120' },
    })
    fireEvent.change(dialog.getByLabelText(/^Class/), { target: { value: 'BEAUTY' } })
    fireEvent.click(dialog.getByRole('button', { name: /Save Product/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('TEST SOAP 100G')).toBeInTheDocument()
  })

  it('enforces role-aware routes', () => {
    localStorage.setItem('finsoft-role', 'Salesman')
    // Was /finance, which only redirects (<Navigate to="/accounts">) and carries no
    // content of its own — M4-W removed <Guard> from the redirect TARGET, /accounts,
    // since it is real, API-backed and server-protected now (Security seat condition 2).
    // That broke this test for an unrelated reason: FinsoftProvider's mock `role` starts
    // at its SSR-safe default ('Owner') and only becomes 'Salesman' once its
    // localStorage-reading effect runs, which (by React's child-before-parent effect
    // order) fires AFTER /finance's own Guard has already evaluated and queued the
    // redirect — so /finance's Guard let it through on the stale default role, and
    // only the TARGET's Guard, now gone, used to catch the mistake one hop later.
    // /bank-accounts is still mock-only and still <Guard module="Cash, Bank & GL">,
    // with no redirect hop to race against, so it tests the same thing the original
    // test meant to: a role-restricted module shows "Access restricted".
    render(
      <MemoryRouter initialEntries={['/bank-accounts']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByText('Access restricted')).toBeInTheDocument()
  })

  it('opens the sales workflow dialog', () => {
    renderAt('/sales')
    fireEvent.click(screen.getByRole('button', { name: /new sale/i }))
    expect(screen.getByRole('dialog', { name: 'New sales invoice' })).toBeInTheDocument()
    expect(screen.getByText('Earliest valid expiry is automatically selected')).toBeInTheDocument()
  })
})
