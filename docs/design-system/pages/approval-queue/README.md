# Approval queue

| | |
|---|---|
| **Route** | `/approvals` |
| **Archetype** | G — Workbench |
| **Module / permission** | Accounting · `Cash, Bank & GL` · posting needs the target document's action permission |
| **Prototype source** | `ui-prototype/src/control-pages.tsx` (`ApprovalQueue`) |
| **Posts to the ledger** | **yes** — approving posts the underlying document |

## 1. Purpose

Everything waiting on this user, in one list, with enough detail to decide without opening each
document. The approver's whole job is here.

## 2. Anatomy

```
PageHead   "Approval queue" · "Review and post what is waiting on you — draft vouchers, purchase
            orders and invoices." · [Refresh] [Approval rules]
KpiRow     Awaiting approval · Draft vouchers · Draft orders & invoices · Oldest item age
Panels     [ Draft vouchers ]         Voucher · Date · Type · Narration · Amount · [Review]
           [ Draft purchase orders ]  PO · Date · Supplier · Lines · Amount · [Review]
           [ Draft purchase invoices ]Purchase · Date · Supplier · Product · Amount · [Review]
Drawer     Review panel: document summary + line items + **ledger impact preview** + [Approve & post] [Send back]
```

## 3. Components

`KpiRow` · `Panel` + `DataTable` per work type · `Drawer` (review) · `LedgerImpactCard` ·
`ConfirmDialog` · `StatusBadge` · `AuditStamp`.

## 4. Rules that make this screen safe

- **No approval without sight of the entry.** The Review drawer shows the ledger impact preview
  before either action is enabled.
- **No bulk approve.** One document, one decision, one confirmation. A bulk action here would be a
  bulk financial misstatement.
- `Send back` requires a reason; the reason is written to the document's audit trail and shown to
  the originator.
- An approver cannot approve their own document when the tenant enables segregation of duties; the
  row shows `Created by you — needs another approver` and the action is disabled with that text.
- A document whose date falls in a closed period cannot be approved; the row says so and offers
  **Re-date into an open period** (which routes to the document, it does not re-date silently).

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Review | secondary (row) | read on the document | no | Opens the drawer |
| Approve & post | primary (drawer) | the document's post permission | **yes, with figures and period** | Posts; row leaves the queue; toast names the document |
| Send back | danger (drawer) | approver | **yes, reason required** | Status returns to Draft with the reason recorded |
| Approval rules | secondary | `Admin & Control` | no | `/settings` approval rules |

## 6. States

- Empty: "Nothing is waiting on you." with the count of items waiting on others.
- KPI counts must equal panel rows.
- Stale: the queue refreshes on focus; if another approver acted first, the row shows
  "Already actioned by S. Ali" and disappears on the next refresh rather than failing on click.

## 7. Financial rules on this page

Approval **is** posting. Every rule that applies to posting applies here: confirmation, idempotency,
closed-period refusal, audit record in the same transaction, no edit after the fact.

## 8. Responsive · 9. Accessibility

`md` panels stack, drawer becomes a sheet · `xs` rows become cards. The drawer is focus-trapped;
the approve button's accessible name includes the document number and amount.

## 10. Open questions

1. Are approval thresholds by amount, by document type, or both — and who configures them?
2. Is multi-step approval (maker → checker → approver) in MVP scope?
3. Do approvers get notified out of band (email, WhatsApp), and does that change the UI?
