/*
 * The FinancialEvent set. ADR-0005: closed at LEVEL 1 — a new member needs
 * an ADR change, never a side effect of a feature ticket.
 *
 * Only the members with an APPROVED rule document are named here. Every other
 * member of the closed set (SALE_RETURNED, PURCHASE_*, SUPPLIER_PAYMENT_MADE,
 * CHEQUE_*, STOCK_*, EXPENSE_RECORDED, OPENING_BALANCE_LOADED) has no rule and
 * is therefore not postable.
 */
export const FinancialEvent = {
  JOURNAL_VOUCHER_POSTED: 'JOURNAL_VOUCHER_POSTED',
  SALE_POSTED: 'SALE_POSTED',
  CUSTOMER_PAYMENT_RECEIVED: 'CUSTOMER_PAYMENT_RECEIVED',
} as const

export type FinancialEventName = (typeof FinancialEvent)[keyof typeof FinancialEvent]

/**
 * docs/posting-rules/README.md §1 and §3: "The kernel rejects an event or
 * variant whose rule is not IMPLEMENTED with RULE_NOT_ENABLED." A rule is
 * IMPLEMENTED when its kernel code AND its golden scenarios execute in the
 * financial gate. In M2 that is the journal voucher (P01, P02, P03, P07, P08
 * steps 1-5). SALE_POSTED/service@1 and CUSTOMER_PAYMENT_RECEIVED@1 have their
 * rule logic here but their goldens (P04, P05, P06, P09, P10) need M3's
 * module tables; M3 adds them to this set in the same PR those goldens go
 * green — Accounting seat review required (CODEOWNERS on this file).
 */
export const IMPLEMENTED_EVENTS: ReadonlySet<FinancialEventName> = new Set([
  FinancialEvent.JOURNAL_VOUCHER_POSTED,
])
