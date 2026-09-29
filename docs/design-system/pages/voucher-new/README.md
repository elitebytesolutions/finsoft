# New Voucher (manual journal voucher)

| | |
|---|---|
| **Route** | `/vouchers/new` |
| **Archetype** | B — Document entry |
| **Module / permission** | Accounting · `voucher.post` (real RBAC code — `packages/permissions/src/catalog.ts`; the previous `voucher:create` was never a real permission) |
| **Prototype source** | `apps/web/src/screens/vouchers.tsx` (`VoucherForm`) — mock-data version, being converted in place per M2-S |
| **Reference frames** | `design/voucher-creation-page.png`, `single entry voucher .png`, `bulk entry voucher .png` — all show a richer form than M2 supports; treat as inspiration for layout only, not as a field spec |
| **Posts to the ledger** | **yes** — directly, via `JOURNAL_VOUCHER_POSTED` (`docs/posting-rules/journal-voucher.md`) |
| **Backed by (M2)** | `docs/posting-rules/journal-voucher.md`. No `docs/design/M2/api-contract.md` published yet — the endpoint path and exact request/response envelope are not fixed; field names below come from the posting rule's payload shape (§2 of that document), not from a confirmed wire contract |

## API note — M2-UI (restoration)

Restored to the prototype's chrome (voucher-type preset cards, `vn-head`/`vn-card` sections, the
richer entries table with Code and Cost Center columns, attachments dropzone, additional-info
panel, Save-as-template switch, Save Draft button) wrapped around M2-S's exact, tested form logic
and JSX for the entries table itself — `computeVoucherTotals`, the idempotency-key controller,
the confirm-before-post `PostConfirmDialog`, and the POST body construction are byte-identical,
because `tests/voucher-new.test.tsx` pins the exact aria-labels (`Account line N`, `Debit line N`
etc.) and the exact request shape. What is new chrome only, never wired to the request:

- The six voucher-type preset cards (Journal/Cash Payment/Cash Receipt/Bank Payment/Bank
  Receipt/More) are a label-only convenience — every submission posts the same generic Journal
  Voucher (`JOURNAL_VOUCHER_POSTED`); there is no server-side type to select.
- Branch, Department, Prepared By, Approved By, Cost Center, Attachments, Tags, Comments and
  "Save as template"/"Save Draft" have no backing field in `PostJournalRequest` (single-step
  post, no draft, journal-voucher.md §1) — every one renders `disabled`, titled "Coming soon",
  never sent to the server.

## API note — M2-S (2026-09-29)

