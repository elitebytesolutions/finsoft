# SALE_POSTED/service@1 — service (non-stock) sales invoice

| | |
|---|---|
| **Rule** | `SALE_POSTED/service@1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000). Council decision recorded in §1. Amended 2026-09-28 (M3-000c, Accounting seat, before `IMPLEMENTED`): §4 row 7 and §11 aligned with [customer-receipt.md](customer-receipt.md) ruling R-2 (inactive customers); §4 party foreign key reworded for [ADR-0026](../adr/ADR-0026-journal-line-party-dimension.md). No change to the payload, entry, amounts or golden figures |
| **Implemented in** | M3 — sales invoice module raises the event; kernel rule |
| **Governed by** | [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) (closed event set; credit-sale substitution "Dr Accounts Receivable (customer control) for Dr Cash"); [ADR-0011](../adr/ADR-0011-money-representation.md) (line rounding boundary); [PRD.md](../PRD.md) §6.1 (service invoice, no tax); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 1, 12, 14, 17 |
| **Golden** | P04, P06, P08, P09, P10 |

---

## 1. Council decision — service sale is a `SALE_POSTED` variant

```
DECISION   A service (non-stock) sale is SALE_POSTED with lines of kind SERVICE.
           No new financial event.
DECIDED    2026-09-27 — Accounting seat, concurring with the Architecture seat's
           recommendation on BOARD.md (asked 2026-09-27). Closes the Council item
           "M2 — service sale: a SALE_POSTED variant, or a new financial event".
