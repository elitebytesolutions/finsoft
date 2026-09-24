'use client'
import { useEffect, useState } from 'react'
import {
  employees as seedEmployees,
  initialJournals,
  initialMovements,
  initialPurchases,
  initialPurchaseReturns,
  initialSales,
  masters as seedMasters,
  products as seedProducts,
  reports,
  seedCheques,
  seedVouchers,
  type BankCheque,
  type Journal,
  type Master,
  type Payment,
  type Product,
  type Purchase,
  type PurchaseOrder,
  type PurchaseReturn,
  type ReportTemplate,
  type Sale,
  type StockMovement,
  type Voucher,
  seedPurchaseOrders,
} from './data'

export type AppData = {
  products: Product[]
  purchases: Purchase[]
  purchaseReturns: PurchaseReturn[]
  sales: Sale[]
  movements: StockMovement[]
  journals: Journal[]
  vouchers: Voucher[]
  masters: Master[]
  employees: string[][]
  pos: PurchaseOrder[]
  payments: Payment[]
  templates: ReportTemplate[]
  cheques: BankCheque[]
}
const toTemplates = reports.map<ReportTemplate>((r) => ({
  id: r.slug,
  name: r.name,
  description: r.description,
  icon: r.icon,
  category: r.category,
  source: r.source,
  columns: r.columns,
  savedBy: 'System',
  builtIn: true,
}))
const seed: AppData = {
  products: seedProducts,
  purchases: initialPurchases,
  purchaseReturns: initialPurchaseReturns,
  sales: initialSales,
  movements: initialMovements,
  journals: initialJournals,
  vouchers: seedVouchers,
  masters: seedMasters,
  employees: seedEmployees,
  pos: seedPurchaseOrders,
  payments: [],
  templates: toTemplates,
  cheques: seedCheques,
}
function restore(raw: string | null): AppData {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<AppData>) : null
    if (
      !parsed ||
      !Array.isArray(parsed.products) ||
      !Array.isArray(parsed.purchases) ||
      !Array.isArray(parsed.sales)
    )
      return seed
    if (!parsed.products.every((p) => p && typeof p.name === 'string' && Array.isArray(p.batches)))
      return seed
    return {
      ...seed,
      ...parsed,
      movements: Array.isArray(parsed.movements) ? parsed.movements : [],
      journals: Array.isArray(parsed.journals) ? parsed.journals : [],
      vouchers: Array.isArray(parsed.vouchers) ? parsed.vouchers : seedVouchers,
      masters:
        Array.isArray(parsed.masters) && parsed.masters.length ? parsed.masters : seedMasters,
      employees:
        Array.isArray(parsed.employees) && parsed.employees.length
          ? parsed.employees
          : seedEmployees,
      pos: Array.isArray(parsed.pos) && parsed.pos.length ? parsed.pos : seedPurchaseOrders,
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
      templates:
        Array.isArray(parsed.templates) && parsed.templates.length ? parsed.templates : toTemplates,
      cheques:
        Array.isArray(parsed.cheques) && parsed.cheques.length ? parsed.cheques : seedCheques,
      products: parsed.products,
      sales: parsed.sales,
      purchases: parsed.purchases,
      purchaseReturns: Array.isArray(parsed.purchaseReturns)
        ? parsed.purchaseReturns
        : initialPurchaseReturns,
    } as AppData
  } catch {
    return seed
  }
}
const nextJournalId = (journals: Journal[]) => {
  const max = Math.max(0, ...journals.map((j) => parseInt(j.id.slice(-4), 10) || 0))
  return `JV-2026-${String(max + 1).padStart(4, '0')}`
}
const voucherToJournals = (v: Voucher, journals: Journal[]): Journal[] => {
  const base = nextJournalId(journals)
  return v.lines.map((ln, i) => ({
    id: i === 0 ? base : `${base}-${i + 1}`,
    date: v.date,
    description: ln.remark || v.narration,
    debit: ln.debit,
    credit: ln.credit,
    amount: ln.amount,
    reference: v.id,
  }))
}

