# M3 open questions

Part of the [M3 design pack](README.md). Asked 2026-09-28, **both answered by the Product Owner
the same day, neither with the Council's recommended default.** The pack has been updated to the
answers. The cost is in [README](README.md) §9.

No Product Owner question remains open for M3.

---

## M3-Q1 — Can a user save a customer receipt as a draft and post it later?

**DECIDED — Product Owner, 2026-09-28: yes (Option B).**

| | |
|---|---|
| **Decision** | Receipts have drafts. Status machine `DRAFT → POSTED → REVERSED`, plus `DRAFT → CANCELLED` (no hard delete). A draft posts nothing to the GL and consumes no document number: `RCT-…` is assigned at post. Drafts are editable under optimistic locking and hold **proposed** allocations. These take effect only at post, which is when invoices are locked and outstanding is reduced. Create, edit, cancel and post all use `payment.receive`, and a separate post code is proposed as debt. Endpoints: `POST /api/receipts` (draft), `PATCH /api/receipts/:id`, `POST /api/receipts/:id/post`, `POST /api/receipts/:id/cancel`. The receipt screen has Save draft and Post |
| **Numbering check** | Consistent with the rules. A number is assigned in the posting transaction, after validation, and a rejected posting consumes none ([posting-rules README](../../posting-rules/README.md) §4). [customer-receipt.md](../../posting-rules/customer-receipt.md) §1 already describes a `DRAFT → POSTED` trigger that assigns `RCT-…`. **Nothing to flag.** The Accounting seat is adding explicit draft wording to customer-receipt.md on `feature/M3-000c-posting-rules`. This pack references that branch and does not edit posting rules |
| **Where it landed** | [modules.md](modules.md) §4.2 (draft use cases and `PostReceipt`), §5 (status machine), §6 and §7 (proposals in `customer_receipt_draft_allocations`, kept apart from real allocations), §8 (audit), §9 (keys), §10 (lock 1b). [api-contract.md](api-contract.md) R3–R8. [ui-plan.md](ui-plan.md) payments-centre. Migration 016 |
| **Design choice made with it** | Invoice drafts used "discard" / `DISCARDED`. They now use **cancel** / `CANCELLED`, the Product Owner's word for receipts, so that one concept has one name. It is the same terminal, never-numbered state; only the name changed |
| **Cost** | +2 days on M3-P, +1 day on M4 |

## M3-Q2 — Who chooses a customer's code?

**DECIDED — Product Owner, 2026-09-28: the system generates it (Option B).**

| | |
|---|---|
| **Decision** | Codes are system-generated from `document_sequences`, assigned at create, immutable and unique per tenant. The create API does not accept a code, and sending one is `400 VALIDATION_FAILED` |
| **Series scope — decided by this seat** | **One `CUST` series per tenant, not per fiscal year.** A code identifies a master record for its whole life. It is not a document dated inside a period. A per-year series would repeat `CUST-000001` every July and force the year into the code, where it would mean nothing. Creating a customer is not a posting, so there is no period to resolve ([modules.md](modules.md) §10) |
| **Format — decided by this seat** | `CUST-000001`: six digits, the width of every other series. The PO's `CUST-0001` was given as an example. Six digits allow 999,999 codes before the width grows, and keep sort order equal to creation order. It never wraps |
| **Requirement it creates** | **K7 on M2-A:** migration 013 `document_sequences` must allow a series with no fiscal-year scope ([README](README.md) §4). Raised with this change. If 013 merges without it, a forward kernel migration is needed before M3-C can start |
| **Consequence accepted** | Bhatti's existing customer codes cannot become the code. Wave 10 adds a searchable `legacy_code` ([README](README.md) §10). Customer create now depends entirely on its idempotency key against double submission, since no natural key remains ([modules.md](modules.md) §9) |
| **Cost** | About +0.5 day, split between M2-A and M3-C |

---

## Referred elsewhere — not Product Owner questions

**To the Accounting seat — two posting-rule documents disagree on paying an inactive customer.**
[service-sale.md](../../posting-rules/service-sale.md) §11 says a customer deactivated after an
invoice posted *"can still be paid and reversed"*.
[customer-receipt.md](../../posting-rules/customer-receipt.md) §3 row 8 rejects a receipt for an
inactive customer (`CUSTOMER_INACTIVE`). **The Accounting seat is resolving this on
`feature/M3-000c-posting-rules`**, together with the draft wording and service-sale.md:84 (the
party-FK sentence that ADR-0026 affects). Until that branch merges, this pack follows **row 8**,
the stricter rule: `PostReceipt` calls `requireActiveForPosting`. The case rarely arises, because
a customer with a non-zero balance cannot be deactivated (`CUSTOMER_HAS_BALANCE`). If the rule
lands the other way, only that one call in `PostReceipt` changes.

**Recorded in [ui-plan.md](ui-plan.md), resolved by precedence (a rule document beats a page
document):** the invoice detail page's "reversal into the first open period" contradicts
[reversal.md](../../posting-rules/reversal.md) §4. The rule wins, and the page document is
corrected in M4.

**Recorded in [README](README.md) §6, resolved by ADR-0027:** [ARCHITECTURE](../../ARCHITECTURE.md)
§2's per-module `ui/` layer contradicts `.dependency-cruiser.cjs` `web-is-ui-only`, which forbids
`apps/web` from importing `modules/**`. It went unnoticed because `modules/` has been empty.