This document has been rewritten in full for M2 rather than appended-to, because the gap between
the prototype's aspiration and what `journal-voucher.md` actually specifies is large enough that a
delta note would be harder to read than the whole page. Every section below (not just this one)
reflects the real posting rule. Cross-referenced from
[voucher-register](../voucher-register/#api-note--m2-s-2026-09-29) and elsewhere by this anchor.

## 1. Purpose

Record a manual journal entry — the *only* voucher type M2 supports. Accruals, adjustments,
corrections, the demo tenants' opening capital. In the MVP **this is the voucher**: there is no
draft table and no approval step. Submitting a balanced, valid form posts it.

## 2. What this screen is NOT, in M2

The prototype's `VoucherForm` supports six voucher types (JV/CRV/CPV/BRV/BPV/CV), branch,
department, an approver, attachments, "save as template", "import from template" and a "save
draft" path that leaves the voucher unposted. **None of this exists in the real system yet:**

- Only `type = JV` is real. CRV/CPV/BRV/BPV/CV are cash/bank/contra vouchers — separate modules,
  none built in M2. The type-card row is either removed or the other five cards are disabled with
  "Coming later — cash and bank vouchers post through their own screens once built."
- No branch, department, cost centre or approver field — `journal-voucher.md` §2's payload has none
  of these. PKR only, no currency field (§10).
- No draft: `journal-voucher.md` §1, "the voucher is submitted and posted in one request... The
  journal entry *is* the voucher." There is no "Save draft" button.
- No attachments (§10: "Not in the MVP").
- No templates, no "save as template", no bulk CSV rows.

## 3. Anatomy (M2)

```
Breadcrumbs   Accounting > Vouchers > New
PageHead      "New Journal Voucher" · auto-number placeholder ("Assigned on post")
FormSection   Voucher date (≤ today) · Reference (optional, ≤100 chars) · Narration (required, ≤500)
DrCrGrid      # · Account (postable only, AccountPicker) · Memo (optional) ·
              Debit (PKR) · Credit (PKR) · ✕            [+ Add line]
TotalsBar     Total Debit · Total Credit · Difference · line count      (sticky)
```

## 4. Components

`Field` / `TextInput` (kit) · `AccountPicker` (kit — filtered to `POSTABLE`, active, non-control,
non-restricted accounts per §6 below) · a money-input built on the kit's numeric input pattern ·
`FormErrorSummary` (page-local until promoted) · `ConfirmDialog`. No `Stepper`, no mode switch
(single/multi-line/bulk are all the same real form — a UI convenience the prototype offered that
adds no value once only one path exists), no `AttachmentList`, no `PeriodSelector` as a separate
control (the date field alone determines the period — the client never names a period,
`journal-voucher.md` §6).

## 5. Lines — exactly the payload shape

Each line carries **exactly one** of `debit` or `credit` (`journal-voucher.md` §2). The UI must not
let a line hold both, or neither, non-zero. At least 2 lines, at most 200.

The account picker only offers accounts that satisfy `journal-voucher.md` §3 rows 7–10: `POSTABLE`,
active, not a control account (AR 1200, AP 2100, Inventory 1300), not restricted (Retained Earnings
3200, COGS 5100, Rounding 6900 — `coa-standard.md` §3). Filtering the picker is a UX convenience,
not the control — the server re-validates every line regardless.

## 6. Validation — post is blocked client-side until all are true

Client-side checks exist for fast feedback only; the server re-validates everything and its
rejection is the truth (CLAUDE.md, "Forms").

- At least 2 lines, at most 200.
- Every line has exactly one non-zero side (no zero line — `JV_ZERO_LINE`).
- No account appears on both the debit side and the credit side (`JV_SAME_ACCOUNT_BOTH_SIDES`).
- **Total debit equals total credit exactly**, computed with `@finsoft/validation`'s `Money` (never
  JS number arithmetic) — the difference figure sits in the totals bar until it is `0.0000`. The
  post button stays disabled until this holds; the server still enforces `JV_UNBALANCED`
  independently.
- Narration non-empty after trimming, ≤ 500 characters.
- Voucher date ≤ today (tenant timezone) — a future date is refused client-side before submit with
  the same message the server would give (`DATE_IN_FUTURE`), but the client's clock is never
  authoritative; the server computes "today".

The grid never auto-inserts a balancing line (`journal-voucher.md` §3, "Why these rules" — the
kernel refuses to "auto-correct", and neither does this form).

## 7. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Post | primary | `voucher.post` | **yes** — restates "Post N lines totalling Rs X to <date>? Posted entries cannot be edited." | Posts; toast with the server-assigned voucher number; routes to `/vouchers/:id` |
| Add line / Remove line | inline | — | remove below 2 lines is disallowed | — |

There is no "Save draft", no "Save & post" split, no "Import from template" menu, no "Save as
template" switch — see §2.

## 8. States

- **Closed period selected:** post is disabled once the date resolves to a closed/locked period;
  the message names the period, per `journal-voucher.md` §10 and §3 row 14 (`PERIOD_CLOSED`,
  `PERIOD_LOCKED`). There is no "draft saving still allowed" fallback — there is no draft.
