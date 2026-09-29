/*
 * @finsoft/accounting-kernel — the single implementation of accounting
 * behaviour in the system (ADR-0005). No module constructs journal lines; a
 * module raises a FinancialEvent through `postingEngine.post(command, tx)`,
 * registers a customer/vendor through `registerParty(tx, type)`, and a user
 * reverses a manual voucher through `reversalEngine.reverse(command, tx)`.
 *
 * Deliberately NOT exported: `createPostingEngine` / `createReversalEngine`
 * (a caller choosing the clock would choose "today" — rule 13; tests import
 * the source files directly), the rule builders, and `src/queries/**`, the
 * only code in the system that writes journal_entries, journal_lines and
 * parties.
 */

export { fixedClock, systemClock, type Clock } from './clock.ts'
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
  REVERSAL_SERIES,
  reversalEngine,
  type ReversalEngine,
  type ReverseCommand,
  type ReverseResult,
} from './reversal.ts'

export {
  JOURNAL_VOUCHER_RULE_ID,
  JOURNAL_VOUCHER_SERIES,
  JOURNAL_VOUCHER_SOURCE_TYPE,
  type JournalVoucherPayload,
} from './rules/journal-voucher.ts'
export {
  SALE_SERIES,
  SALE_SOURCE_TYPE,
  SERVICE_SALE_RULE_ID,
  type ServiceSalePayload,
} from './rules/service-sale.ts'
export {
  CUSTOMER_RECEIPT_RULE_ID,
  RECEIPT_SERIES,
  RECEIPT_SOURCE_TYPE,
  type CustomerReceiptPayload,
} from './rules/customer-receipt.ts'