QUORUM     Accounting (posting rule) + Architecture (event set). Both in favour.
```

**Reasoning.**

1. **One business fact, one event.** A sale is a sale whether it delivers goods, services or both. The business fact the module reports is "this invoice was posted"; what kind of thing each line sells is a fact *about the lines*, not a different event.
2. **One entry per document, even for a mixed invoice.** The source-uniqueness constraint — one entry per `(tenant_id, source_type, source_id)` (rule 14) — only holds naturally if a mixed invoice is one event. A separate `SERVICE_SALE_POSTED` would force a mixed invoice into two entries from one source (breaking the constraint's meaning) or a third "mixed" event.
3. **One reversal path.** A variant means reversing any invoice — service, stock or mixed — is one reversal of one entry, plus the inventory kernel reversing the stock movements in the same transaction. Two events would mean two reversals that must both succeed for Invariant 6 to hold.
4. **The event set is closed at LEVEL 1.** A new member needs an ADR-level change to ADR-0005 and ARCHITECTURE §3. The variant needs none: the kernel's public surface gains a line kind, not an event.

**Counter-argument considered.** A variant puts branching inside one rule, which could hide a mistake in the branch nobody tested. Mitigated by making the line kind a closed, explicit enum on every line, by giving each kind its own golden scenarios, and by **enabling one kind at a time**: `SERVICE` now; `STOCK` only when its own golden scenarios land (§9).

**Confirmation asked for by the Architecture seat:** yes — reversal of a mixed sale is **one reversal of one entry** ([reversal.md](reversal.md) §5), with the module reversing its stock movements through the inventory kernel in the same transaction.

## 2. Trigger

**Posting the invoice** — the module's `DRAFT → POSTED` transition, by a user holding the invoice-post permission. Saving, editing or deleting a **draft** posts nothing: a draft has no journal entry, no invoice number and no customer-ledger effect. Draft deletion is allowed and audited ([ADR-0006](../adr/ADR-0006-immutable-posted-transactions.md)).

In one transaction the module: validates the draft, calls `postingEngine.post(SALE_POSTED, …, tx)`, receives the entry, assigns the invoice number (`INV-2027-000001`) and sets the invoice `POSTED`.

## 3. Payload

```ts
{
  event: 'SALE_POSTED',
  referenceType: 'sales_invoice',
  referenceId: invoice.id,
  occurredAt: invoice.invoiceDate,            // business date, tenant timezone
  idempotencyKey, actor,
  payload: {
    settlement: 'CREDIT',                     // the only value enabled in the MVP
    customerId: invoice.customerId,
    lines: [
      { kind: 'SERVICE', description: 'Monthly maintenance',
        quantity: '1.000000', unitPrice: '7500.000000', lineNet: '7500.0000' },
      { kind: 'SERVICE', description: 'Site visit',
        quantity: '3.000000', unitPrice: '833.333333',  lineNet: '2500.0000' },
    ],
    netAmount: '10000.0000',
  },
}
```

- **No tax field and no discount field.** No sales tax in the MVP (Product Owner, 2026-09-27); a tax or discount key is a schema rejection (`PAYLOAD_INVALID`), never an implicit zero. Both arrive as later rule versions with their own golden scenarios.
- **No account code and no direction** anywhere in the payload (ADR-0005).
- `description` is free text for the printed invoice. It is not an entity reference and is never joined or aggregated on (rule 17). A service-item master, when it arrives, adds `serviceItemId`.

## 4. Preconditions

| # | Rule | Error |
|---|---|---|
| 1 | Schema-valid; amounts and quantities are strings at their scale | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING`, `AMOUNT_SCALE` |
| 2 | `settlement = 'CREDIT'` | `SALE_SETTLEMENT_NOT_ENABLED` for `CASH` (specified by ADR-0005, not enabled until its golden scenario exists) |
| 3 | 1 to 200 lines; every `kind = 'SERVICE'` | `SALE_NO_LINES`, `SALE_TOO_MANY_LINES`, `SALE_LINE_KIND_NOT_ENABLED` for `STOCK` |
| 4 | Every `quantity > 0` and `unitPrice > 0` | `SALE_LINE_NON_POSITIVE` |
| 5 | Every `lineNet = round_half_up(quantity × unitPrice, 4)` **exactly** | `SALE_AMOUNT_MISMATCH`, naming the line, the submitted and the expected value |
| 6 | `netAmount = Σ lineNet` exactly | `SALE_AMOUNT_MISMATCH` |
| 7 | The customer exists in the tenant and is **active**. An inactive customer cannot be invoiced; it can still be paid ([customer-receipt.md](customer-receipt.md) ruling R-2) | `CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE` |
| 8 | Date ≤ today; resolves to an `OPEN` period | `DATE_IN_FUTURE`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`, `PERIOD_LOCKED` |
| 9 | Roles `AR_CONTROL` and `SERVICE_REVENUE` resolve | `ACCOUNT_ROLE_UNMAPPED`, `ACCOUNT_ROLE_MISCONFIGURED` |

**Rows 5 and 6 are verification, not computation.** The module computes the line nets for its document with `Money` from `packages/validation`; the kernel recomputes them with the **same** function and rejects any difference. It never substitutes its own figure: the printed invoice and the GL must carry identical numbers, and a mismatch means one of them is wrong. One implementation of the arithmetic, checked twice.

**Row 7 is the module's check.** The kernel knows nothing about modules (ARCHITECTURE §5) and cannot read `customers`. It relies on the module's validation for existence and status. Structurally, it relies on the database's tenant-scoped composite foreign key from the journal line's party, `(tenant_id, party_type, party_id)`, to the kernel-owned **`parties`** registry, which migration 012 creates. It does not rely on a key to `customers`. A customer's id *is* its party id, and `customers` itself has a foreign key to `parties`, never the reverse ([ADR-0026](../adr/ADR-0026-journal-line-party-dimension.md) statements 2 and 4). The posting engine pre-checks the party against `parties` (`PARTY_NOT_FOUND`, `PARTY_TYPE_MISMATCH`); whether the customer may be invoiced stays this row's module check (ADR-0026 statement 6).

Zero-value and negative lines are rejected. A negative line is a credit note, which is `SALE_RETURNED` — a separate rule, not in the MVP.

## 5. Entry

```
Dr AR_CONTROL        [party: CUSTOMER customerId]     netAmount
    Cr SERVICE_REVENUE                                        Σ lineNet of SERVICE lines
