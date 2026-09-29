/*
 * @finsoft/accounting-kernel — the single implementation of accounting
 * behaviour in the system (ADR-0005). No module constructs journal lines; a
 * module raises a FinancialEvent through `postingEngine.post(command, tx)`,
 * registers a customer/vendor through `registerParty(tx, type)`, and a user
 * reverses a manual voucher through `reversalEngine.reverse(command, tx)`.
 *
 * A user closes, reopens and locks a period through `periodEngine`
 * (periods.ts); the transitions' own bodies — calendar lock, order check,
 * UPDATE, audit — are the kernel's src/queries/periods.ts, and nothing
 * outside the kernel performs a period transition (T3 Council, Arch 1/2/5).
 *
 * Deliberately NOT exported:
 *  - `createPostingEngine` / `createReversalEngine`, `fixedClock`,
 *    `systemClock` and the `Clock` type: a caller choosing the clock would
 *    choose "today" (rule 13). Tests import src/clock.ts directly.
 *  - every `*_SERIES` constant: a document series is the rule's internal
 *    choice, handed to numbering by the pipeline; no caller supplies or
 *    needs one. Tests import the rule files directly.
 *  - the rule builders, and `src/queries/**` — the only code in the system
 *    that writes journal_entries, journal_lines, parties and fiscal period
 *    transitions.
 */

export { FinancialEvent, IMPLEMENTED_EVENTS, type FinancialEventName } from './events.ts'
export { KernelInvariantError, PostingError, type PostingErrorCode } from './errors.ts'
export { PartyType, registerParty, type PartyTypeName } from './parties.ts'
export { periodEngine, type PeriodEngine } from './periods.ts'
export {
  postingEngine,
  type PostCommand,
  type PostingEngine,
  type PostResult,
} from './posting-engine.ts'
export {
  REVERSAL_RULE_ID,
  reversalEngine,
  type ReversalEngine,
  type ReverseCommand,
  type ReverseResult,
} from './reversal.ts'

export {
  JOURNAL_VOUCHER_RULE_ID,
  JOURNAL_VOUCHER_SOURCE_TYPE,
  type JournalVoucherPayload,
} from './rules/journal-voucher.ts'
export {
  SALE_SOURCE_TYPE,
  SERVICE_SALE_RULE_ID,
  type ServiceSalePayload,
} from './rules/service-sale.ts'
export {
  CUSTOMER_RECEIPT_RULE_ID,
  RECEIPT_SOURCE_TYPE,
  type CustomerReceiptPayload,
} from './rules/customer-receipt.ts'
