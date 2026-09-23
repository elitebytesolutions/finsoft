'use client'
import type { AppData } from '@/mocks/api'
import type { ColDef } from '@/mocks/api'

const money = (n: number) => `Rs ${n.toLocaleString('en-PK')}`
const m = /[^\d]/g
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// accepts both display dates ('30 Aug 2026') and ISO inputs ('2026-08-30')
const tMs = (s: string): number => {
  if (!s) return NaN
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3])
  const [a, mon, y] = s.split(' ')
  return Date.UTC(Number(y ?? 2026), Math.max(0, MONTHS.indexOf(mon)), Number(a))
}
const inRange = (d: string, from?: string, to?: string) => {
  const dm = tMs(d)
  if (!dm || Number.isNaN(dm)) return true
  if (from && dm < tMs(from)) return false
  if (to && dm > tMs(to)) return false
  return true
}

// ---- Chart classification (the accounts the ledger actually posts to) ----
const ASSETS = [
  'Cash in Hand',
  'Meezan Bank — 8721',
  'HBL — 2294',
  'Accounts Receivable',
  'Inventory',
]
const LIABS = ['Accounts Payable']
const EQUITY = ['Reserves & Surplus']
const EXPENSES = [
  'Salaries Expense',
  'Rent Expense',
  'Electricity Expense',
  'Repair & Maintenance',
  'Sales Commission',
  'Advertisement Expense',
  'Bank Charges',
]
const REV = 'Sales Revenue'
const COGS = 'Cost of Goods Sold'
const isBsAccount = (n: string) => ASSETS.includes(n) || LIABS.includes(n) || EQUITY.includes(n)

export const sourceMeta: Record<string, ColDef[]> = {
  sales: [
    { key: 'id', label: 'Invoice' },
    { key: 'date', label: 'Date' },
    { key: 'customer', label: 'Customer' },
    { key: 'mode', label: 'Mode' },
    { key: 'product', label: 'Product' },
    { key: 'qty', label: 'Qty' },
    { key: 'amount', label: 'Amount' },
    { key: 'status', label: 'Status' },
  ],
  purchases: [
    { key: 'id', label: 'Purchase' },
    { key: 'date', label: 'Date' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'product', label: 'Product' },
    { key: 'qty', label: 'Qty' },
    { key: 'amount', label: 'Amount' },
    { key: 'status', label: 'Status' },
  ],
  stock: [
    { key: 'product', label: 'Product' },
    { key: 'batches', label: 'Batches' },
    { key: 'stock', label: 'Packs' },
    { key: 'value', label: 'Value' },
    { key: 'status', label: 'Health' },
  ],
  movements: [
    { key: 'ref', label: 'Reference' },
    { key: 'date', label: 'Date' },
    { key: 'product', label: 'Product' },
    { key: 'type', label: 'Type' },
    { key: 'qty', label: 'Qty' },
  ],
  ledger: [
    { key: 'date', label: 'Date' },
    { key: 'id', label: 'Journal' },
    { key: 'account', label: 'Account' },
    { key: 'dr', label: 'Debit' },
    { key: 'cr', label: 'Credit' },
  ],
  parties: [
    { key: 'code', label: 'Code' },
    { key: 'name', label: 'Party' },
    { key: 'type', label: 'Type' },
    { key: 'city', label: 'City' },
    { key: 'balance', label: 'Balance' },
  ],
  employees: [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Employee' },
    { key: 'designation', label: 'Designation' },
    { key: 'branch', label: 'Branch' },
    { key: 'salary', label: 'Gross' },
    { key: 'status', label: 'Today' },
  ],
  payments: [
    { key: 'id', label: 'Voucher' },
    { key: 'date', label: 'Date' },
    { key: 'kind', label: 'Kind' },
    { key: 'party', label: 'Party' },
    { key: 'account', label: 'Account' },
    { key: 'total', label: 'Total' },
    { key: 'wtax', label: 'WHT' },
    { key: 'net', label: 'Net' },
  ],
  pos: [
    { key: 'id', label: 'PO' },
    { key: 'date', label: 'Date' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'lines', label: 'Lines' },
    { key: 'amount', label: 'Amount' },
    { key: 'status', label: 'Status' },
    { key: 'expected', label: 'Expected' },
  ],
  expiry: [
    { key: 'window', label: 'Window' },
    { key: 'count', label: 'Batches' },
    { key: 'units', label: 'Units' },
    { key: 'value', label: 'Value at risk' },
  ],
  trial: [
    { key: 'account', label: 'Account' },
    { key: 'debit', label: 'Debit' },
    { key: 'credit', label: 'Credit' },
  ],
  pnl: [
    { key: 'heading', label: 'Heading' },
    { key: 'value', label: 'Amount' },
  ],
  bs: [
    { key: 'heading', label: 'Heading' },
    { key: 'value', label: 'Amount' },
  ],
}

