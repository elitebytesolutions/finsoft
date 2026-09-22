# Design principles

Eight principles. Each one says what it forbids, because a principle that forbids nothing decides nothing.

---

## 1. The number is the interface

Figures are the product. Everything else is navigation to a figure.

- Every monetary column is **right-aligned**, tabular-lining, and carries its unit in the column
  header (`Debit (Rs)`), never in each cell.
- Debit and credit are **separate columns**, never one signed column, on any ledger, voucher,
  trial balance or statement surface.
- A running balance column is always the **last** money column and is visually distinguished
  (teal `--money-balance`), because it is derived, not posted.

**Forbidden:** centre-aligned money · money with mixed decimal places in one column · a single
"Amount ±" column on an accounting surface · abbreviating figures (`3.4M`) anywhere a user could
reconcile from the screen. Abbreviation is permitted **only** inside a chart axis label.

## 2. Posted looks posted

Immutability is a Level 0 rule ([NON_NEGOTIABLES](../NON_NEGOTIABLES.md)). The UI's job is to make
that visible *before* the API refuses.

- A posted document renders as **read-only surfaces** — text, not inputs. Never a disabled input.
- The only mutating actions offered on a posted record are **Reverse** and **Copy to new**.
- Status is shown twice on a document: in the document header badge and next to the primary action.

**Forbidden:** an Edit button on a posted record, even disabled with a tooltip · inputs that look
editable and fail on save · "Save" copy on anything that reverses.

## 3. Posting is a decision, not a click

- Post, Reverse, Close period, Delete master and Void cheque all require an explicit
  **confirmation step** that restates the financial consequence in words and figures
  ("This posts 4 lines totalling Rs 891.55 to period Sep 2026. Posted entries cannot be edited.").
- Draft-first: every entry screen offers **Save draft** (secondary) beside **Save & post** (primary).
- Post buttons show a busy state and are **idempotency-safe**: the UI disables on submit and the
  request carries the client-generated idempotency key, so a double click cannot produce two entries.

**Forbidden:** posting from a row action without confirmation · a bulk "post all" without a
per-document preview · any UI that retries a failed post automatically.

## 4. The AI suggests; the human posts

Any AI-assisted affordance (suggested account, suggested match, anomaly flag) renders as a
**suggestion chip** with an explicit accept action and a visible "AI suggested" marker.
It never pre-fills a posting field silently and never triggers a mutation.

**Forbidden:** an AI action that submits · a suggestion indistinguishable from user input.

## 5. One job, one archetype

Nine archetypes cover the whole product ([03-patterns](03-patterns.md)). A new screen picks one
and follows its anatomy. Visual novelty on a finance screen is a cost, not a feature.

**Forbidden:** a bespoke layout for a job an archetype already covers · a second "list page"
shape · two different filter bars.

## 6. Density with air

This is a professional data tool used all day at 1440–1920px. Rows are compact (44px), but
every block is separated by real space and lives on a white card.

- Content density is **high inside a card**, generous **between cards**.
- Never below the minimum touch/click target: 32px for a row action, 37px for a button.

**Forbidden:** zebra striping (use row hover + borders) · shrinking body text below 12px to fit
more columns — hide or virtualise columns instead.

## 7. State is never silent

Every surface declares loading, empty, error, permission-denied, period-locked and stale.
An empty table says *why* it is empty and what to do.

**Forbidden:** a blank card · a spinner with no context · an error that says "Something went wrong"
with no reference the user can quote to support.

## 8. Tenant and period are always on screen

The active company and the active fiscal period are visible on every screen — company in the top
bar, period in the page header or filter bar. A user must never have to guess whose books they
are looking at.

**Forbidden:** a report, export or print that omits company, period and generated-at.
