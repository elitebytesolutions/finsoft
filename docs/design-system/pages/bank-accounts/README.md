# Bank Accounts

| | |
|---|---|
| **Route** | `/bank-accounts` |
| **Archetype** | A — Register (+ create drawer) |
| **Module / permission** | Accounting · `Cash, Bank & GL` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/bank-accounts.tsx` (`BankAccounts`) |
| **Reference frame** | `ui-prototype/design/bank accounts page .png` |
| **Posts to the ledger** | no — it creates the **master** that postings use |

## 1. Purpose

Maintain the tenant's bank accounts: which bank, which branch, which GL account they post to, and
what each one is currently worth.

## 2. Anatomy

```
PageHead   "Bank Accounts" · description · [Export] [+ New bank account]
KpiRow     Total bank balance · Accounts · Uncleared cheques · Accounts needing reconciliation
CardGrid   One card per account: bank mark · nickname · masked number · branch ·
           balance · last reconciled · [View book] [Transactions] [...]
Table view Account · Bank · Branch · Account no. · GL account · Currency · Balance · Status · Actions
Drawer     "Create New Bank Account" — form
```

Two view modes (`SegmentedControl`): **Cards** (default, for 3–15 accounts) and **Table**.

## 3. Components

`SegmentedControl` · `Card` grid (page-local `BankAccountCard`) · `DataTable` · `Drawer` ·
`FormSection` · `AccountPicker` (the GL account it posts to) · `StatusBadge` · `KpiRow`.

## 4. Form fields

Bank · Branch · Account title · Account number · IBAN · Currency · Opening balance + as-at date ·
**GL account** (postable, level 4) · Cheque book series · Default for payments (toggle) · Status.

The account number is masked in lists (`—— 8721`) and revealed in full only on the record, with a
copy action.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New bank account | primary | `master:create` | no | Creates the master; **opening balance posts an opening journal** and therefore confirms with the entry preview |
| Edit | overflow | `master:edit` | no | GL account and currency become read-only once postings exist |
| Deactivate | overflow | `master:edit` | **yes** | Removes it from pickers; postings remain |
| Delete | — | — | — | **Not offered.** A bank account with postings is never deleted |
| View book / Transactions | link | `Cash, Bank & GL` | no | `/bank-book`, `/bank-transactions` |

## 6. Financial rules

- Opening balance is a **posting**, not a field edit: it raises an opening-balance event with a date
  and a contra account, and is refused if that date sits in a closed period.
- The GL account link is immutable once anything has posted to it.
- Balance shown is the **book** balance, server-computed; the statement balance lives on the bank
  book and the difference is the reconciling item.

## 7. States

Empty: "No bank accounts yet — add one to record bank receipts and payments."
Card with an unreconciled warning: amber strip with the count of uncleared items and a link.

## 8. Responsive · 9. Accessibility

Cards: 3 columns `xxl`, 2 at `lg`, 1 at `md`. The masked account number has an accessible label
giving the last four digits only; the reveal action is a button, not a hover.

## 10. Open questions

1. Multi-currency bank accounts in MVP? (Assumed **no** — PKR only.)
2. Is the cheque book series managed here or in `/settings` document numbering?
3. Who may see full account numbers — all finance roles, or Owner only?