```

With `standard-v1` and the §3 payload:

```
JE-2027-000001   2026-09-15   SALE_POSTED/service@1   source: sales_invoice INV-2027-000001
Dr 1200 Accounts Receivable — Trade Debtors  [CUST-A]   10,000.0000
    Cr 4200 Service Revenue                                     10,000.0000
                                                         ───────────  ───────────
                                                         10,000.0000  10,000.0000
```

- **One AR line** per invoice, for the whole receivable, carrying the customer. The customer ledger therefore shows one line per invoice.
- **One revenue line per revenue account**, not one per invoice line. Line detail lives on the invoice, which the GL line references through the entry's source. (In the MVP every service line maps to `SERVICE_REVENUE`, so there is one revenue line.)
- **No inventory call.** A `SERVICE` line never calls `inventoryKernel.postMovement` and never produces COGS or inventory lines.

## 6. Amounts and rounding

```
lineNet    = round_half_up(quantity × unitPrice, 4)     ← the ONE boundary, per line
netAmount  = Σ lineNet                                   ← no rounding: sum of rounded values
AR debit   = netAmount
revenue    = Σ lineNet                                   ← = netAmount by construction
```

Because both sides are built from the same rounded line nets, **no residual can arise** and the rounding account is never touched by this rule. P04 pins `3 × 833.333333 = 2499.999999 → 2500.0000`; P10 pins a true half-way tie, `2.5 × 1234.567700 = 3086.41925 → 3086.4193` (half-even and truncation both give `3086.4192`, and are rejected).

## 7. Subledger effect

- **Customer ledger:** the AR line with its customer *is* the customer-ledger entry (debit 10,000.0000 for CUST-A). There is no separate customer balance column (rule 11).
- **Invoice outstanding** = `netAmount − Σ live allocations` from receipts ([customer-receipt.md](customer-receipt.md) §5). At posting it equals `netAmount`.

## 8. Reversal

Through the invoice only ([reversal.md](reversal.md) §5):

- **Precondition — decided (PO-Q1 Option A, Product Owner 2026-09-27):** an invoice with any **live allocation** (from a receipt that is not reversed) cannot be reversed: `INVOICE_HAS_LIVE_ALLOCATIONS`, naming the receipts. The receipts are reversed first. Reason: reversing the invoice while a receipt stays allocated to it would leave the customer with a credit balance the size of the receipt — an **advance**, and advances are deferred in the MVP. The system would be holding a state it has no rule for.
- Effect, in one transaction: kernel reverses the entry (`Dr SERVICE_REVENUE / Cr AR_CONTROL [customer]`, same amounts); invoice `POSTED → REVERSED`; outstanding becomes `0.0000` and the invoice leaves the open-items list.
- Date: [reversal.md](reversal.md) §4.

**PO-Q1 — a customer has paid part of an invoice; the user wants to cancel the invoice.**

**Decided — Product Owner, 2026-09-27: Option A** (refuse until the receipt is reversed).

| | |
|---|---|
| **Option A** — refuse until the payment is reversed (this rule) | Two visible steps: reverse the receipt, then the invoice. The customer's balance never goes into credit. No extra scope |
| **Option B** — allow it; the customer shows a credit (advance) | One step, but the MVP must then hold, display and later apply customer advances — advance handling pulled into M3, estimated +3–4 days, and a new golden scenario family |
| **Council** | **A.** It keeps the MVP inside rules that exist, and the demo shows reversal on the receipt and then the invoice |

## 9. How stock lines extend this rule later (Wave 7 — specified here, NOT enabled)

The same event, the same single entry, the same transaction:

```
SALE_POSTED  (settlement CREDIT, lines of kind SERVICE and STOCK)

