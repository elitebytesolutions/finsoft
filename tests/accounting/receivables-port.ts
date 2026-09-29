import type { TenantTx } from '@finsoft/database'

/*
 * ReceivablesPort — what `golden-posting-runner.ts` needs from
 * `modules/receivables` to execute P05, P06, P08 (invoice steps), P09, P11
 * and P12. `modules/receivables` does not exist on this branch (M3-P has
 * not started — see the M3-Q report), so this interface is this lane's
 * BEST-EFFORT reading of docs/design/M3/modules.md §4 ("How posting is
 * invoked"), §7 (table shapes) and docs/design/M3/api-contract.md, not a
 * contract M3-P has agreed to. IT MAY BE WRONG. `loadReceivablesPort()`
 * (golden-posting-runner.ts) is written defensively for exactly that
 * reason: it treats a shape mismatch as "unavailable", never as a crash —
 * staying PENDING is always the safe failure.
 *
 * Deliberately step-shaped rather than CRUD-shaped (one method per golden
 * verb, not one per module use case): this is a TEST ADAPTER translating
 * `posting-scenario/v1` steps into module calls, not a second copy of the
 * module's own API. `docs/design/M3/README.md` §3 puts the exact
 * `modules/receivables` surface in M3-P's hands; this file does not
 * presume to fix it.
 *
 * P04 and P10 need NONE of this — they have no receipts, so `SALE_POSTED`
 * alone (already built in the kernel, gated only by IMPLEMENTED_EVENTS)
 * could in principle post them. They still cannot execute on this branch:
 * their own `assert` steps need `invoiceOutstanding` and the invoice's own
 * `INV-…` `documentNumber`, both of which are `modules/receivables` facts
 * with no kernel equivalent (README §4: "Documents carry their own numbers
 * from the same facility"; the kernel entry's own number is the `JE-…`
 * series only). So this port covers every M3 scenario, not only the ones
 * that also need allocation validation.
 */

export type PostOutcome = 'POSTED' | 'REPLAYED'

/**
 * A rejection is a THROWN `PostingError` (`@finsoft/accounting-kernel`), not
 * a data value — the same contract `postingEngine.post` and
 * `reversalEngine.reverse` already use, and the one `checkRejection`
 * (golden-posting-runner.ts) already knows how to check. A module rejection
 * carries a domain code from api-contract.md §3 (`ALLOCATION_EXCEEDS_
 * OUTSTANDING`, `CUSTOMER_INACTIVE`, …), which is exactly what
 * `PostingError.code` already means.
 */
export interface DocumentPostResult {
  readonly outcome: PostOutcome
  /** The document's own number (`INV-…` / `RCT-…`). */
  readonly documentNumber: string
  /** The journal entry's number (`JE-…` / `RV-…`). */
  readonly entryNumber: string
  /** The journal entry's id — so `entryIdByNumber` (golden-posting-runner.ts) can feed `do: "reverse"` (direct journal reversal, expected REVERSAL_VIA_SOURCE_REQUIRED, kernel-level). */
  readonly entryId: string
  readonly documentStatus: string
}

export interface DraftResult {
  readonly documentStatus: string
  readonly documentNumber: string | null
  readonly allocations?: readonly {
    readonly invoiceRef: string
    readonly amount: string
    readonly status: string
  }[]
}

/**
 * A step's raw JSON, with fixture refs (`"CUST-A"`, `"INV-A1"`) resolved to
 * real ids where the port is expected to need them, and left as refs where
 * the port itself owns ref -> id resolution (documents it creates).
 */
export interface ReceivablesPort {
  /** `do: "post"`, `event: "SALE_POSTED"`. */
  postInvoice(
    tx: TenantTx,
    input: {
      readonly documentRef: string
      readonly customerId: string
      readonly idempotencyKey: string
      readonly occurredAt: string
      readonly payload: Record<string, unknown>
    },
  ): Promise<DocumentPostResult>

  /** `do: "post"`, `event: "CUSTOMER_PAYMENT_RECEIVED"`. `allocations[].invoice` refs are passed through unresolved — the port owns its own document refs. */
  postReceipt(
    tx: TenantTx,
    input: {
      readonly documentRef: string
      readonly customerId: string
      readonly idempotencyKey: string
      readonly occurredAt: string
      readonly payload: Record<string, unknown>
    },
  ): Promise<DocumentPostResult>

  /** `do: "reverseDocument"`. */
  reverseDocument(
    tx: TenantTx,
    input: {
      readonly documentRef: string
      readonly reason: string
      readonly idempotencyKey: string
    },
  ): Promise<DocumentPostResult>

  /** `do: "saveDraft"`. */
  saveDraft(
    tx: TenantTx,
    input: {
      readonly documentType: 'sales_invoice' | 'customer_receipt'
      readonly documentRef: string
      readonly customerId: string
      readonly fields: Record<string, unknown>
    },
  ): Promise<DraftResult>

  /** `do: "editDraft"`. */
  editDraft(
    tx: TenantTx,
    input: {
      readonly documentType: 'sales_invoice' | 'customer_receipt'
      readonly documentRef: string
      readonly fields: Record<string, unknown>
    },
  ): Promise<DraftResult>

  /** `do: "cancelDraft"`. */
  cancelDraft(
    tx: TenantTx,
    input: {
      readonly documentType: 'sales_invoice' | 'customer_receipt'
      readonly documentRef: string
      readonly reason: string | undefined
    },
  ): Promise<DraftResult>

  /** `assert.invoiceOutstanding` / `expect.invoiceOutstanding`. */
  invoiceOutstanding(tx: TenantTx, documentRef: string): Promise<string>

  /** `assert.documentStatuses` / `expect.documentStatus`. */
  documentStatus(
    tx: TenantTx,
    documentType: 'sales_invoice' | 'customer_receipt',
    documentRef: string,
  ): Promise<string>

  /** `assert.documentNumbersIssued`. */
  documentNumbersIssued(tx: TenantTx, series: 'INV' | 'RCT'): Promise<readonly string[]>
}
