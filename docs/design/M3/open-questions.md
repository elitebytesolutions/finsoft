# M3 open questions

Part of the [M3 design pack](README.md). Asked 2026-09-28. Under
[OPERATING_MODEL](../../OPERATING_MODEL.md) §6 each closes within 2 working days, by
**2026-09-30**. **Coding does not wait:** each question has a default, the lanes build to it, and
the table states what a different answer would cost later.

Everything else M3 needs is decided in this pack or in the posting rules. The two questions below
are the only ones that change what a user can do, which makes them Product Owner decisions rather
than Council ones.

---

## Q1 — Can a user save a customer receipt as a draft and post it later?

The payments page document shows **Save draft**. The design records and posts a receipt in one
step, and the form itself is the draft ([modules.md](modules.md) §4.2).

| | |
|---|---|
| **Option A — no receipt drafts in the MVP** (default) | The user fills the form and posts it. If they leave the page, the entry is lost. Allocations are checked under row locks at the moment of posting, so what the user saw is what posts. No extra scope. The invoice keeps its draft, because an invoice is composed over time and a receipt is a record of money already in hand |
| **Option B — receipt drafts** | Adds a `DRAFT` receipt state, draft allocations that are **not** reserved and can go stale while the draft waits (another receipt can pay the same invoice), re-validation at posting with a new error state for "your draft's allocations are no longer valid", discard, and a drafts list. Estimate **+1.5 to 2 days** in M3-P and **+1 day** in M4 |
| **Council recommendation** | **A.** Money received is a fact to record, not a document to compose. Stale draft allocations would be a new class of confusing failure in the demo |
| **If B is chosen after M3-P starts** | Migration 016 gains a `DRAFT` status before it merges. After it merges, a new migration is needed. No posting-rule change: the rule already describes a `DRAFT → POSTED` trigger |

## Q2 — Who chooses a customer's code?

The customers page document asks this itself (its open question 1). The code is shown on every
invoice, receipt, ledger and statement, and it is how Bhatti's staff find a customer today.

| | |
|---|---|
| **Option A — the user types it; it cannot change** (default) | Required on create, 2–20 characters of `A–Z 0–9 -`, stored upper-case, unique per tenant, immutable afterwards. Wave 10 migration can carry each legacy customer's existing code unchanged, so staff keep the codes they know. The user must invent a code for each new customer |
| **Option B — the system assigns it** (`C-000001`, …) | Nothing to type, and codes can never collide. Legacy codes then need a second field ("legacy code") in Wave 10, and staff would search by two codes during the transition. About half a day more in M3-C for a per-tenant non-fiscal-year sequence |
| **Council recommendation** | **A.** The migration of an existing business's customer list is the larger, later cost, and A makes it free. Documents reference customers by id either way (rule 17), so this is a question about what people see, not about integrity |
| **If B is chosen later** | Adding generated codes to a table that has typed ones is a forward migration and a form change. Nothing already posted changes |

---

## Referred elsewhere — not Product Owner questions

**To the Accounting seat — two posting-rule documents disagree on paying an inactive
customer.** [service-sale.md](../../posting-rules/service-sale.md) §11 says a customer deactivated
after an invoice posted *"can still be paid and reversed"*.
[customer-receipt.md](../../posting-rules/customer-receipt.md) §3 row 8 rejects a receipt for an
inactive customer (`CUSTOMER_INACTIVE`). This design follows **row 8**: it is the precondition
table, and it is the stricter of the two. The conflict rarely arises, because a customer with a
non-zero ledger balance cannot be deactivated (`CUSTOMER_HAS_BALANCE`, from the customers page
document). It can still arise after a receipt is reversed for a customer already deactivated,
and then the user reactivates the customer before recording the new receipt. Reversal is allowed
for an inactive customer under both documents. **Asked:** amend §11 to "can be reversed; to be
paid, the customer is reactivated", or state that row 8 exempts receipts against existing
invoices. The design changes only in `requireActiveForPosting`'s use in `RecordReceipt`.

**Recorded in [ui-plan.md](ui-plan.md), resolved by precedence (a LEVEL 1 or rule document beats
a page document):** the invoice detail page's "reversal into the first open period" contradicts
[reversal.md](../../posting-rules/reversal.md) §4. The rule wins, and the page document is
corrected in M4.

**Recorded in [README](README.md) §6, resolved by ADR-0027:** [ARCHITECTURE](../../ARCHITECTURE.md)
§2's per-module `ui/` layer contradicts `.dependency-cruiser.cjs` `web-is-ui-only`, which forbids
`apps/web` from importing `modules/**`. It went unnoticed because `modules/` has been empty.
