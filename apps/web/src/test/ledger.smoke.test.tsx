import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { afterEach, describe, expect, it } from 'vitest'
import App from './harness'

afterEach(cleanup)
function renderAt(path:string){
 localStorage.clear()
 return render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>)
}

describe('account ledger screens',()=>{
 it('ledgers register page renders with live ledger content',()=>{
  renderAt('/ledgers')
  expect(screen.getAllByText(/Account Ledger/).length).toBeGreaterThan(0)
  expect(screen.getAllByText('Cash in Hand').length).toBeGreaterThan(0)
 })
 it('account detail shows statement and picker changes accounts',()=>{
  renderAt('/finance/accounts/1110-01')
  expect(screen.getAllByText('Cash in Hand').length).toBeGreaterThan(0)
  expect(screen.getByText(/Balance brought forward/)).toBeInTheDocument()
  expect(screen.getByText(/Closing balance c\/f/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Select account'),{target:{value:'1120-01'}})
  expect(screen.getAllByText(/Meezan Bank/).length).toBeGreaterThan(0)
 })
 it('header account shows roll-up sub-ledger table',()=>{
  renderAt('/finance/accounts/1000')
  expect(screen.getByText('Sub-ledger roll-up')).toBeInTheDocument()
  expect(screen.getByText('Cash in Hand')).toBeInTheDocument()
 })
})
