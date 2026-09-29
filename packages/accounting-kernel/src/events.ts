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
 * financial gate. In M2 that was the journal voucher only (P01, P02, P03,
 * P07, P08 steps 1-5). M3-P adds SALE_POSTED and CUSTOMER_PAYMENT_RECEIVED
 * in this PR, alongside modules/receivables and golden scenarios P04, P05,
 * P06 and P10 going green in the financial gate (docs/design/M3/README.md
 * §4 "Rules switched on in M3, not M2") — Accounting seat review required
 * (CODEOWNERS on this file).
 */
export const IMPLEMENTED_EVENTS: ReadonlySet<FinancialEventName> = new Set([
  FinancialEvent.JOURNAL_VOUCHER_POSTED,
  FinancialEvent.SALE_POSTED,
  FinancialEvent.CUSTOMER_PAYMENT_RECEIVED,
])
