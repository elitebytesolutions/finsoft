# Vendors

| | |
|---|---|
| **Route** | `/vendors` |
| **Archetype** | A — Register |
| **Module / permission** | Parties · `Masters` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`PartyList`, kind `Vendor`) |
| **Reference frames** | `design/vendor listing page .png`, `vendor listig page .png` |
| **Posts to the ledger** | no — creating a vendor creates its control-account sub-ledger |

## 1. Purpose

The supplier directory: who we buy from, on what terms, what we owe them, and their tax status.
Deliberately the mirror of [customers](../customers/) — same anatomy, same columns where they mean
the same thing, so users move between the two without relearning.

## 2. Anatomy

```
PageHead   "Vendors" · [Import] [Export] [+ New vendor]
KpiRow     Vendors · Active this month · Total payable · Due this week
FilterBar  search (name, code, phone, NTN) · city · category · status · balance band
DataTable  Code · Name · Type · City · Phone · Dealing Person · NTN # · Balance (Rs) · Status · Actions
Footer     showing · total payable · pager
Wizard     "Create New" — stepped party form
```

## 3. Components

Identical to customers: `KpiRow` · `FilterBar` · `DataTable` · `Stepper` + `Modal` ·
`StatusBadge` · `ExportMenu` · `ImportDialog`.

## 4. Columns

Same as customers, with these differences:

| Column | Difference |
|---|---|
| Type | Manufacturer · Distributor · Importer · Local supplier · Service provider |
| Balance (Rs) | A positive balance means **we owe them**; an advance shows in brackets |
| Actions | View · Ledger · New purchase · Record payment · Edit · Deactivate |

Vendor-specific fields on the record: tax status (filer / non-filer), WHT applicability and section,
expiry-return window, default payment terms, bank details for payment.

## 5. Create wizard steps

1. **Identity** — code, name, type, NTN/STRN, filer status, WHT section
2. **Contact & address**
3. **Commercial** — payment terms, expiry-return window, bank account for payments, opening balance
4. **Review** — with the opening balance's accounting effect stated

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New vendor | primary | `master:create` | **yes when an opening balance is entered** | Creates the party and its sub-ledger |
| Edit | row | `master:edit` | tax status change: yes | Code read-only once postings exist |
| Deactivate | row | `master:edit` | **yes; refused with a balance outstanding** | Hidden from pickers |
| Delete | — | — | — | **Never offered** |

## 7. Financial rules

- Opening balance is a posting, dated, refused in a closed period.
- **Filer status and WHT section drive tax deducted at payment.** Changing them is audited and does
  not restate past payments; the change is effective-dated.
- Balance is server-computed.

## 8. States

Empty with import offer; filtered empty; a non-filer vendor carries an `info` chip because a higher
WHT rate applies, and the chip explains that in its tooltip.

## 9. Responsive · 10. Accessibility

Identical to customers.

## 11. Open questions

1. Can one party be both a customer and a vendor, and if so is it one record with two sub-ledgers?
2. Are vendor bank details required before a bank payment can be made to them?
3. Is the expiry-return window per vendor or per agreement?
