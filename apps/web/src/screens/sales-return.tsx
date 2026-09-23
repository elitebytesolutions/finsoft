'use client'
import { useMemo, useState } from 'react'
import { ArrowLeft, FileText, Package, RefreshCw, Search, TrendingDown } from 'lucide-react'
import { usePersistentData } from '@/mocks/api'
import { Badge, Button, Kpi, PageHead, Panel, Table, Modal } from '@finsoft/ui'
import { money } from '@finsoft/ui'
import { useNavigate } from '@/lib/router'

export function SalesReturn() {
  const { data } = usePersistentData()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ sale: (typeof data.sales)[number] } | null>(null)

  const sales = useMemo(() => {
    const q = query.toLowerCase()
    return data.sales.filter(
      (s) =>
        !q ||
        s.id.toLowerCase().includes(q) ||
        s.customer.toLowerCase().includes(q) ||
        s.product.toLowerCase().includes(q),
    )
  }, [data.sales, query])

  const totalReturnValue = sales.reduce((a, s) => a + s.amount, 0)

  return (
    <>
      <PageHead
        eyebrow="Sales & Distribution / Returns"
        title="Sales returns"
        description="Process customer returns against original sales invoices. Design reference: /design/sales return page .png"
        actions={
          <>
            <Button kind="secondary" onClick={() => navigate('/sales')}>
              <ArrowLeft /> Back to sales
            </Button>
            <Button>
              <RefreshCw /> New return
            </Button>
          </>
        }
      />
      <div className="kpi-grid mini">
        <Kpi
          label="Open invoices"
          value={String(data.sales.length)}
          change="Eligible for return"
          icon={FileText}
        />
        <Kpi
          label="Potential return value"
          value={money(totalReturnValue)}
          change="Current filter"
          icon={TrendingDown}
          tone="yellow"
        />
        <Kpi label="Return items" value="0" change="This month" icon={Package} tone="teal" />
      </div>

      <Panel
        title="Sales register for returns"
        sub="Search original invoices to create a return"
        action={
          <div className="search-field" style={{ width: 320 }}>
            <Search style={{ width: 15 }} />
            <input
              placeholder="Search invoice, customer or product..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      >
        <Table
          headers={['Invoice', 'Date', 'Customer', 'Product', 'Qty', 'Total', 'Status', '']}
          rows={sales.map((s) => [
            <button className="linkable" onClick={() => navigate(`/sales/${s.id}`)}>
              {s.id}
            </button>,
            s.date,
            s.customer,
            s.product,
            s.qty,
            <b>{money(s.amount)}</b>,
            <Badge tone={s.status === 'Paid' ? 'good' : 'warn'}>{s.status}</Badge>,
            <button className="table-action" onClick={() => setOpen({ sale: s })}>
              Create return
            </button>,
          ])}
        />
      </Panel>

      {open && (
        <Modal title={`Return against ${open.sale.id}`} onClose={() => setOpen(null)} wide>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setOpen(null)
            }}
          >
            <div className="form-grid">
              <label>
                Original invoice
                <input readOnly value={open.sale.id} />
              </label>
              <label>
                Date
                <input readOnly value={open.sale.date} />
              </label>
              <label>
                Customer
                <input readOnly value={open.sale.customer} />
              </label>
              <label>
                Product
                <input readOnly value={open.sale.product} />
              </label>
              <label>
                Quantity sold
                <input readOnly value={String(open.sale.qty)} />
              </label>
              <label>
                Quantity to return
                <input
                  name="qty"
                  type="number"
                  min="1"
                  max={open.sale.qty}
                  defaultValue={1}
                  required
                />
              </label>
              <label className="span-2">
                Reason for return
                <select name="reason" defaultValue="Defective">
                  <option>Defective</option>
                  <option>Wrong item</option>
                  <option>Damaged in transit</option>
                  <option>Customer changed mind</option>
                  <option>Expiry issue</option>
                </select>
              </label>
              <label className="span-2">
                Remarks
                <input name="remarks" placeholder="Additional notes..." />
              </label>
            </div>
            <div className="summary-strip">
              <span>
                Original amount <b>{money(open.sale.amount)}</b>
              </span>
              <span>
                Unit price <b>{money(open.sale.amount / open.sale.qty)}</b>
              </span>
              <span>
                Return type <b>Credit note</b>
              </span>
            </div>
            <div className="modal-foot">
              <Button kind="secondary" type="button" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button type="submit">
                <RefreshCw /> Post return
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
