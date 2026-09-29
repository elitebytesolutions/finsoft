# CUSTOMER_PAYMENT_RECEIVED@1 — customer receipt

| | |
|---|---|
| **Rule** | `CUSTOMER_PAYMENT_RECEIVED@1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000). Amended 2026-09-28 (M3-000c, Accounting seat, before `IMPLEMENTED`, per [README](README.md) §3.4): receipt drafts (§1.1, Product Owner 2026-09-28); an inactive customer may still be paid (§3 row 8, ruling R-2 in §13) |
| **Implemented in** | M3 — customer receipt module raises the event; kernel rule; AR half of Invariant 9 |
| **Governed by** | [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 1, 11, 12, 14; Invariant 9 |
| **Golden** | P05, P06, P09, P11, P12 |

---

## 1. Trigger

**Posting a customer receipt** — the module's `DRAFT → POSTED` transition by a user holding the receipt-post permission. Money received from a customer, in cash or into the bank, applied in full to that customer's open invoices.

**Not a trigger:** saving, editing or cancelling a draft (§1.1). `CUSTOMER_PAYMENT_RECEIVED` is raised **only** by the post action.

In one transaction the module: takes the receipt row `FOR UPDATE` and checks that it is still `DRAFT` (§1.1 rule 7), re-validates the draft and its allocations against the current state (§3), locks the allocated invoices, calls `postingEngine.post(CUSTOMER_PAYMENT_RECEIVED, …, tx)`, turns the proposed allocations into `LIVE` allocations, assigns the receipt number (`RCT-2027-000001`) and sets the receipt `POSTED`. If the UI offers "save and post" as one action, it is a draft save followed by this post. This rule governs only the post.

### 1.1 Document lifecycle — decided (Product Owner, 2026-09-28)

```
DRAFT ──post────► POSTED ──reverse──► REVERSED
  │
  └────cancel───► CANCELLED