Dr AR_CONTROL [customer]      Σ lineNet (all lines)
    Cr SERVICE_REVENUE                  Σ lineNet of SERVICE lines      (omitted if zero)
    Cr SALES_REVENUE                    Σ lineNet of STOCK lines        (omitted if zero)
Dr COGS                       Σ cogs_amount of the outward movements
    Cr INVENTORY                        Σ |inventory_value_delta| of those movements
Dr/Cr ROUNDING                the ADR-0015 flush residual, when a movement took stock to zero
```

- For each `STOCK` line the **module** calls `inventoryKernel.postMovement(…, tx)` before posting and passes the returned `cogsAmount`, `inventoryValueDelta` and `roundingAmount` per line. The accounting kernel **consumes** them; it never computes cost (ADR-0005, ADR-0007, ADR-0015).
- A mixed invoice is still **one** entry with **one** number and **one** reversal.
- A `SERVICE` line in a mixed invoice still never touches the inventory kernel.
- `STOCK` stays `SALE_LINE_KIND_NOT_ENABLED` until this section becomes `SALE_POSTED/stock@1` with its own golden scenarios (Scenario A's journal half is the obvious first one). Tax lines are a separate later version again.

## 10. Idempotency

- Key per [README](README.md) §4; `source_type = 'sales_invoice'`, `source_id = invoice.id`.
- Posting the same invoice again with the same key → the original entry (`REPLAYED`). With a different key → `SOURCE_ALREADY_POSTED`. Either way, exactly one entry and one invoice number (P08).
- The invoice number is assigned in the posting transaction, so a failed post leaves the draft un-numbered.

## 11. Edge cases

| Case | Behaviour |
|---|---|
| Invoice total zero | Impossible: every line is > 0 |
| Invoice dated in a closed period | `PERIOD_CLOSED`; the user re-dates the draft. Never auto-redirected |
| Credit limit | Not in the MVP. No posting-rule effect when it arrives — it is a precondition in the module |
| Due date / credit terms | Stored on the invoice; no GL effect |
| Concurrent post of the same draft by two users | One commits; the other gets `REPLAYED` (same key) or `SOURCE_ALREADY_POSTED` |
| Customer deactivated after the invoice posted | The posted invoice is unaffected. It can still be paid ([customer-receipt.md](customer-receipt.md) §3 row 8) and reversed. No new invoice for that customer can be posted (`CUSTOMER_INACTIVE`, row 7) — ruling R-2, Accounting seat, 2026-09-28 (P12) |
| Customer deactivated while an invoice for it is still a draft | The draft is unaffected, but its post is rejected `CUSTOMER_INACTIVE`. Reactivate the customer, or discard the draft |

## 12. Errors

`PAYLOAD_INVALID` · `AMOUNT_NOT_STRING` · `AMOUNT_SCALE` · `SALE_SETTLEMENT_NOT_ENABLED` · `SALE_NO_LINES` · `SALE_TOO_MANY_LINES` · `SALE_LINE_KIND_NOT_ENABLED` · `SALE_LINE_NON_POSITIVE` · `SALE_AMOUNT_MISMATCH` · `CUSTOMER_NOT_FOUND` · `CUSTOMER_INACTIVE` · `DATE_IN_FUTURE` · `PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `ACCOUNT_ROLE_UNMAPPED` · `ACCOUNT_ROLE_MISCONFIGURED` · `SOURCE_ALREADY_POSTED` · `IDEMPOTENCY_KEY_REUSED` · `INVOICE_HAS_LIVE_ALLOCATIONS` (reversal)

## 13. Golden

**P04** (the 10,000.0000 invoice and the variant fences), **P06** (reversal), **P08** (idempotency), **P09** (journey), **P10** (half-way tie at the line boundary), **P12** (an inactive customer cannot be invoiced; no number consumed).
