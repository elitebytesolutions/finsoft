import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from './harness'
import { afterEach, describe, expect, it } from 'vitest'
import App from './harness'

afterEach(cleanup)

function renderAt(path:string){
 localStorage.clear()
 return render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>)
}

describe('inventory operation screens',()=>{
 it.each([
  ['/inventory','Inventory control'],
  ['/inventory/issue','Stock issue & adjustment'],
  ['/inventory/transfer','Stock transfer'],
  ['/inventory/count','Physical count'],
  ['/inventory/as-of','Stock as on date'],
  ['/inventory/batches','Batch & expiry control'],
 ])('renders %s as a dedicated screen',(path,title)=>{
  renderAt(path)
  expect(screen.getByRole('heading',{name:title,level:1})).toBeInTheDocument()
  expect(screen.getByLabelText('Inventory operations')).toBeInTheDocument()
 })

 it('renders the manual stock entry page and posts lines',()=>{
  renderAt('/inventory/stock-in')
  expect(screen.getByRole('heading',{name:'Manual Stock In / Stock Out',level:1})).toBeInTheDocument()
  expect(screen.getByRole('tab',{name:/manual stock in/i})).toHaveAttribute('aria-selected','true')
  expect(screen.getByText('Ready to post')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Quantity Panadol 500mg'),{target:{value:'12'}})
  fireEvent.click(screen.getByRole('button',{name:/save & post/i}))
  expect(screen.getByText('Stock operation posted')).toBeInTheDocument()
  expect(screen.getByText(/reflected in live inventory/i)).toBeInTheDocument()
 })

 it('uses the stock in and stock out workflow for Stock Movements',()=>{
  renderAt('/inventory/movements')
  expect(screen.getByRole('heading',{name:'Manual Stock In / Stock Out',level:1})).toBeInTheDocument()
  expect(screen.getByRole('tab',{name:/manual stock in/i})).toHaveAttribute('aria-selected','true')
  fireEvent.click(screen.getByRole('tab',{name:/manual stock out/i}))
  expect(screen.getByRole('tab',{name:/manual stock out/i})).toHaveAttribute('aria-selected','true')
  fireEvent.click(screen.getByRole('button',{name:/view all/i}))
  expect(screen.getByText('Movement ledger')).toBeInTheDocument()
 })

 it('blocks stock out that exceeds batch balance',()=>{
  renderAt('/inventory/stock-in')
  fireEvent.click(screen.getByRole('tab',{name:/manual stock out/i}))
  fireEvent.change(screen.getByLabelText('Quantity Panadol 500mg'),{target:{value:'99999'}})
  expect(screen.getByText('Needs attention')).toBeInTheDocument()
  expect(screen.getByRole('button',{name:/save & post/i})).toBeDisabled()
 })

 it('shows batch-level variance controls on the physical count',()=>{
  renderAt('/inventory/count')
  const input=screen.getByLabelText('Physical count Panadol 500mg PD-2408')
  fireEvent.change(input,{target:{value:'120'}})
  expect(screen.getAllByText('-4').length).toBeGreaterThan(0)
  expect(screen.getByRole('button',{name:/post count/i})).toBeEnabled()
 })
 it('renders the salesman attendance page and switches the detail panel',()=>{
  renderAt('/hr/attendance')
  expect(screen.getByRole('heading',{name:'Salesman Attendance',level:1})).toBeInTheDocument()
  expect(screen.getByRole('tab',{name:/all salesmen \(24\)/i})).toHaveAttribute('aria-selected','true')
  expect(screen.getByRole('heading',{name:/ali hassan/i,level:2})).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab',{name:/absent \(4\)/i}))
  fireEvent.click(screen.getAllByRole('button',{name:/^view$/i})[0])
  expect(screen.getByRole('heading',{name:/mubeen khan/i,level:2})).toBeInTheDocument()
  expect(screen.getByText('No activity recorded today.')).toBeInTheDocument()
 })
 it('opens the attendance entry page from Add Manual Entry and saves a note',()=>{
  renderAt('/hr/attendance')
  fireEvent.click(screen.getByRole('button',{name:/add manual entry/i}))
  expect(screen.getByRole('heading',{name:'Attendance',level:1})).toBeInTheDocument()
  expect(screen.getByText('Currently Checked In')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Note'),{target:{value:'Visited HealthPlus'}})
  fireEvent.click(screen.getByRole('button',{name:/save note/i}))
  expect(screen.getByText('Visited HealthPlus')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/start visit/i}))
  expect(screen.getByText((_,el)=>el?.tagName==='P'&&/4 of 8 stops completed/.test(el.textContent??''))).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/check out/i}))
  expect(screen.getAllByText('Checked Out').length).toBeGreaterThan(0)
 })
 it('renders the purchase voucher page, edits a line and posts it',()=>{
  renderAt('/purchasing/voucher')
  expect(screen.getByRole('heading',{name:'Create Purchase Voucher',level:1})).toBeInTheDocument()
  expect(screen.getByText('Total Items: 4')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('psQty Paracetamol 500mg Tablet'),{target:{value:'20'}})
  expect(screen.getAllByText('240.00').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button',{name:/remove row 4/i}))
  expect(screen.getByText('Total Items: 3')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/save & post/i}))
  expect(screen.getByText('POSTED')).toBeInTheDocument()
  expect(screen.getByRole('button',{name:/save & post/i})).toBeDisabled()
 })
 it('renders the bank book with running balances and reconciles',()=>{
  renderAt('/bank-book')
  expect(screen.getByRole('heading',{name:'Bank Book',level:1})).toBeInTheDocument()
  expect(screen.getAllByText('Rs 1,590,150').length).toBeGreaterThan(0)
  expect(screen.getByText('70%')).toBeInTheDocument()
  expect(screen.getByText('Pending Cheques').previousSibling).toHaveTextContent('2')
  fireEvent.change(screen.getByLabelText('Search transactions'),{target:{value:'cheque'}})
  expect(screen.getAllByText('Cheque Issued').length).toBe(2)
  expect(screen.queryByText('Cash Deposit')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/reconcile with statement/i}))
  expect(screen.getByText('100%')).toBeInTheDocument()
 })
})