```

| State | Accounting effect | Number | Editable | Leaves by |
|---|---|---|---|---|
| `DRAFT` | **None.** No journal entry, no `LIVE` allocation, no effect on any invoice's outstanding, no customer-ledger line | none | Yes, every field: date, customer, method, amount, proposed allocations ([ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md): `DRAFT` is the only mutable state) | post → `POSTED`; cancel → `CANCELLED` |
| `POSTED` | The §4 entry and its `LIVE` allocations | `RCT-{FY}-{NNNNNN}`, assigned at post | No | reverse → `REVERSED` (§7) |
| `REVERSED` | Neutralised by the reversal entry; allocations `VOIDED` | kept | No | nothing |
| `CANCELLED` | **None, ever.** It never had any | none, ever | No | nothing. A cancelled draft is never posted, reopened or deleted |

Rules of the lifecycle:

1. **No hard delete.** A receipt draft is not deleted. It is **cancelled** (`DRAFT → CANCELLED`), with `cancelled_at`, `cancelled_by` and an optional reason, and it stays visible in the receipt list under a "Cancelled" filter. This is stricter than ADR-0006, which permits an audited draft deletion. The Product Owner chose cancellation for receipts because a receipt draft usually records money a cashier has physically taken, and a vanished record of it is exactly what an auditor asks about.
2. **Numbering at post.** A draft has no receipt number and consumes none. The `RCT` number is taken from `document_sequences` in the posting transaction, after all validation ([README](README.md) §4 "Numbering"). A draft that is cancelled, or whose post is rejected, leaves no gap in the `RCT` series. The UI identifies a draft as "Draft" plus its internal id, never by a provisional `RCT` number.
3. **Proposed allocations reserve nothing.** A draft's allocations are proposals: allocation rows with status `PROPOSED` (the allocation status set is `PROPOSED | LIVE | VOIDED`, §5). Outstanding counts `LIVE` only. Two drafts may between them propose more than an invoice's outstanding; whichever posts first wins, and the other is rejected at post with `ALLOCATION_EXCEEDS_OUTSTANDING` (row 7). At post, the receipt's `PROPOSED` rows become `LIVE` in the posting transaction. A cancelled draft's rows stay `PROPOSED`, frozen with the document, and are never counted.
4. **Everything is re-validated at post.** Nothing checked when the draft was saved is trusted when it is posted. All of §3 runs at post time against the state at post time: the customer, every invoice's status and outstanding (under the row lock), the date against *today*, and the period's status *now*. Saving a draft validates shape only (amounts are decimal strings at their scale). A draft may be saved incomplete, with allocations that do not sum to the amount, or dated in a closed period, because it has no effect.
5. **A draft dated into a period that has since closed cannot be posted.** The post is rejected `PERIOD_CLOSED` (or `PERIOD_LOCKED`), naming the period and the current open period. The draft stays `DRAFT`, unchanged. **The system never re-dates it.** The user chooses, and each option is a deliberate human act: (a) edit the draft's date into an open period and post it. The receipt is then recognised in that period, and row 6 is checked again against the new date. (b) A holder of `period.reopen` reopens the period under its own controls ([periods.md](periods.md) §4.1), if the close was premature. (c) Cancel the draft. A draft dated after today is treated the same way: `DATE_IN_FUTURE` until that date arrives.
6. **Cancel and post race.** Both take the receipt row `FOR UPDATE` first, so one commits and the other sees the new status. The receipt row is locked **before** the invoice rows. That lock order is an entry for [LOCK_REGISTRY.md](../LOCK_REGISTRY.md) (M3, Database seat).
7. **Status errors.** Cancelling a receipt that is not `DRAFT` is `RECEIPT_NOT_DRAFT`: a posted receipt is corrected by reversal (§7). Posting a `CANCELLED` receipt is `RECEIPT_NOT_DRAFT`. Posting a receipt that is already `POSTED` or `REVERSED` is **not** pre-empted by the module's status check. The request goes to the kernel, which returns the original entry for the original key (`REPLAYED`) and `SOURCE_ALREADY_POSTED` for any other key (§9). Otherwise a network retry of a successful post would surface as an error.
8. **Audit.** Cancellation is a status transition of a financial document. It writes one audit record in its own transaction. Draft saves and edits are audited by the module as document edits. They are not financial mutations and write no posting audit record.

**Not in the MVP:** cheques (`CHEQUE_RECEIVED` / `CHEQUE_CLEARED`, Wave 3), advances and on-account receipts, over-payments, receipts in any currency but PKR, withholding deducted at source, and settlement discounts. `BANK` in the MVP means funds already in the bank (a transfer or a deposit already made).

## 2. Payload

```ts
{
  event: 'CUSTOMER_PAYMENT_RECEIVED',
  referenceType: 'customer_receipt',
  referenceId: receipt.id,
  occurredAt: receipt.receiptDate,
  idempotencyKey, actor,
  payload: {
    customerId,
    method: 'BANK',                          // 'CASH' | 'BANK'
    amount: '6000.0000',
    allocations: [ { invoiceId, amount: '6000.0000' } ],
  },
}
```

`method` is a business fact — how the money arrived — not an account. The kernel resolves it to a role.

## 3. Preconditions

| # | Rule | Error |
|---|---|---|
| 1 | Schema-valid; amounts are strings, ≤ 4 dp | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING`, `AMOUNT_SCALE` |
| 2 | `amount > 0` | `AMOUNT_NON_POSITIVE` |
| 3 | At least one allocation; each allocation amount > 0; no invoice listed twice | `RECEIPT_NO_ALLOCATION`, `AMOUNT_NON_POSITIVE`, `ALLOCATION_DUPLICATE_INVOICE` |
| 4 | **`Σ allocations = amount` exactly** — no unallocated remainder | `RECEIPT_UNALLOCATED_AMOUNT` (advances are deferred) |
| 5 | Each invoice: same tenant, **same customer**, status `POSTED` | `INVOICE_NOT_FOUND`, `ALLOCATION_PARTY_MISMATCH`, `INVOICE_NOT_OPEN` |
| 6 | Each invoice's date ≤ the receipt's date | `ALLOCATION_INVOICE_AFTER_RECEIPT` — a receipt before its invoice is an advance |
| 7 | Each allocation ≤ that invoice's outstanding, read **under a row lock** on the invoice | `ALLOCATION_EXCEEDS_OUTSTANDING`, naming the invoice and its outstanding |
| 8 | Customer exists in the tenant, **active or inactive**. An inactive customer may still be paid (ruling R-2, §13) | `CUSTOMER_NOT_FOUND` |
| 9 | Date ≤ today; resolves to an `OPEN` period. Evaluated **at post**, never at draft save (§1.1 rule 5) | `DATE_IN_FUTURE`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`, `PERIOD_LOCKED` |
| 10 | Roles `AR_CONTROL` and `CASH_DEFAULT` or `BANK_DEFAULT` resolve | `ACCOUNT_ROLE_UNMAPPED`, `ACCOUNT_ROLE_MISCONFIGURED` |

Every row is evaluated when the receipt is **posted**, against the state at that moment (§1.1 rule 4). Rows 3–7 are the module's subledger rules; the kernel sees only the customer and the amount. They are listed here because they decide whether the GL entry may exist.

**Row 7 and concurrency.** Two receipts allocating to the same invoice at the same moment must not both see the full outstanding. The module takes the invoice rows `FOR UPDATE` in a deterministic order (by invoice id) before computing outstanding; the lock key and position belong in [LOCK_REGISTRY.md](../LOCK_REGISTRY.md) (M3, Database seat).

## 4. Entry

```
Dr CASH_DEFAULT   (method = CASH)        amount
or Dr BANK_DEFAULT   (method = BANK)     amount
    Cr AR_CONTROL   [party: CUSTOMER customerId]        amount