- **Unsaved changes:** navigation prompt (pure UI convenience, no business rule).
- **Post failure:** the server's rejection is rendered verbatim, mapped by error code (§9) to the
  field or the form banner; nothing posted; the same `Idempotency-Key` is reused automatically on
  retry of the same submission (§10).
- **No confirmation received (network):** the "check status" pattern from `04-states.md` §10 —
  never blind-retry a POST that may have succeeded.
- **Account deactivated between form load and submit:** `ACCOUNT_INACTIVE` surfaces at the specific
  line.

## 9. Server error codes → UI treatment

All from `journal-voucher.md` §11.

| Code | Where it renders |
|---|---|
| `NARRATION_REQUIRED`, `NARRATION_TOO_LONG` | Narration field |
| `JV_TOO_FEW_LINES`, `JV_TOO_MANY_LINES` | Form banner |
| `AMOUNT_SCALE`, `AMOUNT_NEGATIVE`, `AMOUNT_OUT_OF_RANGE`, `AMOUNT_NOT_STRING` | The offending line's amount cell |
| `JV_LINE_BOTH_SIDES`, `JV_LINE_NO_SIDE`, `JV_ZERO_LINE` | The offending line |
| `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_INACTIVE`, `ACCOUNT_CONTROL_MANUAL_FORBIDDEN`, `ACCOUNT_RESTRICTED` | The offending line's account cell |
| `JV_SAME_ACCOUNT_BOTH_SIDES` | Both offending lines, highlighted together |
| `JV_UNBALANCED` | Totals bar — the server's stated difference replaces the client's computed one |
| `DATE_IN_FUTURE` | Date field |
| `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`, `PERIOD_LOCKED` | Date field + form banner naming the period |
| `IDEMPOTENCY_KEY_REUSED` | Form banner — this indicates a client bug (a key reused for different content), not a user error; report it, don't ask the user to fix anything |
| `PAYLOAD_INVALID` | Form banner (should not occur if the form's own validation matches the schema) |

## 10. Financial rules on this page

- The module raises a financial event; it **never constructs journal lines itself** beyond
  assembling the user's entered rows into the payload shape.
- Document number comes from the server — the field reads "Assigned on post" until the response
  returns it. Numbering is per tenant, per fiscal year of the voucher date: `JV-2027-000001`
  (`journal-voucher.md` §6).
- **Idempotency:** one `Idempotency-Key` (client-generated UUID) per form instance, generated once
  on mount and reused for every submit attempt of that instance — including the retry after a
  network failure. A fresh key is generated only when the user starts a genuinely new voucher
  (navigating to `/vouchers/new` again). Three identical submissions produce one journal entry
  (`journal-voucher.md` §7).
- An append-only audit record is written server-side in the same transaction as the posting; this
  screen does not write it and does not need to render it (the resulting detail page does).
- Only level-4 postable, active, non-control, non-restricted accounts are selectable.

## 11. Responsive · 12. Accessibility

`md` form sections stack, grid scrolls horizontally with the account column sticky · `sm` and below
the screen is **read-only** with a "continue on a desktop" notice.

The grid is a real table with column headers; `Tab` traverses cells, `Enter` on the last cell adds
a row; the running difference is announced via `aria-live="polite"`; the error summary takes focus
on a failed submit.

## 13. Deviations from the prototype

The prototype supports six voucher types, branch/department/approver, attachments, templates and a
draft/post split. The real M2 screen supports one voucher type (JV), no draft, no approval, no
attachments, no templates. This is not a design preference — it is what `journal-voucher.md`
specifies exists. Re-adding any of the removed surface is a new posting rule, not a UI task.

## 14. Open questions

1. Confirmed by `journal-voucher.md` §9 (PO-Q2): no maker–checker in M2. This closes what was open
   question 1 previously (approval step).
2. Multi-currency: confirmed **no** (§10).
3. Exact endpoint path/method and response envelope — pending the M2-B contract.