type Rows = Record<string, string>[]
type Bal = { dr: Record<string, number>; cr: Record<string, number> }
const netsOf = (list: { debit: string; credit: string; amount: number }[]): Bal =>
  list.reduce<Bal>(
    (a, j) => {
      if (j.debit) a.dr[j.debit] = (a.dr[j.debit] || 0) + j.amount
      if (j.credit) a.cr[j.credit] = (a.cr[j.credit] || 0) + j.amount
      return a
    },
    { dr: {}, cr: {} },
  )
const netAmt = (b: Bal, name: string) => Math.max(0, (b.dr[name] || 0) - (b.cr[name] || 0))
const sec = (heading: string): Record<string, string> =>
  ({ heading, value: '', _sec: '1' }) as unknown as Record<string, string>
const line = (heading: string, value: string): Record<string, string> => ({ heading, value })
const bold = (heading: string, value: string): Record<string, string> =>
  ({ heading, value, _b: '1' }) as unknown as Record<string, string>
const total = (heading: string, value: string): Record<string, string> =>
  ({ heading, value, _t: '1' }) as unknown as Record<string, string>

function compute(data: AppData, source: string, from?: string, to?: string): Rows {
  const J = data.journals
  switch (source) {
    case 'sales':
      return data.sales
        .filter((s) => inRange(s.date, from, to))
        .map((s) => ({
          id: s.id,
          date: s.date,
          customer: s.customer,
          mode: s.mode,
          product: s.product,
          qty: String(s.qty),
          amount: money(s.amount),
          status: s.status,
        }))
    case 'purchases':
      return data.purchases
        .filter((p) => inRange(p.date, from, to))
        .map((p) => ({
          id: p.id,
          date: p.date,
          supplier: p.supplier,
          product: p.product,
          qty: String(p.qty),
          amount: money(p.amount),
          status: p.status,
        }))
    case 'stock':
      return data.products.map((p) => ({
        product: p.name,
        batches: String(p.batches.length),
        stock: String(p.stock),
        value: money(p.batches.reduce((a, b) => a + b.stock * b.cost, 0)),
        status: p.stock <= p.reorder ? 'Reorder' : 'Healthy',
      }))
    case 'movements':
      return data.movements
        .filter((mv) => inRange(mv.date, from, to))
        .map((mv) => ({
          ref: mv.reference,
          date: mv.date,
          product: mv.product,
          type: mv.type,
          qty: (mv.qty > 0 ? '+' : '') + String(mv.qty),
        }))
    case 'ledger': {
      const list = J.filter((j) => inRange(j.date, from, to))
      const rows: Rows = []
      list.forEach((j) => {
        if (j.debit)
          rows.push({ date: j.date, id: j.id, account: j.debit, dr: money(j.amount), cr: '—' })
        if (j.credit)
          rows.push({ date: j.date, id: j.id, account: j.credit, dr: '—', cr: money(j.amount) })
      })
      return rows
    }
    case 'parties':
      return data.masters
        .filter((m) => !m.level)
        .map((m) => ({
          code: m.code,
          name: m.name,
          type: m.type,
          city: m.city,
          balance: m.balance ? money(m.balance) : '—',
        }))
    case 'employees':
      return data.employees.map((e) => ({
        id: e[0],
        name: e[1],
        designation: e[2],
        branch: e[3],
        salary: e[4],
        status: e[5],
      }))
    case 'payments':
      return data.payments
        .filter((p) => inRange(p.date, from, to))
        .map((p) => ({
          id: p.id,
          date: p.date,
          kind: p.kind,
          party: p.party,
          account: p.account,
          total: money(p.total),
          wtax: p.wtax ? money(p.wtax) : '—',
          net: money(p.net),
        }))
    case 'pos':
      return data.pos
        .filter((po) => inRange(po.date, from, to))
        .map((po) => ({
          id: po.id,
          date: po.date,
          supplier: po.supplier,
          lines: String(po.lines.length),
          amount: money(po.amount),
          status: po.status,
          expected: po.expected,
        }))
    case 'expiry': {
      const buckets = [
        ['Expired', -1, 0],
        ['0–90 days', 0, 90],
        ['91–180 days', 91, 180],
        ['Beyond 180 days', 181, Infinity],
      ]
      const rows: Rows = []
      const today = Date.UTC(2026, 7, 30)
      for (const [label, lo, hi] of buckets) {
        let units = 0,
          value = 0,
          count = 0
        for (const p of data.products)
          for (const b of p.batches) {
            const d = tMs(b.expiry)
            const days = (d - today) / 86400000
            if (
              (lo as number) === -1 ? days < 0 : days >= (lo as number) && days <= (hi as number)
            ) {
              count++
              units += b.stock
              value += b.stock * b.cost
            }
          }
        rows.push({
          window: label as string,
          count: String(count),
          units: String(units),
          value: money(value),
        })
      }
      return rows
    }
    case 'trial': {
      const list = to ? J.filter((j) => inRange(j.date, undefined, to)) : J
      const b = netsOf(list)
      const names = [...new Set([...Object.keys(b.dr), ...Object.keys(b.cr)])].sort()
      const rows: Rows = names.map((n) => ({
        account: n,
        debit: b.dr[n] ? money(b.dr[n]) : '—',
        credit: b.cr[n] ? money(b.cr[n]) : '—',
      }))
      const drTot = Object.values(b.dr).reduce((a, c) => a + c, 0)
      const crTot = Object.values(b.cr).reduce((a, c) => a + c, 0)
      rows.push({
        account: 'Total',
        debit: money(drTot),
        credit: money(crTot),
        _t: '1',
      } as unknown as Record<string, string>)
      return rows
    }
    case 'pnl': {
      const list = J.filter((j) => inRange(j.date, from, to))
      const b = netsOf(list)
      const revenue = (b.cr[REV] || 0) - (b.dr[REV] || 0)
      const cogs = (b.dr[COGS] || 0) - (b.cr[COGS] || 0)
      const otherIncome = Object.keys(b.cr)
        .filter(
          (n) =>
            !isBsAccount(n) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n) &&
            (b.cr[n] || 0) > (b.dr[n] || 0),
        )
        .reduce((a, n) => a + ((b.cr[n] || 0) - (b.dr[n] || 0)), 0)
      const otherExpense = Object.keys(b.dr)
        .filter(
          (n) =>
            !isBsAccount(n) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n) &&
            (b.dr[n] || 0) > (b.cr[n] || 0),
        )
        .reduce((a, n) => a + ((b.dr[n] || 0) - (b.cr[n] || 0)), 0)
      const expLines = EXPENSES.map((n) => ({ n, v: (b.dr[n] || 0) - (b.cr[n] || 0) })).filter(
        (x) => x.v > 0,
      )
      const opex = expLines.reduce((a, x) => a + x.v, 0) + otherExpense
      const rows: Rows = []
      rows.push(bold('Sales revenue', money(revenue)))
      if (otherIncome) rows.push(line('  Other income', money(otherIncome)))
      rows.push(line('Less: cost of goods sold', `(${money(cogs)})`))
      rows.push(bold('Gross profit', money(revenue + otherIncome - cogs)))
      expLines.forEach((x) => rows.push(line(`  ${x.n}`, `(${money(x.v)})`)))
      if (otherExpense) rows.push(line('  Other expenses', `(${money(otherExpense)})`))
      rows.push(line('Operating expenses', `(${money(opex)})`))
      rows.push(bold('Net profit for the period', money(revenue + otherIncome - cogs - opex)))
      return rows
    }
    case 'bs': {
      const list = to ? J.filter((j) => inRange(j.date, undefined, to)) : J
      const b = netsOf(list)
      const rows: Rows = []
      rows.push(sec('ASSETS'))
      const assetNames = ASSETS.map((n) => ({ n, v: netAmt(b, n) })).filter((x) => x.v > 0)
      const otherAssets = Object.keys(b.dr)
        .filter(
          (n) =>
            !ASSETS.includes(n) &&
            !isBsAccount(n) &&
            (b.dr[n] || 0) > (b.cr[n] || 0) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n),
        )
        .map((n) => ({ n, v: (b.dr[n] || 0) - (b.cr[n] || 0) }))
      ;[...assetNames, ...otherAssets].forEach((x) => rows.push(line(x.n, money(x.v))))
      const assets =
        assetNames.reduce((a, x) => a + x.v, 0) + otherAssets.reduce((a, x) => a + x.v, 0)
      rows.push(total('Total assets', money(assets)))
      rows.push(sec('LIABILITIES'))
      const liabNames = LIABS.map((n) => ({
        n,
        v: Math.max(0, (b.cr[n] || 0) - (b.dr[n] || 0)),
      })).filter((x) => x.v > 0)
      const otherLiab = Object.keys(b.cr)
        .filter(
          (n) =>
            !LIABS.includes(n) &&
            !isBsAccount(n) &&
            (b.cr[n] || 0) > (b.dr[n] || 0) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n),
        )
        .map((n) => ({ n, v: (b.cr[n] || 0) - (b.dr[n] || 0) }))
      ;[...liabNames, ...otherLiab].forEach((x) => rows.push(line(x.n, money(x.v))))
      const liabilities =
        liabNames.reduce((a, x) => a + x.v, 0) + otherLiab.reduce((a, x) => a + x.v, 0)
      rows.push(total('Total liabilities', money(liabilities)))
      rows.push(sec('NET WORTH'))
      const pnlB = netsOf(J.filter((j) => inRange(j.date, undefined, to)))
      const revenue = (pnlB.cr[REV] || 0) - (pnlB.dr[REV] || 0)
      const cogs = (pnlB.dr[COGS] || 0) - (pnlB.cr[COGS] || 0)
      const expTotal = [
        ...EXPENSES,
        ...Object.keys(pnlB.dr).filter(
          (n) =>
            !isBsAccount(n) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n) &&
            (pnlB.dr[n] || 0) > (pnlB.cr[n] || 0),
        ),
      ].reduce((a, n) => a + ((pnlB.dr[n] || 0) - (pnlB.cr[n] || 0)), 0)
      const otherIncomeYtd = Object.keys(pnlB.cr)
        .filter(
          (n) =>
            !isBsAccount(n) &&
            n !== REV &&
            n !== COGS &&
            !EXPENSES.includes(n) &&
            (pnlB.cr[n] || 0) > (pnlB.dr[n] || 0),
        )
        .reduce((a, n) => a + ((pnlB.cr[n] || 0) - (pnlB.dr[n] || 0)), 0)
      const netWorthYtd = revenue + otherIncomeYtd - cogs - expTotal
      const equity = Math.max(
        0,
        (b.cr['Reserves & Surplus'] || 0) - (b.dr['Reserves & Surplus'] || 0),
      )
      rows.push(line('Reserves & surplus', money(equity)))
      rows.push(
        line(
          'Surplus for the period',
          netWorthYtd >= 0 ? money(netWorthYtd) : `(${money(Math.abs(netWorthYtd))})`,
        ),
      )
      rows.push(bold('Net worth', money(equity + netWorthYtd)))
      rows.push(total('Total liabilities & net worth', money(assets)))
      return rows
    }
    default:
      return []
  }
}
export function runReport(
  data: AppData,
  source: string,
  cols: ColDef[],
  from?: string,
  to?: string,
): { cols: ColDef[]; rows: Rows } {
  const all = compute(data, source, from, to)
  const meta = sourceMeta[source] ?? cols
  const use = cols.length ? cols : meta
  return {
    cols: use,
    rows: all.map((r) => {
      const o: Record<string, string> = {}
      use.forEach((c) => {
        o[c.key] = r[c.key] ?? '—'
      })
      if (r._t) o._t = r._t
      if (r._b) o._b = r._b
      if (r._sec) o._sec = r._sec
      return o
    }),
  }
}
export function exportCsv(cols: ColDef[], rows: Rows) {
  const head = cols.map((c) => c.label).join(',')
  const body = rows
    .map((r) => cols.map((c) => `"${(r[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob([head + '\n' + body], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'report.csv'
  a.click()
}
export const numericOf = (s: string | number) => Number(String(s).replace(m, '')) || 0
const pick = (rows: Rows, label: string) => rows.find((r) => r.heading === label)?.value

/** Live headline figures used by the Reports centre financial band & statement pages. */
export function financialSummary(data: AppData, from = '2026-08-01', to = '2026-08-30') {
  const pnl = compute(data, 'pnl', from, to)
  const bs = compute(data, 'bs', from, to)
  const tb = compute(data, 'trial', from, to)
  const n = (s?: string) => numericOf(s || '')
  const assets = n(pick(bs, 'Total assets')),
    liabilities = n(pick(bs, 'Total liabilities'))
  const totalRow = tb.find((r) => r._t)
  return {
    revenue: n(pick(pnl, 'Sales revenue')),
    gross: n(pick(pnl, 'Gross profit')),
    expenses: n(pick(pnl, 'Operating expenses')),
    net: n(pick(pnl, 'Net profit for the period')),
    assets,
    liabilities,
    netWorth: Math.max(0, assets - liabilities),
    trialAccounts: tb.filter((r) => !r._t).length,
    totalDebit: n(totalRow?.debit),
    totalCredit: n(totalRow?.credit),
    entries: data.journals.length,
  }
}