```

With `standard-v1`:

```
JE-2027-000002   2026-09-20   CUSTOMER_PAYMENT_RECEIVED@1   source: customer_receipt RCT-2027-000001
Dr 1120 Bank — Current Account                    6,000.0000
    Cr 1200 Accounts Receivable  [CUST-A]                   6,000.0000
```

**Exactly two lines, whatever the number of allocations.** Allocation to invoices is a subledger fact, not a GL fact: a receipt applied to three invoices is still one debit and one credit. The AR line carries the customer; it does not carry an invoice.

## 5. Allocation — the subledger

Allocations are rows in the receipt module's table (M3): `(tenant_id, receipt_id, invoice_id, amount, status PROPOSED | LIVE | VOIDED)`. `PROPOSED` rows belong to a draft, or to a cancelled draft, and have no effect (§1.1 rule 3). `PROPOSED → LIVE` happens only in the posting transaction, and `LIVE → VOIDED` only in the reversal transaction.

```
invoice outstanding = invoice.netAmount − Σ amount of LIVE allocations to it
```

| Case | Result |
|---|---|
| Allocation = outstanding | Invoice fully paid; outstanding `0.0000` |
| Allocation < outstanding | Partial; the remainder stays open (P05: 10,000.0000 − 6,000.0000 = 4,000.0000) |
| Allocation > outstanding | Rejected (row 7) |
| Several invoices | One allocation row each; one GL entry for the receipt |

Allocation is **manual** in the MVP: the user picks invoices and amounts. The UI may pre-fill oldest-first as a suggestion; the server accepts only what is submitted. There is no automatic re-allocation and no un-allocation separate from reversal.

## 6. Amounts

No computation: **no rounding boundary**. The amount and the allocations are user-entered and must agree exactly.

## 7. Reversal

Through the receipt only ([reversal.md](reversal.md) §5). In one transaction:

- kernel reverses the entry: `Dr AR_CONTROL [customer] / Cr CASH_DEFAULT or BANK_DEFAULT`, same amount;
- every allocation of the receipt `LIVE → VOIDED` (never deleted), restoring each invoice's outstanding;
- receipt `POSTED → REVERSED`.

A voided allocation stays visible on both the receipt and the invoice. Reversal date per [reversal.md](reversal.md) §4. A reversed receipt cannot be un-reversed; a corrected receipt is a new document.

## 8. Invariant 9, AR half — the reconciliation this rule makes possible

For every tenant, every customer `C` and every as-of date `D`:

```
GL(C, D)  = Σ (debit − credit) over journal lines on the AR_CONTROL account
            with party C and occurred_at ≤ D        — every entry, POSTED or REVERSED

SUB(C, D) = Σ netAmount of C's invoices posted on or before D
          − Σ netAmount of C's invoices whose reversal is dated on or before D
          − Σ amount of C's receipts posted on or before D
          + Σ amount of C's receipts whose reversal is dated on or before D

