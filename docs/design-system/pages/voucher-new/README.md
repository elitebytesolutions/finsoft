# New Voucher (journal entry)

| | |
|---|---|
| **Route** | `/vouchers/new` |
| **Archetype** | B — Document entry |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `voucher:create` |
| **Prototype source** | `ui-prototype/src/vouchers.tsx` (`VoucherForm`) |
| **Reference frames** | `design/voucher-creation-page.png`, `single entry voucher .png`, `bulk entry voucher .png` |
| **Posts to the ledger** | **yes** — the most direct posting surface in the product |

## 1. Purpose

Record a manual journal entry: accruals, adjustments, opening balances, contra entries, corrections
that are not produced by a sales, purchase or payment document.

Because it posts directly to the ledger, this screen carries the strictest guard rails in the
product.

## 2. Anatomy

```
Breadcrumbs   Accounting > Vouchers > New
DocHeadBar    "New Voucher" · [Import from template v] [Save draft] [Save & post]
DocNumberStrip  Voucher no (Auto) · Voucher type · Voucher date · Posting date · Reference · Branch
FormSection   "Voucher Details"      : type, dates, reference, branch/cost centre
              "Additional Information": narration (full width), tags
Mode switch   [ Single entry | Multi-line (Dr/Cr) | Bulk rows ]
DrCrGrid      # · Account · Description/narration · Cost centre · Debit (PKR) · Credit (PKR) · ✕
              [+ Add line]  [Clear all]
TotalsBar     Total Debit · Total Credit · **Difference** · line count     (sticky)
Attachments   drag-and-drop, drafts only
LedgerImpactPreview  "Preview — not yet posted"
```

## 3. Components

`Stepper` (not used — this is a single-surface form) · `FormSection` (C9) · `DrCrGrid` (C8) ·
`AccountPicker` (C5, postable accounts only) · `MoneyInput` (C3) · `DateField` ·
`PeriodSelector` (G3) · `IdempotencyGuard` (G5) · `FormErrorSummary` · `ConfirmDialog` ·
`AttachmentList`.

## 4. Entry modes

| Mode | Use | Grid |
|---|---|---|
| Single entry | One debit, one credit | Two fixed rows: Dr account, Cr account, one amount |
| Multi-line | Normal journal | Full `DrCrGrid`, unlimited lines |
| Bulk rows | Repetitive entries (salaries by employee) | Paste-friendly grid with a shared contra account |

All three produce the same journal; the mode is a data-entry convenience only.

## 5. Validation — post is blocked until all are true

- At least two lines.
- Every line has a **postable** account and a non-zero amount on exactly one side.
- Total debit equals total credit — the difference figure sits in the totals bar in
  `--money-negative` until it is `0.00`.
- Voucher date falls in an **open** period.
- Narration present (voucher level or every line).
- The role holds `voucher:create`.

Each failure is stated in the post button's tooltip and in the `FormErrorSummary`. The grid never
auto-inserts a balancing line.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save draft | secondary | `voucher:create` | no | Draft; no ledger effect; `Saved HH:MM` |
| Save & post | primary | `voucher:create` | **yes** | "Post 4 lines totalling Rs 891.55 to Sep 2026? Posted entries cannot be edited." → posts → toast with the voucher number → routes to `/vouchers/:id` |
| Import from template | split menu | `voucher:create` | no | Pre-fills lines from a recurring template |
| Add line / Clear all | inline | — | Clear all: yes | — |

## 7. States

- Closed period selected → `PeriodLockedBanner`, post disabled, **draft saving still allowed**.
- Unsaved changes → navigation prompt.
- Post failure → error banner naming the failure, form stays populated, nothing posted, the same
  idempotency key is reused on retry.
- No confirmation received (network) → the "check status" flow from [04-states §10](../../04-states.md).

## 8. Financial rules on this page

- The module raises a financial event; it **never constructs journal lines itself**.
- Document number comes from the server — the field reads `Auto` until it is issued.
- Idempotency: one key per form instance; three clicks produce one journal entry.
- An append-only audit record is written in the same transaction as the posting; the UI shows it on
  the resulting detail page.
- Only level-4 postable accounts are selectable.

## 9. Responsive · 10. Accessibility

`md` form sections stack, grid scrolls horizontally with the account column sticky ·
`sm` and below the screen is **read-only** with a "continue on a desktop" notice — a multi-line
journal is not a phone task.

The grid is a real table with column headers; `Tab` traverses cells, `Enter` on the last cell adds a
row; the running difference is announced via `aria-live="polite"`; the error summary takes focus on
a failed submit.

## 11. Deviations from the prototype

The prototype's grid permits an unbalanced save and warns after the fact. Production disables the
post action until the difference is zero and explains why.

## 12. Open questions

1. Is a per-line cost centre required, or a voucher-level one?
2. Do we support multi-currency journal lines in MVP? (Assumed **no**.)
3. Does "Bulk rows" need CSV paste, and what validation does pasted data get?
