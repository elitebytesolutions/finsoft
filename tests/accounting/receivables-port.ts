/*
 * ReceivablesPort — what `golden-posting-runner.ts` needs from
 * `modules/receivables` to execute P04-P12.
 *
 * NO `tx` PARAMETER (Accounting/Architecture seat, review of M3-P
 * @efb7e3f): ADR-0028 statement 6 — "the tenant and the actor come from
 * the TenantContext... and never from an argument" and "a state-changing
 * use case is ONE `withTenant(tx => …)` unit of work, opened in
 * `application/`". `modules/receivables`' real use cases (`postInvoice`,
 * `createInvoiceDraft`, …) take a plain command object and open their OWN
 * transaction internally — exactly like `modules/customers`' `getCustomer`/
 * `deactivateCustomer`, which the `customer` verb already calls this way
 * (golden-posting-runner.ts's `asActingOwner`). A `tx` parameter here would
 * either go unused by the real adapter or force it to nest a SECOND
 * `withTenant` inside the runner's own — which deadlocks this harness's
 * pinned connection pool from inside an already-open transaction (the same
 * bug the fake port's `doPostInvoice` hit calling `getCustomer` naively;
 * see fixtures/fake-receivables-port.ts's own history). Every method here
 * is therefore called under an AMBIENT `TenantContext` (`runAs`), which the
 * caller establishes once, not per method.
 *
 * Deliberately step-shaped rather than CRUD-shaped (one method per golden
 * verb, not one per module use case): this is a TEST ADAPTER translating
 * `posting-scenario/v1` steps into module calls, not a second copy of the
 * module's own API.
 */

export type PostOutcome = 'POSTED' | 'REPLAYED'

/**
 * A rejection is a THROWN domain error (`PostingError` or
 * `ReceivablesError`/`CustomerDirectoryError` — all duck-typed on
 * `.code`/`.details`, `golden-posting-runner.ts`'s `isDomainError`), not a
 * data value — the same contract `postingEngine.post` and
 * `reversalEngine.reverseForSource` already use.
 */
/** A posted invoice's own line, as the module independently computed it (golden `invoiceLines` — P10). */
export interface InvoiceLine {
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly lineNet: string
}

export interface DocumentPostResult {
  readonly outcome: PostOutcome
  /** The document's own number (`INV-…` / `RCT-…`). */
  readonly documentNumber: string
  /** The journal entry's number (`JE-…` / `RV-…`). */
  readonly entryNumber: string
  /** The journal entry's id — so `entryIdByNumber` (golden-posting-runner.ts) can feed `do: "reverse"` (direct journal reversal, expected REVERSAL_VIA_SOURCE_REQUIRED, kernel-level). */
  readonly entryId: string
  readonly documentStatus: string
  /**
   * ONLY for `postInvoice`: the module's own computed invoice lines, read
   * back after posting — P10 exists to prove the module independently
   * arrives at the SAME half-up tie (3086.4193) the kernel enforces.
   * Undefined for a receipt or a reversal, which carry no invoice lines.
   */
  readonly lines?: readonly InvoiceLine[]
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
  postInvoice(input: {
    readonly documentRef: string
    readonly customerId: string
    readonly idempotencyKey: string
    readonly occurredAt: string
    readonly payload: Record<string, unknown>
  }): Promise<DocumentPostResult>

  /** `do: "post"`, `event: "CUSTOMER_PAYMENT_RECEIVED"`. `allocations[].invoice` refs are passed through unresolved — the port owns its own document refs. */
  postReceipt(input: {
    readonly documentRef: string
    readonly customerId: string
    readonly idempotencyKey: string
    readonly occurredAt: string
    readonly payload: Record<string, unknown>
  }): Promise<DocumentPostResult>

  /** `do: "reverseDocument"`. */
  reverseDocument(input: {
    readonly documentRef: string
    readonly reason: string
    readonly idempotencyKey: string
  }): Promise<DocumentPostResult>

  /** `do: "saveDraft"`. */
  saveDraft(input: {
    readonly documentType: 'sales_invoice' | 'customer_receipt'
    readonly documentRef: string
    readonly customerId: string
    readonly fields: Record<string, unknown>
  }): Promise<DraftResult>

  /** `do: "editDraft"`. */
  editDraft(input: {
    readonly documentType: 'sales_invoice' | 'customer_receipt'
    readonly documentRef: string
    readonly fields: Record<string, unknown>
  }): Promise<DraftResult>

  /** `do: "cancelDraft"`. */
  cancelDraft(input: {
    readonly documentType: 'sales_invoice' | 'customer_receipt'
    readonly documentRef: string
    readonly reason: string | undefined
  }): Promise<DraftResult>

  /** `assert.invoiceOutstanding` / `expect.invoiceOutstanding`. */
  invoiceOutstanding(documentRef: string): Promise<string>

  /** `assert.documentStatuses` / `expect.documentStatus`. */
  documentStatus(
    documentType: 'sales_invoice' | 'customer_receipt',
    documentRef: string,
  ): Promise<string>

  /** `assert.documentNumbersIssued`. */
  documentNumbersIssued(series: 'INV' | 'RCT'): Promise<readonly string[]>
}
