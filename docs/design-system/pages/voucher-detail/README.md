# Voucher detail

| | |
|---|---|
| **Route** | `/vouchers/:id` |
| **Archetype** | C — Document detail |
| **Module / permission** | Accounting · view: `voucher.view` · reverse: `voucher.reverse` (privileged — `PRIVILEGED_PERMISSIONS` in `packages/permissions/src/catalog.ts`; ADR-0009 requires MFA before a grant of it is effective, but MFA enforcement itself is deferred, GAP-003) |
| **Prototype source** | `apps/web/src/screens/vouchers.tsx` (`VoucherDetail`) — mock-data version, being converted in place per M2-S |
| **Reference frame** | inspector panel of `design/voucher register improved page .png` — shows a richer document than M2 supports; layout inspiration only |
| **Posts to the ledger** | no — but it is where the one mutating action on a posted voucher lives: **Reverse** |
| **Backed by (M2)** | `docs/posting-rules/journal-voucher.md`, `docs/posting-rules/reversal.md`. No `docs/design/M2/api-contract.md` published yet |

## API note — M2-S (2026-09-29)

Rewritten in full for M2, for the same reason noted on
[voucher-new](../voucher-new/#api-note--m2-s-2026-09-29): the gap between the prototype's
aspiration (drafts, approvals, attachments, comments) and what `journal-voucher.md` and
`reversal.md` actually specify is large enough that a delta note would obscure more than it
clarified. Every section below reflects the real posting rules. Cross-referenced from
[voucher-register](../voucher-register/#api-note--m2-s-2026-09-29) by this anchor.

## 1. Purpose

The permanent, linkable record of one journal entry. In M2 every entry here is either a manual JV
(`JOURNAL_VOUCHER_POSTED`) or a reversal of one (`REVERSAL@1`) — there is no other source document
type yet.

## 2. What this screen is NOT, in M2

No draft, no "pending approval", no "approve & post", no "send back", no "cancel", no edit, no
attachments, no comments thread, no "copy to new" (not specified by any posting rule), no branch /
department / approved-by fields (`journal-voucher.md` §2 carries none of these). A posted voucher
in this system has exactly two states worth showing: **Posted** and **Reversed** (plus, for a
reversal entry itself, a "this is a reversal of JE-…" fact).

## 3. Anatomy (M2)

```
Breadcrumbs   Accounting > Vouchers > JV-2027-000001
DocHeader     JV-2027-000001 (h1) · [Posted | Reversed] · Rs 3,250.0000
              [Reverse]  (posted, non-reversal entries only) · [Print]
DefinitionGrid  Voucher date · Reference · Narration · Created by · Created at ·
                Reversed by / Reversed at + reason (if reversed) ·
                Reverses JE-… + reason (if this entry is itself a reversal)
LineTable     "Journal lines" — # · Code · Account · Memo · Debit (PKR) · Credit (PKR)
              + totals row + difference (always 0.0000, muted)
AuditStamp    who posted it, when — the append-only audit record's projection
```

## 4. Data

| Column | Align | Format |
|---|---|---|
| # | right | line ordinal |
| Code | left | account code, tabular |
| Account | left | account name, links to `/finance/accounts/:code` |
| Memo | left | line memo; em dash when absent |
| Debit (PKR) | right | `DebitCreditCell` / `--money-debit`, em dash when nil |
| Credit (PKR) | right | `DebitCreditCell` / `--money-credit`, em dash when nil |

The totals row is always rendered; Difference is always `0.00` in `--muted` — a voucher that failed
to balance was never posted, so a detail page can never show a non-zero difference. If one is ever
seen, that is a data-integrity incident, not a UI state to design for.

## 5. Actions by status

| Status | Available |
|---|---|
| **Posted**, not itself a reversal | `Reverse` (confirm, `voucher.reverse`) · `Print` — **no edit, no delete** |
| **Reversed** | `Print` · banner linking to the reversing voucher (`RV-2027-…`), reason shown |
| Is itself a reversal (`R`) | `Print` only — **no Reverse button at all**: `reversal.md` §6, reversing a reversal is rejected outright (`REVERSAL_OF_REVERSAL`); the button is not rendered rather than rendered-then-refused |

There is no "Pending approval" row and no "Draft" row — those statuses do not exist for a JV in M2
(§9 of `journal-voucher.md`: single-step post).

## 6. Reverse — the one mutating action here

Opens a dialog, not an inline action:

1. **Reason** — required, non-empty after trimming, ≤ 500 characters (`reversal.md` §3 rule 5,
   `REVERSAL_REASON_REQUIRED`).
2. States the consequence in words, matching `reversal.md` §4's actual date policy rather than a
   generic warning:
   - If this voucher's period is still **open**: "The reversal will be dated <same date>, in the
     same period. Both entries remain in the ledger permanently."
   - If this voucher's period is **closed or locked**: "This voucher's period (<period>) is closed.
     The reversal will be dated today, <today's date>, in the current open period. <period>'s
     figures will not change."
3. Confirm posts through `POST /vouchers/:id/reverse` (path indicative — pending the M2-B contract)
   with a fresh `Idempotency-Key`, the reason, and nothing else — the client never chooses the
   reversal's date or period (`reversal.md` §4: "not a user choice").
4. On success: the page re-renders showing this voucher as `Reversed`, with a link to the new
   reversing voucher `RV-2027-…`, and offers to open it.

Reverse is **not offered at all** (button absent, not disabled) when:
- the voucher is already `Reversed` (`ALREADY_REVERSED`),
- the voucher is itself a reversal (`REVERSAL_OF_REVERSAL`),
- the caller's role structurally cannot hold `voucher.reverse` — cannot be known client-side today
  (see BLOCKED note in the chart-of-accounts and period-close docs about permissions not reaching
  the client yet); until that lands, the button is shown to any signed-in user and a `FORBIDDEN`
  response from the server is treated like any other rejection — the button disappears from view,
  the reason dialog is discarded, and the user is told they do not have permission, without a full
  redirect to `/unauthorized` if avoidable (that redirect is the *fixed*, product-wide 403 contract
  from `client.ts`, so in practice it will fire; noted here so it isn't mistaken for a bug).

## 7. States

- **Not found / other tenant:** the shared "Record not found" state, indistinguishable between the
  two (server never reveals which).
- **Closed period, entry not itself in it:** no special state — Reverse is always offered on an
  eligible posted entry; the dialog's wording (§6) is what changes, not availability.
- **Reversing in flight:** the header shows a busy state, `Reverse` is disabled, the page is
  otherwise read-only until it resolves.
- **Reverse failure:** the dialog stays open, the server's error renders verbatim (mapped from
  `reversal.md` §11's codes to the reason field or a dialog banner), nothing changes, the same
  `Idempotency-Key` is reused if the user retries the same attempt.

## 8. Financial rules on this page

- A posted voucher renders **no inputs at all** — this is a read surface with exactly one button
  that opens a confirm-and-reason dialog, never an inline edit affordance.
- Correction is by **reversal and re-entry only**. There is no "copy to new" shortcut specified by
  any posting rule; if the product wants one later, it composes from `/vouchers/new` pre-filled by
  reading this entry's lines — a UI convenience, not a new posting capability, and out of scope
  until requested.
- The reversal's date is server-decided, never a field the user fills in (§6).
- The audit stamp is a read-only projection of the append-only audit record written in the same
  transaction as the posting or the reversal.

## 9. Server error codes → UI treatment (reverse dialog)

From `reversal.md` §11.

| Code | Where it renders |
|---|---|
| `REVERSAL_REASON_REQUIRED` | Reason field |
| `ENTRY_NOT_FOUND` | Dialog banner — should not occur (the page loaded this entry); treat as stale data, offer reload |
| `ALREADY_REVERSED` | Dialog banner, naming the existing reversal; refresh the page state to show it |
| `REVERSAL_OF_REVERSAL` | Should not occur — the button isn't rendered for a reversal entry; if seen, it means client state is stale |
| `REVERSAL_VIA_SOURCE_REQUIRED` | Dialog banner — "This entry belongs to a document; reverse it from there." Only reachable once document-sourced entries exist (post-M2) |
| `FORBIDDEN` | Global 403 handling (§6) |
| `PERIOD_CLOSED`, `PERIOD_LOCKED`, `PERIOD_NOT_FOUND` | Dialog banner — only reachable if *today's* period is closed, an edge case (`reversal.md` §10) |
| `IDEMPOTENCY_KEY_REUSED` | Dialog banner, client-bug case |

## 10. Responsive

`md` `DefinitionGrid` 4 → 2 columns · `sm` line table scrolls with `#` sticky · `xs` lines become
stacked cards with Dr/Cr labelled inline.

## 11. Accessibility

`h1` is the voucher number; the status badge is part of the accessible name of the document region;
the reverse dialog restates the consequence as text, not colour; focus moves into the dialog on
open and returns to the `Reverse` button on close.

## 12. Deviations from the prototype

The prototype allows a status change (`Post & approve`, `Cancel voucher`) through row actions, has
an attachments panel and a comments thread. None of that exists against the real API. The only
mutating action in M2 is Reverse.

## 13. Open questions

1. Exact endpoint path/method for reverse — pending the M2-B contract (`POST /vouchers/:id/reverse`
   assumed, not confirmed).
2. Print: deferred — browser print of the rendered page is a reasonable placeholder since it needs
   no endpoint, but a dedicated print layout is not specified anywhere and is out of scope for M2.
