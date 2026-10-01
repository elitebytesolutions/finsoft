# Receipt detail

| | |
|---|---|
| **Route** | `/receipts/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Accounting · view: `customer.view` · reverse: `payment.receive` + `voucher.reverse` (privileged — `PRIVILEGED_PERMISSIONS` in `packages/permissions/src/catalog.ts`) |
| **Prototype source** | none — new in M4-W2, no mock predecessor |
| **Posts to the ledger** | no — but it is where the one mutating action on a posted receipt lives: **Reverse** |
| **Backed by** | `modules/receivables` R4/R8, `docs/design/M3/api-contract.md` §4.3 |

## API note — M4-W2 (2026-10-01)

This route did not exist before M4-W2 — there is no mock version to port or deviate from.
`ReceiptDetail` (`apps/web/src/screens/detail-pages.tsx`) is self-contained: it fetches R4
(`GET /api/receipts/:id`) by the route id itself, same pattern as
[sales-invoice-detail](../sales-invoice-detail/) and `CustomerDetail`, and does its own
loading/forbidden/error/not-found handling — no `<Guard>`.

## 1. Purpose

The permanent, linkable record of one customer receipt: how much was received, by what method,
which invoices it paid down, and — once reversed — what undid it.

## 2. Anatomy

```
DocHeader     RCT-2027-000002 (h1) · [POSTED | DRAFT | REVERSED] · customer, receipt date
              [Reverse]  (posted only, and only with payment.receive + voucher.reverse)
KpiRow        Amount (+ method) · Allocations (count, "Invoices paid down") · Status (+ method)
DefinitionGrid Customer (name + code) · Status · Receipt date · Method ·
               Reference · Narration · Journal entry (links to /vouchers/:id, "—" if null)
AllocationsTable  "Allocations — Invoices this receipt paid down"
                  Invoice (links to /sales/:id) · Date · Amount · Status (LIVE | VOIDED)
```

## 3. Data

| Column | Align | Format |
|---|---|---|
| Invoice | left | `InvoiceAllocation`'s invoice number, links to `/sales/:id` |
| Date | left | the invoice's date, local format |
| Amount | right | `moneyFromString` on the server's decimal string — never summed or parsed here |
| Status | left | `Badge` — `good` for `LIVE`, `neutral` for `VOIDED` |

`journalEntry` renders "—" when `null`. This is a known gap (**TD-014**: `GET /receipts/:id` does
not yet return the posting entry), not eventual consistency from an outbox — no workaround
belongs here; the dash is the correct, honest state until TD-014 is closed.

## 4. Actions by status

| Status | Available |
|---|---|
| **POSTED** | `Reverse` (confirm + reason, `payment.receive` **and** `voucher.reverse`) |
| **DRAFT** | none — a banner states "This receipt is a draft. It has not been posted to the ledger." (drafts are edited from the New Receipt dialog on [payments-centre](../payments-centre/), not from this page) |
| **REVERSED** | none — a banner names the reversing entry and reason |

## 5. Reverse — the one mutating action here

Same reason-dialog pattern as [voucher-detail](../voucher-detail/#6-reverse--the-one-mutating-action-here)
and [sales-invoice-detail](../sales-invoice-detail/): a required, non-empty reason, an "I
understand this cannot be undone" checkbox, a fresh `Idempotency-Key` on confirm (R8,
`POST /api/receipts/:id/reverse`). On success the page re-renders **REVERSED**, with the
reversing entry's number and reason in a banner, and — on the invoice side — reversing a receipt
restores every allocated invoice's outstanding balance and clears whichever `reversalBlockedBy`
entry it was adding to that invoice's detail page.

Reverse is gated on **both** `payment.receive` and `voucher.reverse` (the latter privileged) —
matching the controller's `@RequirePermission` on R8 exactly; this is a UI affordance only, the
server re-checks under lock regardless.

## 6. States

- **Loading:** `"Loading receipt…"`, `role="status"`.
- **Forbidden:** `"Access restricted" / "Your role does not have permission to view receipts."`
- **Not found / other tenant:** the shared "Record not found" state.
- **Error (other):** the server's message, with a "Try again" retry.
- **Reversing in flight:** the reverse dialog's submit button is busy; the page is otherwise
  unchanged until it resolves.
- **Reverse failure:** the dialog stays open, the mapped error renders in it (see §7), the same
  `Idempotency-Key` is reused on retry.

## 7. Server error codes → UI treatment (reverse dialog)

Routed through the shared `apps/web/src/lib/adapters/receivables-errors.ts` mapper (the same one
[sales-invoice-detail](../sales-invoice-detail/), `/sales/voucher` and
[payments-centre](../payments-centre/) use).

| Code | Where it renders |
|---|---|
| `RECEIPT_NOT_POSTED` | Dialog banner — "Only a posted receipt can be reversed." |
| `ALREADY_REVERSED` | Dialog banner — "This has already been reversed." |
| `REVERSAL_REASON_REQUIRED` | Reason field, client-side already refuses an empty reason before the request is sent |
| `FORBIDDEN` | Global 403 handling (`client.ts`'s fixed contract) |
| `PERIOD_CLOSED`, `PERIOD_LOCKED` | Dialog banner, naming the closed period |

## 8. Financial rules on this page

- A posted receipt renders no inputs — read surface plus one button that opens a confirm-and-
  reason dialog, never an inline edit.
- Correction is by reversal only — there is no edit affordance on a posted or draft receipt from
  this page.
- Every figure (`Amount`, each allocation's `Amount`) is the server's own decimal string,
  formatted by `moneyFromString` — never parsed to a JS number or summed in the browser.
- The audit trail for the reversal (who, when, why) is the append-only audit record written in
  the same transaction as the reversal posting, not reconstructed here.

## 9. Responsive

Matches [voucher-detail](../voucher-detail/#10-responsive)'s pattern: `KpiRow` wraps at `md`;
`DefinitionGrid` 4 → 2 columns; the allocations table scrolls horizontally at `sm` with the
Invoice column sticky.

## 10. Accessibility

`h1` is the receipt number; the status badge is part of the document region's accessible name;
the reverse dialog restates the consequence as text, not colour alone; focus moves into the
dialog on open and returns to the `Reverse` button on close.

## 11. Deviations from the prototype

None — there is no prototype for this route.

## 12. Open questions

1. TD-014 (`journalEntry` null immediately after posting) — tracked against the API, not this
   page; no client-side workaround is planned.