GL(C, D) = SUB(C, D)                                  exactly, no tolerance
Σ over C of GL(C, D) = AR_CONTROL balance at D        (structural: README §4.1)
```

`DRAFT` and `CANCELLED` receipts, and `PROPOSED` allocations, contribute nothing to either side.

And today, because the MVP has no advances:

```
SUB(C, today) = Σ outstanding of C's POSTED invoices
```

The M3 QA lane implements this as Invariant 9 (AR half). A failure is a Sev-2 incident, not a rounding note ([NON_NEGOTIABLES](../NON_NEGOTIABLES.md) §10–11).

## 9. Idempotency

Key per [README](README.md) §4; `source_type = 'customer_receipt'`, `source_id = receipt.id`. Replay returns the original entry; a second post of the same receipt under a new key is `SOURCE_ALREADY_POSTED`. Allocations are written in the same transaction, so a replay never writes them twice.

The key belongs to the **post action**, not to the draft. Saving, editing and cancelling a draft carry no posting idempotency key and never reach the kernel. The UI generates a fresh key for each post submission. A rejected post records no key ([README](README.md) §4 "Rejected requests leave no trace"), so after a rejection (for example `PERIOD_CLOSED`, then a re-date) the next post may use a new key or the same one. `source_id` is the draft's id, which the document keeps from creation, so one draft can produce at most one entry, ever.

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Customer pays more than is owed | Rejected in the MVP (`RECEIPT_UNALLOCATED_AMOUNT`). The user records what is owed; the excess waits for advances |
| Receipt dated in a closed period | `PERIOD_CLOSED` at post; the draft stays `DRAFT`. Re-date, reopen or cancel, as a human choice (§1.1 rule 5). Never redirected |
| Draft saved while its period was open; the period closed before posting | As above. Saving a draft reserves nothing, including its period (P11) |
| Two drafts proposing more than an invoice's outstanding | Both save. The first to post wins. The second is rejected `ALLOCATION_EXCEEDS_OUTSTANDING` with the current outstanding, and stays `DRAFT` to be edited or cancelled (P11) |
| Invoice reversed while a draft proposes an allocation to it | The draft still saves and shows the proposal; its post is rejected `INVOICE_NOT_OPEN` |
| Draft cancelled | No entry, no number, no allocation effect, one audit record (P11) |
| Cancel a posted receipt | `RECEIPT_NOT_DRAFT`. Reverse it instead (§7) |
| Customer deactivated after it was invoiced | The receipt still posts (row 8; P12) |
| Invoice reversed between loading the form and posting | `INVOICE_NOT_OPEN` |
| Receipt for an invoice whose period is closed | Allowed. The receipt's own date governs its period |
| Cash receipt taking Cash in Hand from negative to positive | No effect on the rule. Negative-cash controls are not in the MVP |

## 11. Errors

`PAYLOAD_INVALID` · `AMOUNT_NOT_STRING` · `AMOUNT_SCALE` · `AMOUNT_NON_POSITIVE` · `RECEIPT_NO_ALLOCATION` · `ALLOCATION_DUPLICATE_INVOICE` · `RECEIPT_UNALLOCATED_AMOUNT` · `INVOICE_NOT_FOUND` · `ALLOCATION_PARTY_MISMATCH` · `INVOICE_NOT_OPEN` · `ALLOCATION_INVOICE_AFTER_RECEIPT` · `ALLOCATION_EXCEEDS_OUTSTANDING` · `CUSTOMER_NOT_FOUND` · `DATE_IN_FUTURE` · `PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `ACCOUNT_ROLE_UNMAPPED` · `ACCOUNT_ROLE_MISCONFIGURED` · `SOURCE_ALREADY_POSTED` · `IDEMPOTENCY_KEY_REUSED` · `RECEIPT_NOT_DRAFT` (post of a cancelled receipt; cancel of a receipt that is not a draft)

`CUSTOMER_INACTIVE` is **not** a receipt error (ruling R-2).

## 12. Golden

**P05** (6,000.0000 against 10,000.0000; ledger 4,000.0000; allocation rejections), **P06** (receipt reversal restores outstanding), **P09** (journey), **P11** (draft lifecycle: drafts have no effect; a draft in a since-closed period is rejected, re-dated and posted; a stale proposal is rejected at post; a draft is cancelled; no number consumed), **P12** (an inactive customer is paid; the same customer cannot be invoiced).

## 13. Rulings

| Id | Date | By | Ruling |
|---|---|---|---|
| R-1 | 2026-09-28 | Accounting seat, implementing the Product Owner's decision of 2026-09-28 | **Receipts may be saved as drafts.** Lifecycle, numbering, re-validation, period and idempotency treatment as in §1.1 and §9. A draft has no accounting effect of any kind. The `CUSTOMER_PAYMENT_RECEIVED` payload and entry are unchanged |
| R-2 | 2026-09-28 | Accounting seat | **"Inactive" stops new receivables. It never stops the settlement of existing ones.** This resolves the contradiction, raised by the M3 design pack, between [service-sale.md](service-sale.md) §11 ("can still be paid") and this file's former §3 row 8 (`CUSTOMER_INACTIVE` on a receipt). An inactive customer **cannot be invoiced** (`SALE_POSTED/service@1` row 7, unchanged). An inactive customer **can** have receipts drafted and posted against its open invoices, and its invoices and receipts can be reversed. Reasoning: deactivating a customer means "stop trading with them", not "forgive what they owe". Blocking the receipt would leave a real receivable uncollectable in the system. The user would then either reactivate the customer, which re-enables invoicing just to get round the flag, or record the money somewhere other than AR, which misstates both the receivable and the customer ledger. Because the MVP has no advances, every receipt must be fully allocated to that customer's `POSTED` invoices (rows 4–5), so a receipt for an inactive customer can only settle debt that already exists. **Revisit this ruling when advances or on-account receipts arrive:** an unallocated receipt from an inactive customer creates a new liability, and allowing it is a new decision. For the design pack: the receipt's customer picker includes inactive customers (at least those with an outstanding balance) and marks them as inactive |