export function usePersistentData() {
  // SSR-safe: the server renders the seed, then the browser swaps in stored state.
  // Reading localStorage in the initialiser would throw during prerender and
  // would desynchronise hydration. Visible result is identical to the prototype.
  const [data, setData] = useState<AppData>(seed)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    setData(restore(localStorage.getItem('finsoft-data-v7')))
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem('finsoft-data-v7', JSON.stringify(data))
    } catch {
      /* storage can be unavailable; current session remains usable */
    }
  }, [data, hydrated])
  const addPurchase = (purchase: Purchase) =>
    setData((prev) => ({
      ...prev,
      purchases: [purchase, ...prev.purchases],
      products: prev.products.map((p) =>
        p.name === purchase.product && purchase.status === 'Posted'
          ? (() => {
              const exists = p.batches.some((b) => b.id === purchase.batch)
              const batches = exists
                ? p.batches.map((b) =>
                    b.id === purchase.batch
                      ? {
                          ...b,
                          stock: b.stock + purchase.qty,
                          cost: purchase.unitCost,
                          expiry: purchase.expiry,
                        }
                      : b,
                  )
                : [
                    ...p.batches,
                    {
                      id: purchase.batch,
                      expiry: purchase.expiry,
                      stock: purchase.qty,
                      cost: purchase.unitCost,
                    },
                  ]
              return {
                ...p,
                batches,
                stock: batches.reduce((a, b) => a + b.stock, 0),
                cost: purchase.unitCost,
                batch: purchase.batch,
                expiry: purchase.expiry,
              }
            })()
          : p,
      ),
      movements:
        purchase.status === 'Posted'
          ? [
              {
                id: `MOV-${Date.now()}`,
                date: purchase.date,
                product: purchase.product,
                batch: purchase.batch,
                type: 'Purchase',
                qty: purchase.qty,
                reference: purchase.id,
              },
              ...prev.movements,
            ]
          : prev.movements,
      journals:
        purchase.status === 'Posted'
          ? [
              {
                id: `JV-${Date.now()}`,
                date: purchase.date,
                description: `Inventory purchase · ${purchase.product}`,
                debit: 'Inventory',
                credit: 'Accounts Payable',
                amount: purchase.amount,
                reference: purchase.id,
              },
              ...prev.journals,
            ]
          : prev.journals,
    }))
  const addSale = (sale: Sale) =>
    setData((prev) => ({
      ...prev,
      sales: [sale, ...prev.sales],
      products: prev.products.map((p) =>
        p.name === sale.product
          ? (() => {
              const batches = p.batches.map((b) =>
                b.id === sale.batch ? { ...b, stock: b.stock - sale.qty } : b,
              )
              return { ...p, batches, stock: batches.reduce((a, b) => a + b.stock, 0) }
            })()
          : p,
      ),
      movements: [
        {
          id: `MOV-${Date.now()}`,
          date: sale.date,
          product: sale.product,
          batch: sale.batch,
          type: 'Sale',
          qty: -sale.qty,
          reference: sale.id,
        },
        ...prev.movements,
      ],
      journals: [
        {
          id: `JV-${Date.now()}-R`,
          date: sale.date,
          description: `Sale · ${sale.customer}`,
          debit: sale.status === 'Paid' ? 'Cash in Hand' : 'Accounts Receivable',
          credit: 'Sales Revenue',
          amount: sale.amount,
          reference: sale.id,
        },
        {
          id: `JV-${Date.now()}-C`,
          date: sale.date,
          description: `COGS · ${sale.product}`,
          debit: 'Cost of Goods Sold',
          credit: 'Inventory',
          amount: sale.qty * sale.unitCost,
          reference: sale.id,
        },
        ...prev.journals,
      ],
    }))
  const addPurchaseReturn = (entry: PurchaseReturn) =>
    setData((prev) => {
      if (prev.purchaseReturns.some((r) => r.id === entry.id)) return prev
      if (entry.status !== 'Posted')
        return { ...prev, purchaseReturns: [entry, ...prev.purchaseReturns] }
      let products = prev.products,
        movements = prev.movements
      entry.lines.forEach((line, index) => {
        products = products.map((product) => {
          if (product.name !== line.product) return product
          const batches = product.batches.map((batch) =>
            batch.id === line.batch
              ? { ...batch, stock: Math.max(0, batch.stock - line.qty - line.bonus) }
              : batch,
          )
          return {
            ...product,
            batches,
            stock: batches.reduce((sum, batch) => sum + batch.stock, 0),
          }
        })
        movements = [
          {
            id: `MOV-PR-${Date.now()}-${index}`,
            date: entry.date,
            product: line.product,
            batch: line.batch,
            type: 'Purchase Return',
            qty: -(line.qty + line.bonus),
            reference: entry.id,
            note: entry.remarks,
            expiry: line.expiry,
            unitCost: line.rate,
          },
          ...movements,
        ]
      })
      const journal: Journal = {
        id: nextJournalId(prev.journals),
        date: entry.date,
        description: `Purchase return · ${entry.supplier}`,
        debit: entry.paymentType === 'Cash' ? 'Cash in Hand' : 'Accounts Payable',
        credit: 'Inventory',
        amount: entry.amount,
        reference: entry.id,
      }
      return {
        ...prev,
        purchaseReturns: [entry, ...prev.purchaseReturns],
        products,
        movements,
        journals: [journal, ...prev.journals],
      }
    })
  const addJournal = (journal: Journal) =>
    setData((prev) => ({ ...prev, journals: [journal, ...prev.journals] }))
  const saveVoucher = (v: Voucher, post: boolean) =>
    setData((prev) => ({
      ...prev,
      vouchers: [v, ...prev.vouchers],
      journals: post ? voucherToJournals(v, prev.journals).concat(prev.journals) : prev.journals,
    }))
  const patchVoucher = (id: string, patch: Partial<Voucher>, postIfPosted = false) =>
    setData((prev) => {
      const target = prev.vouchers.find((v) => v.id === id)
      if (!target) return prev
      const next = { ...target, ...patch }
      const newlyPosting = postIfPosted && patch.posting === 'Posted' && target.posting !== 'Posted'
      return {
        ...prev,
        vouchers: prev.vouchers.map((v) => (v.id === id ? next : v)),
        journals: newlyPosting
          ? voucherToJournals(next, prev.journals).concat(prev.journals)
          : prev.journals,
      }
    })
  const deleteVoucher = (id: string) =>
    setData((prev) => ({ ...prev, vouchers: prev.vouchers.filter((v) => v.id !== id) }))
  // ---- masters / employees / products CRUD ----
  const addMaster = (m: Master) =>
    setData((prev) =>
      prev.masters.some((x) => x.code === m.code)
        ? prev
        : { ...prev, masters: [m, ...prev.masters] },
    )
  const patchMaster = (code: string, patch: Partial<Master>) =>
    setData((prev) => ({
      ...prev,
      masters: prev.masters.map((m) => (m.code === code ? { ...m, ...patch } : m)),
    }))
  const removeMaster = (code: string) =>
    setData((prev) => ({ ...prev, masters: prev.masters.filter((m) => m.code !== code) }))
  const addEmployee = (e: string[]) =>
    setData((prev) => ({ ...prev, employees: [e, ...prev.employees] }))
  const addProduct = (p: Product) =>
    setData((prev) =>
      prev.products.some((x) => x.id === p.id)
        ? prev
        : { ...prev, products: [...prev.products, p] },
    )
  const patchProduct = (id: string, patch: Partial<Product>) =>
    setData((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  const postStockMovement = (movement: StockMovement) =>
    setData((prev) => {
      if (movement.type === 'Transfer') return { ...prev, movements: [movement, ...prev.movements] }
      const products = prev.products.map((product) => {
        if (product.name !== movement.product) return product
        const existing = product.batches.find((b) => b.id === movement.batch)
        const batches = existing
          ? product.batches.map((batch) =>
              batch.id === movement.batch
                ? {
                    ...batch,
                    stock: Math.max(0, batch.stock + movement.qty),
                    expiry: movement.expiry ?? batch.expiry,
                    cost: movement.unitCost ?? batch.cost,
                  }
                : batch,
            )
          : movement.qty > 0
            ? [
                ...product.batches,
                {
                  id: movement.batch,
                  expiry: movement.expiry ?? product.expiry,
                  stock: movement.qty,
                  cost: movement.unitCost ?? product.cost,
                },
              ]
            : product.batches
        return {
          ...product,
          batches,
          stock: batches.reduce((sum, batch) => sum + batch.stock, 0),
          batch: movement.batch,
          expiry: movement.expiry ?? product.expiry,
          cost: movement.unitCost ?? product.cost,
        }
      })
      return { ...prev, products, movements: [movement, ...prev.movements] }
    })
  // ---- report templates ----
  const addTemplate = (t: ReportTemplate) =>
    setData((prev) => ({ ...prev, templates: [t, ...prev.templates] }))
  const deleteTemplate = (id: string) =>
    setData((prev) => ({
      ...prev,
      templates: prev.templates.filter((t) => t.id !== id && !t.builtIn),
    }))
  // ---- payments / receipts ----
  const addPayment = (p: Payment) =>
    setData((prev) => {
      const isBank =
        p.account.includes('Bank') ||
        p.account === 'Meezan Bank — 8721' ||
        p.account === 'HBL — 2294'
      const code = p.kind === 'Receipt' ? (isBank ? 'BRV' : 'CRV') : isBank ? 'BPV' : 'CPV'
      const seq =
        Math.max(
          0,
          ...prev.vouchers
            .filter((v) => v.type === code)
            .map((v) => parseInt(v.id.split('-').at(-1) ?? '0', 10) || 0),
        ) + 1
      const v: Voucher = {
        id: `${code}-2026-${String(seq).padStart(4, '0')}`,
        date: p.date,
        type: code as Voucher['type'],
        narration: `${p.kind}${p.kind === 'Receipt' ? ' received from' : ' made to'} ${p.party}`,
        reference: p.allocations.map((a) => a.ref).join(', ') || '',
        status: 'Posted',
        posting: 'Posted',
        createdBy: p.createdBy,
        branch: 'Lahore Main',
        department: 'Accounts',
        lines: [
          {
            debit: p.kind === 'Receipt' ? p.account : 'Accounts Payable',
            credit: p.kind === 'Receipt' ? 'Accounts Receivable' : p.account,
            amount: p.total,
            remark: `Allocated against ${p.allocations.length} open invoice(s)`,
          },
        ],
      }
      const journal: Journal = {
        id: nextJournalId(prev.journals),
        date: p.date,
        description: `${p.kind} · ${p.party}`,
        debit: p.kind === 'Receipt' ? p.account : 'Accounts Payable',
        credit: p.kind === 'Receipt' ? 'Accounts Receivable' : p.account,
        amount: p.net,
        reference: v.id,
      }
      const sales = prev.sales.map((s) =>
        p.allocations.some((a) => a.ref === s.id && p.kind === 'Receipt' && a.amount >= s.amount)
          ? { ...s, status: 'Paid' as Sale['status'] }
          : s,
      )
      return {
        ...prev,
        payments: [p, ...prev.payments],
        vouchers: [v, ...prev.vouchers],
        journals: [journal, ...prev.journals],
        sales,
      }
    })
  // ---- purchase orders ----
  const addPO = (po: PurchaseOrder) => setData((prev) => ({ ...prev, pos: [po, ...prev.pos] }))
  const patchPO = (id: string, patch: Partial<PurchaseOrder>) =>
    setData((prev) => ({
      ...prev,
      pos: prev.pos.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  const setChequeStatus = (id: string, status: BankCheque['status']) =>
    setData((prev) => ({
      ...prev,
      cheques: prev.cheques.map((c) => (c.id === id ? { ...c, status } : c)),
    }))
  const postPurchaseDraft = (id: string) =>
    setData((prev) => {
      const p = prev.purchases.find((x) => x.id === id)
      if (!p || p.status !== 'Draft') return prev
      const product = prev.products.find((x) => x.name === p.product)
      if (!product) return prev
      const exists = product.batches.some((b) => b.id === p.batch)
      const batches = exists
        ? product.batches.map((b) =>
            b.id === p.batch
              ? { ...b, stock: b.stock + p.qty, cost: p.unitCost, expiry: p.expiry }
              : b,
          )
        : [...product.batches, { id: p.batch, expiry: p.expiry, stock: p.qty, cost: p.unitCost }]
      return {
        ...prev,
        purchases: prev.purchases.map((x) =>
          x.id === id ? { ...x, status: 'Posted' as Purchase['status'] } : x,
        ),
        products: prev.products.map((x) =>
          x.name === p.product
            ? {
                ...x,
                batches,
                stock: batches.reduce((a, b) => a + b.stock, 0),
                cost: p.unitCost,
                batch: p.batch,
                expiry: p.expiry,
              }
            : x,
        ),
        movements: [
          {
            id: `MOV-${Date.now()}`,
            date: p.date,
            product: p.product,
            batch: p.batch,
            type: 'Purchase',
            qty: p.qty,
            reference: p.id,
          },
          ...prev.movements,
        ],
        journals: [
          {
            id: nextJournalId(prev.journals),
            date: p.date,
            description: `Inventory purchase · ${p.product}`,
            debit: 'Inventory',
            credit: 'Accounts Payable',
            amount: p.amount,
            reference: p.id,
          },
          ...prev.journals,
        ],
      }
    })
  const convertPO = (id: string) =>
    setData((prev) => {
      const po = prev.pos.find((x) => x.id === id)
      if (!po || po.status === 'Received') return prev
      const batchId = `PO-${id.slice(-4)}`
      const base = prev.purchases.filter((x) => x.id.startsWith('PUR-2026-')).length + 185
      const pur: Partial<Purchase>[] = []
      let products = prev.products
      let journals = prev.journals
      let movements = prev.movements
      po.lines.forEach((ln, i) => {
        const product = products.find((p) => p.name === ln.product)
        if (!product) return
        const amount = ln.qty * ln.cost
        const ref = `PUR-2026-${String(base + i).padStart(4, '0')}`
        pur.push({
          id: ref,
          date: po.date,
          supplier: po.supplier,
          product: ln.product,
          qty: ln.qty,
          amount,
          status: 'Posted',
          batch: product.batch,
          expiry: product.expiry,
          unitCost: ln.cost,
        })
        products = products.map((p) =>
          p.name === ln.product
            ? {
                ...p,
                stock: p.stock + ln.qty,
                batches: [
                  ...p.batches,
                  {
                    id: `${batchId}-${i + 1}`,
                    expiry: product.expiry,
                    stock: ln.qty,
                    cost: ln.cost,
                  },
                ],
              }
            : p,
        )
        journals = [
          {
            id: nextJournalId(journals),
            date: po.date,
            description: `Inventory purchase · ${ln.product}`,
            debit: 'Inventory',
            credit: 'Accounts Payable',
            amount,
            reference: ref,
          },
          ...journals,
        ]
        movements = [
          {
            id: `MOV-${Date.now()}-${i}`,
            date: po.date,
            product: ln.product,
            batch: `${batchId}-${i + 1}`,
            type: 'Purchase',
            qty: ln.qty,
            reference: ref,
          },
          ...movements,
        ]
      })
      const purchases = [...pur.filter(Boolean).map((p) => p as Purchase), ...prev.purchases]
      const voucher: Voucher = {
        id: `PINV-${po.id.slice(-4)}`,
        date: po.date,
        type: 'PINV',
        narration: `GRN — PO ${po.id} from ${po.supplier}`,
        reference: po.id,
        status: 'Posted',
        posting: 'Posted',
        createdBy: 'System',
        branch: 'Lahore Main',
        department: 'Stores',
        lines: po.lines.map((l) => ({
          debit: 'Inventory',
          credit: 'Accounts Payable',
          amount: l.qty * l.cost,
          remark: `${l.qty} × ${l.product}`,
        })),
      }
      return {
        ...prev,
        pos: prev.pos.map((x) =>
          x.id === id ? { ...x, status: 'Received' as PurchaseOrder['status'] } : x,
        ),
        purchases,
        vouchers: [voucher, ...prev.vouchers],
        products,
        journals,
        movements,
      }
    })
  return {
    data,
    addPurchase,
    addPurchaseReturn,
    addSale,
    addJournal,
    saveVoucher,
    patchVoucher,
    deleteVoucher,
    addMaster,
    patchMaster,
    removeMaster,
    addEmployee,
    addProduct,
    patchProduct,
    postStockMovement,
    addTemplate,
    deleteTemplate,
    addPayment,
    addPO,
    patchPO,
    convertPO,
    setChequeStatus,
    postPurchaseDraft,
  }
}
