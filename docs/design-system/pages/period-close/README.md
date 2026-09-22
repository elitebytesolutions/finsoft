# Period close

| | |
|---|---|
| **Route** | `/period-close` |
| **Archetype** | G — Workbench (checklist) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · closing needs `period:close` (Owner / Accountant only) |
| **Prototype source** | `ui-prototype/src/trade-pages.tsx` (`PeriodClose`) |
| **Reference frame** | `ui-prototype/design/closing period page .png` |
| **Posts to the ledger** | no — but it **stops** everything else from posting |

## 1. Purpose

Lock a fiscal month so its figures cannot change. This is the highest-consequence action in the
product: after it, nothing can be posted into that period by any user, any job, any import or any
admin script.

## 2. Anatomy

```
PageHead    "Period close" · "Lock the fiscal month for posting — a pre-close checklist mirrors the
             legacy DATASECURE date lock." · [Close period]
KpiRow      Period revenue · Cost of sales · Net surplus · Open drafts
Grid        [ Pre-close checklist ]              [ Fiscal periods ]
              item · status · count · [Resolve]    Period · Opened · Status · Closed by
            [ What happens at close ]
              plain-language consequences
```

## 3. Components

`KpiRow` · `Checklist` (page-local, promotion candidate) · `DataTable` (period list) ·
`PeriodSelector` (G3) · `ConfirmDialog` (typed confirmation) · `Panel`.

## 4. Pre-close checklist

Each item is blocking or advisory, and each links to the screen that resolves it.

| Item | Blocking | Resolve at |
|---|---|---|
| Draft vouchers in the period | **yes** | `/vouchers?status=draft` |
| Draft purchases / sales | **yes** | the respective register |
| Unbalanced or suspense-account postings | **yes** | `/ledgers?account=suspense` |
| Bank accounts not reconciled | advisory | `/bank-book` |
| Cheques in clearing past maturity | advisory | `/cheque-clearing` |
| Stock count variances unposted | **yes** | `/inventory/count` |
| Depreciation / accrual templates not run | advisory | `/recurring` |
| Negative stock balances | **yes** | `/inventory` |

The `Close period` button is disabled while any blocking item is outstanding, and its tooltip names
the first one.

## 5. The close action

Confirmation is **typed**: the user types the period name (`Aug 2026`) to enable the confirm button.
The dialog states, in words:

> Closing **Aug 2026** prevents any further posting into this period — by any user, job, import or
> administrator. Existing entries remain. To correct a closed period you must post a reversing entry
> in an open period. This cannot be undone from the application.

## 6. Reopening

Reopening is **not an in-app action for any role**. If a tenant needs a period reopened, that is an
operational procedure with database-guardian and accounting-guardian involvement, recorded outside
the app. The UI states this instead of offering a control that would then have to be refused.

## 7. Financial rules on this page

- Closed periods reject postings from **every** path, including jobs, imports and admin scripts —
  there is no system bypass ([NON_NEGOTIABLES](../../../NON_NEGOTIABLES.md),
  [ADR-0012](../../../adr/ADR-0012-fiscal-period-locking.md)).
- Closing writes an audit record naming the user, timestamp and the period's closing figures.
- The KPI figures shown at close are snapshotted into that audit record so the close can be
  reconciled later.

## 8. States

- Not permitted: the page is readable, the close action is disabled with "Only the Owner and
  Accountant roles can close a period."
- Already closed: the period row shows `Closed` with who and when; the checklist is hidden.
- Close in flight: the whole page locks with a busy state — a half-closed period is not a state the
  UI ever shows.

## 9. Responsive · 10. Accessibility

`md` the two panels stack. The checklist is a real list with each item's status in text; the typed
confirmation field is labelled and its requirement is stated before the user types.

## 11. Open questions

1. Is there a **soft close** (locked for most roles, open for the accountant) before a hard close?
2. Does year-end close differ from month close in the UI (retained earnings roll-up)?
3. Which figures are snapshotted into the close audit record?
