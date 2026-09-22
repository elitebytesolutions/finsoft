# Voucher detail

| | |
|---|---|
| **Route** | `/vouchers/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Accounting · `Cash, Bank & GL` |
| **Prototype source** | `ui-prototype/src/vouchers.tsx` (`VoucherDetail`) |
| **Reference frame** | inspector panel of `design/voucher register improved page .png` |
| **Posts to the ledger** | **yes** — post a draft, reverse a posted voucher |

## 1. Purpose

The permanent, linkable record of one voucher. This is what an auditor opens, what a user prints,
and what a support conversation quotes.

## 2. Anatomy

```
Breadcrumbs        Accounting > Vouchers > JV-2026-0419
DocHeader          JV-2026-0419 (h1) · [Posted] · Journal Voucher · Rs 3,250 Dr
                   [Reverse] [Print] [Copy to new] [More v]
PostingStatusStrip Draft > Submitted > Posted > (Reversed)
DefinitionGrid     Voucher type · Voucher date · Posting date · Reference · Branch / cost centre ·
                   Narration · Created by · Posted by · Posted on · Approvals
LineTable          "Voucher Entries" — # · Code · Account · Description / narration ·
                   Cost centre · Debit (PKR) · Credit (PKR)   + totals + difference row
TotalsStrip        Total debit · Total credit · Difference (must be 0.00)
Attachments        file · size · uploaded by · uploaded on · download
AuditStamp + Timeline
```

## 3. Components

`DocHeader` · `PostingStatusStrip` (G4) · `DefinitionGrid` (D6) · `DataTable` (read-only lines) ·
`DrCrAmount` (G1) · `AuditStamp` (G6) · `Timeline` (D9) · `AttachmentList` · `ConfirmDialog` ·
`PrintDocument` (D12).

## 4. Data

| Column | Align | Format |
|---|---|---|
| # | right | line ordinal |
| Code | left | account code, tabular |
| Account | left | account name, links to the ledger filtered to this voucher's date |
| Description / narration | left | line narration; falls back to the voucher narration in `--muted` |
| Cost centre | left | chip or em dash |
| Debit (PKR) | right | `--money-debit`, em dash when nil |
| Credit (PKR) | right | `--money-credit`, em dash when nil |

The totals row is always rendered, even for a two-line voucher, and the **Difference** figure is
always shown — `0.00` in `--muted` when balanced.

## 5. Actions by status

| Status | Available |
|---|---|
| Draft | `Post` (primary, confirm) · `Edit` (routes to `/vouchers/new?id=`) · `Cancel` (danger, confirm) · `Print` |
| Pending approval | `Approve & post` (confirm, `voucher:approve`) · `Send back` (confirm, with a reason) · `Print` |
| **Posted** | `Reverse` (confirm) · `Copy to new` · `Print` · `Export` — **no edit, no delete** |
| Reversed | `Print` · `Copy to new` · banner linking to the reversing voucher |
| Cancelled | `Copy to new` · `Print` · banner stating who cancelled and when |

## 6. States

- Not found / other tenant → the shared **Not found** state, indistinguishable from each other.
- Closed period: `Reverse` is disabled with "September 2026 is closed — reverse into an open
  period" and the reverse dialog defaults the reversal date to the first open period.
- Posting in flight: the header shows a busy state and the page is read-only until it resolves.

## 7. Financial rules on this page

- A posted voucher renders **no inputs at all** — `DefinitionGrid`, never disabled fields.
- Correction is by **reversal and re-entry**. The reverse dialog states the reversing date, the
  period, and that both vouchers remain in the ledger permanently.
- The audit stamp and timeline are read-only projections of the append-only audit record written in
  the same transaction as the posting.
- Attachments can be added to a draft only; a posted voucher's attachment set is frozen.

## 8. Responsive

`md` `DefinitionGrid` 4 → 2 columns, totals strip becomes a card · `sm` line table scrolls with `#`
sticky · `xs` lines become stacked cards with Dr/Cr labelled inline.

## 9. Accessibility

`h1` is the voucher number; the status badge is part of the accessible name of the document region;
the difference figure is in an `aria-live` region so that assistive users hear it change; the
reverse dialog restates the consequence as text, not colour.

## 10. Deviations from the prototype

The prototype's detail page allows a status change through a row action. Production routes every
status change through a confirm dialog that shows the ledger consequence.

## 11. Open questions

1. Does reversal reuse the original voucher's narration with a prefix, or require a reason?
2. Do we need a "linked documents" section (invoice → receipt → voucher) on every type?
3. Print: one layout for all voucher types, or per-type layouts?
