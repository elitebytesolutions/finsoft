import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { afterEach, describe, expect, it } from 'vitest'
import App from './harness'

afterEach(cleanup)

function renderPayroll() {
  localStorage.clear()
  return render(
    <MemoryRouter initialEntries={['/hr/payroll']}>
      <App />
    </MemoryRouter>,
  )
}

describe('payroll management', () => {
  it('renders employee payroll and filters the register', () => {
    renderPayroll()
    expect(screen.getByRole('heading', { name: /run payroll with/i })).toBeInTheDocument()
    expect(screen.getByText('Ahmed Raza')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search payroll'), { target: { value: 'Sana' } })
    expect(screen.getByText('Sana Javed')).toBeInTheDocument()
    expect(screen.queryByText('Ahmed Raza')).not.toBeInTheDocument()
  })

  it('generates and previews payroll', () => {
    renderPayroll()
    fireEvent.click(screen.getByRole('button', { name: /generate payroll for sep 2026/i }))
    expect(screen.getByText(/has been generated successfully/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /preview payroll/i }))
    expect(screen.getByRole('dialog', { name: 'Payroll preview' })).toBeInTheDocument()
    expect(screen.getByText('Net payroll')).toBeInTheDocument()
  })
})
