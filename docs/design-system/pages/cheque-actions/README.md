# Cheque exceptions (dishonoured & void)

| | |
|---|---|
| **Route** | `/cheque-actions` |
| **Archetype** | A — Register (two tabs) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · `voucher:reverse` |
| **Prototype source** | `ui-prototype/src/cheque-actions.tsx` (`ChequeActions`) |
| **Reference frame** | `ui-prototype/design/dishonoredvoid cheques.png` |
| **Posts to the ledger** | **yes** — marking a cheque dishonoured or void posts a reversal |

## 1. Purpose

Handle the two ways a cheque fails: a **received** cheque the bank returns (dishonoured), and an
**issued** cheque that is cancelled before or after presentment (void). Both have accounting
consequences and both are exception paths, so they get their own screen rather than hiding inside
the cheque register.

## 2. Anatomy

```
PageHead   "Cheque Actions" · description · [Export] [Print]
Tabs       [ Dishonoured received cheques ] [ Void issued cheques ]
KpiRow     Dishonoured this month · Value · Repeat offenders · Recovery outstanding
FilterBar  party · bank · date range · reason · status
Table      Cheque No. · Date · Bank · Party · Amount · Reason · Remarks · Status · Created by · Actions
```

## 3. Components

`Tabs` · `KpiRow` · `DataTable` · `ConfirmDialog` (with entry preview) · `StatusBadge` ·
`ReasonSelect` (controlled list) · `Timeline` in the row drawer.

## 4. Reasons — a controlled list, not free text

Dishonour: Insufficient funds · Account closed · Signature mismatch · Stale cheque · Post-dated ·
Amount mismatch · Technical return · Stop payment.
Void: Spoiled · Lost · Superseded · Payment cancelled · Wrong payee · Duplicate.

Remarks are free text **in addition to** the reason, never instead of it — the reason is what
reports and credit decisions are built on.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Mark dishonoured | danger | `voucher:reverse` | **yes — reason required, entry preview shown** | Reverses the clearing entry, restores the customer's balance, optionally posts bank return charges |
| Void cheque | danger | `voucher:reverse` | **yes — reason required** | Reverses the issue entry; the cheque number is retired, never reused |
| Record recovery | primary | `voucher:create` | yes | Opens a receipt against the restored balance |
| Notify customer | secondary | — | no | Out-of-band; records the attempt in the timeline |

## 6. Financial rules

- A dishonour is a **reversal plus optional charge posting**, never an edit of the original entry.
  Both entries stay in the ledger permanently.
- A voided cheque number is retired; reissue uses a new number. The UI refuses reuse.
- Bank return charges are a separate posting with their own line, shown in the preview.
- Marking dishonoured in a closed period is refused; the dialog offers the first open period.
- Every action here writes an audit record with the reason.

## 7. States

Empty is the healthy state: "No dishonoured cheques in this period." — and it should read as good
news, not as missing data. Repeat-offender rows carry a `danger` chip with the count and link to
the customer's credit record.

## 8. Responsive · 9. Accessibility

`xl` hides Created by · `md` filter sheet · `xs` card list.
The reason select is required before the confirm action enables, and the requirement is stated in
text rather than only by a disabled button.

## 10. Open questions

1. Does a dishonour automatically place the customer on credit hold, or only suggest it?
2. Are bank return charges configurable per bank account?
3. Who may void an issued cheque — accountant, or owner only?
