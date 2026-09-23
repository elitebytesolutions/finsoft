'use client'
import type { Voucher } from '@/mocks/api'
import type { AppData } from '@/mocks/api'

function TradeVouchers(data: AppData): Voucher[] {
  const existing = new Set(data.vouchers.map((v) => v.id))
  const sales: Voucher[] = data.sales
    .filter((s) => !existing.has(`SINV-${s.id.slice(4)}`) && !existing.has(s.id))
    .map((s) => ({
      id: s.id,
      date: s.date,
      type: 'SINV',
      narration: `Sale — ${s.customer} · ${s.product}`,
      reference: s.id,
      status: s.status === 'Credit' ? 'Posted' : 'Posted',
      posting: 'Posted',
      createdBy: 'Sana Javed',
      branch: 'Lahore Main',
      department: 'Counter',
      lines: [
        {
          debit: s.status === 'Credit' ? 'Accounts Receivable' : 'Cash in Hand',
          credit: 'Sales Revenue',
          amount: s.amount,
          remark: `${s.qty} × ${s.product}`,
        },
      ],
    }))
  const buys: Voucher[] = data.purchases
    .filter((p) => !existing.has(p.id))
    .map((p) => ({
      id: p.id,
      date: p.date,
      type: 'PINV',
      narration: `GRN — ${p.product} from ${p.supplier}`,
      reference: p.id,
      status: p.status === 'Posted' ? 'Posted' : 'Draft',
      posting: p.status === 'Posted' ? 'Posted' : 'Unposted',
      createdBy: 'Sana Javed',
      branch: 'Lahore Main',
      department: 'Stores',
      lines: [
        {
          debit: 'Inventory',
          credit: 'Accounts Payable',
          amount: p.amount,
          remark: `${p.qty} packs`,
        },
      ],
    }))
  return [...data.vouchers, ...sales, ...buys]
}
const uniq = (vs: Voucher[]) => vs.filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
export const allVouchers = (data: AppData) => uniq(TradeVouchers(data))
