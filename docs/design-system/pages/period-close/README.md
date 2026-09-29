# Period close

| | |
|---|---|
| **Route** | `/period-close` |
| **Archetype** | G — Workbench (checklist) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · closing needs `period:close` (Owner / Accountant only) |
| **Prototype source** | `ui-prototype/src/trade-pages.tsx` (`PeriodClose`) |
| **Reference frame** | `ui-prototype/design/closing period page .png` |
| **Posts to the ledger** | no — but it **stops** everything else from posting |

## API note — M2-S (2026-09-29)

**§6 below ("Reopening is not an in-app action for any role") is superseded.**
[`periods.md`](../../../posting-rules/periods.md) §4, §7 and §8 — approved by the Accounting
Guardian the same day as this doc — specify **three** kernel transitions, all implemented in M2:
`close` (`OPEN → CLOSED`), `reopen` (`CLOSED → OPEN`, reason required), and `lock`
(`CLOSED → LOCKED`, terminal). This task's brief lists "Period close/reopen" as an M2 outcome, which
matches `periods.md`, not this page's current §6. The `§6` text stays below, struck through in
spirit rather than deleted, because it documents a real earlier decision that a later, more
authoritative doc reversed — worth keeping visible so nobody re-derives it. Treat this API note as
current; §6 as superseded.

| Transition | Allowed only when | Error | Real in M2? |
|---|---|---|---|
| Close period P | every earlier period is `CLOSED`/`LOCKED` | `PERIOD_CLOSE_OUT_OF_ORDER` | yes |
| Reopen period P | P is `CLOSED` and no **later** period is `CLOSED`/`LOCKED` | `PERIOD_REOPEN_OUT_OF_ORDER`; `PERIOD_LOCKED` if P is locked | **yes** |
| Lock period P | P is `CLOSED` and every earlier period is `LOCKED` | `PERIOD_LOCK_OUT_OF_ORDER`, `PERIOD_NOT_CLOSED` | yes, but no UI trigger is specified anywhere yet — locking is not part of this brief's scope; flagged as an open question (§11) rather than built |

**Reopen**, once wired: available only on the **latest `CLOSED`** period (periods.md §4.1 — reopening
any earlier one is out of order because a later period may already assume its closing balance is
final). The action asks for a **reason** (required — `PERIOD_REOPEN_REASON_REQUIRED`) and a typed
confirmation naming the period, mirroring the close dialog's severity. A `LOCKED` period's row shows
no reopen affordance at all — it is terminal for every role, not merely disabled.

**Permission catalogue gap — flagged, not worked around.** `periods.md` names `period.close` and
`period.reopen` as the permission codes throughout, but
`packages/permissions/src/catalog.ts`'s `PERMISSION_CODES` — frozen and exactly asserted in
`catalog.spec.ts` — **contains neither code**. This is a real contradiction between two documents
this lane cannot resolve (`packages/permissions` is outside `apps/web`'s `ALLOWED` paths, and the
catalogue is a Level-1 kernel-adjacent artifact). Reported to the delivery coordinator as BLOCKED.
Until it resolves, this page cannot hide Close/Reopen by role client-side with any real signal
either — same gap as every other M2-S screen's permission note.

**MFA.** `ADR-0012` requires MFA step-up for both transitions; MFA enrolment does not exist yet
(GAP-003), accepted on staging with demo data only, blocked in production. Not enforced or
simulated client-side.

**Pre-close checklist.** No M2 endpoint produces this checklist's line items (draft vouchers,
suspense postings, stock variances, etc. — most of those modules do not exist yet in M2: stock,
purchasing, cheques). The checklist section is **hidden** in M2, not fabricated from partial data —
`Close period` and `Reopen period` are gated only on the order rule and the typed confirmation, per
`periods.md` §7's actual MVP scope ("Close checklist... [is] Deferred"). The anatomy's
"What happens at close" plain-language panel stays, using the real consequence text from `periods.md`
and the dialog copy already in §5 below.

**KPI row** (period revenue, cost of sales, net surplus, open drafts): **hidden** in M2 — none of
those figures has a real source yet (no P&L endpoint, no drafts). Replaced with the real, always-true
fact this page needs: the tenant's **fiscal period list** (name, status, opened, closed-by) from
`GET`-ing the periods resource, which is real in M2 and is this screen's actual anchor.

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
