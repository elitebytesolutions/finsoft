# Vendor detail

| | |
|---|---|
| **Route** | `/vendors/:code` |
| **Archetype** | F — Master record |
| **Module / permission** | Parties · `Masters` |
| **Prototype source** | `ui-prototype/src/parties.tsx` (`VendorDetail`) |
| **Reference frame** | `ui-prototype/design/vendor detial page .png` |
| **Posts to the ledger** | no — actions route to screens that post |

## 1. Purpose

One supplier, everything: terms, tax status, what we owe, their invoices, our payments, returns
raised against them, and what we buy from them.

## 2. Anatomy

```
Breadcrumbs  Parties > Vendors > Getz Pharma
RecordHeader icon · name (h1) · code · type chip · [Active] · [New purchase] [Record payment] [Edit] [More v]
KpiRow       Payable · Due this week · Purchases (period) · WHT deducted (FY)
Tabs         Overview · Ledger · Invoices · Payments · Returns · Products · Activity
  Overview   DefinitionGrid: contact, address, city, NTN/STRN, filer status, WHT section,
             payment terms, expiry-return window, bank details, opening balance and date
  Ledger     LedgerTable scoped to this vendor (Debit / Credit / Balance)
  Invoices   Purchase · Date · Supplier bill # · Amount · Paid · Outstanding · Due · Status
  Payments   Voucher · Date · Mode · Gross · WHT · Net paid · Allocated
  Returns    Return · Date · Purchase · Items · Amount · Reason · Credit received
  Products   products we buy from this vendor with last cost and last purchase date
  Activity   audit timeline
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `LedgerTable` · `DataTable` · `Timeline` ·
`Modal` (edit) · `StatusBadge`.

## 4. Tax presentation

The Payments tab shows **Gross · WHT · Net paid** as three separate columns. Netting them into one
figure is forbidden: the gross settles the invoice, the WHT is a liability to the FBR, and the net
is what left the bank. Three different obligations, three columns.

The WHT KPI is financial-year to date and states the year and the section.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New purchase | primary | `purchase:create` | — | `/purchasing/voucher` pre-filled |
| Record payment | primary | `payment:create` | — | `/payments` pre-filled with open invoices |
| Edit | secondary | `master:edit` | tax change: yes | Party form |
| Statement | overflow | `Reports` | no | Vendor statement PDF |
| Deactivate | overflow | `master:edit` | **yes; refused with a balance** | Hidden from pickers |

## 6. Financial rules

- Every figure server-computed; the outstanding KPI equals the ledger closing balance.
- Advances appear as a negative payable in brackets with an `info` chip explaining them.
- The vendor is never deleted.
- Tax status changes are effective-dated and never restate past payments.

## 7. States

Not found / other tenant → shared Not found. No activity → per-tab empty states. Missing NTN for a
vendor we pay by bank → a `warn` banner, because it affects WHT filing.

## 8. Responsive · 9. Accessibility

Same as customer detail.

## 10. Open questions

1. Does the Products tab need a price-comparison view across vendors?
2. Are vendor statements reconciled against the vendor's own statement (a matching screen)?
3. Do we track lead time per vendor to feed procurement suggestions?
