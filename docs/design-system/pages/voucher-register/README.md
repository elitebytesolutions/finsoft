# Voucher Register

| | |
|---|---|
| **Route** | `/vouchers` |
| **Archetype** | A1 — Register with split inspector, grouped by date |
| **Module / permission** | Accounting · `Cash, Bank & GL` · posting needs `voucher:create` |
| **Prototype source** | `ui-prototype/src/voucher-register.tsx` (`VoucherRegister`) |
| **Reference frames** | `design/voucher register improved page .png`, `voucher register.png`, `voucher register 2.png` |
| **Posts to the ledger** | **yes** — a draft can be posted from the inspector |

## API note — M2-S (2026-09-29)

M2 posts only Journal Vouchers ([voucher-new](../voucher-new/#api-note--m2-s-2026-09-29)), so in
practice this register is a JV register until later waves add other document types that also post
through the journal. Concretely:

| Prototype affordance | M2 status | Reason |
|---|---|---|
| Type tabs: Journal / Receipts / Payments / Cash / Bank / Contra / Sales / Purchase GRN | **Only "Journal" is real**; other tabs hidden until their posting rule exists | No CRV/CPV/BRV/BPV/CV/SINV/PINV rule in M2 |
| Status tabs: Posted / Draft / Pending approval / Reversed | **Posted / Reversed only**; Draft and Pending approval hidden | No draft state exists — a JV is posted or it does not exist |
| Inspector `Post` action | **Hidden** | Nothing in this register is ever in a postable-but-unposted state; the only mutation from here is `Reverse` on an already-posted row |
| Inspector `Reverse` action | **Real** — opens the same reason + confirm flow as [voucher-detail](../voucher-detail/#api-note--m2-s-2026-09-29) | — |
| `Cancel draft` | **Hidden** | No drafts |
| Approvals tab in the inspector | **Hidden** | No approval step |
| `New Voucher` split menu (type pre-select) | Menu collapses to a single **"New Journal Voucher"** action → `/vouchers/new` | Only one type to pre-select |

**Pagination and filtering are server-side** once wired — this register currently paginates and
filters `data.vouchers` in the browser (mock); the M2-B contract must expose a paged, filterable list
endpoint (date range at minimum) before this can be honestly called "connected to the ledger," per
this brief's performance rule ("no browser-side filtering, sorting or pagination of server data").

**KPI row.** "Total vouchers", "Total debit", "Total credit" are period totals of **posted**
vouchers, server-computed — never a client sum of the loaded page, per
[ledger-and-trial-balance.md](../../../posting-rules/ledger-and-trial-balance.md) §1's "every
journal entry, POSTED and REVERSED" inclusion rule. "Pending approvals" KPI is **hidden** (no
approval step).

**Permission.** `voucher.view` to open this register at all, `voucher.reverse` for the inspector's
Reverse action (real catalogue codes — the doc's earlier `voucher:create` / `voucher:reverse`
colon-spelling was the prototype's placeholder). Same client-side hiding gap noted on
[voucher-new](../voucher-new/#api-note--m2-s-2026-09-29): no permission list reaches the client yet,
so actions render and the server's 403 is the real gate.

## 1. Purpose

One place to find, review and post any voucher of any type. The register is the accountant's
working surface during a close: scan by day, open the inspector, check the ledger entries, post or
send back.

## 2. Anatomy

```
Breadcrumbs   Accounting > Voucher Register
PageHead      "Voucher Register" · description  [01 Aug – 31 Aug 2026 v] [+ New Voucher v]
KpiRow        Total vouchers (+trend) · Total debit · Total credit · Pending approvals >   [Export v]
Split grid  [ list 1fr ]                                   [ inspector 420px ]
  TypeTabs    All 24 · Posted 18 · Draft 2 · Pending 3       DocHeader JV-2026-0419 · [Posted]
  Tools       [search] [Filter] [Newest first v]             Tabs: Overview · Ledger Entries 2 ·
  Day groups  "01 September 2026 — 1 voucher"                      Activity 3 · Approvals · Related
    VoucherRow  avatar · id · time · title/narration ·       Summary card: title · amount · Dr/Cr
                status · amount+side · type chip · actor     DefinitionGrid: type, date, reference,
                                                              narration, created by, status, posted on
                                                             LedgerImpactCard (# · account ·
                                                              particulars · debit · credit)
                                                             AttachmentList · Timeline
```

## 3. Components

`Tabs` (type/status) · `FilterBar` · `GroupedList` with `VoucherRow` (page-local, promotion
candidate) · `Drawer`/`Inspector` · `DefinitionGrid` · `LedgerImpactCard` · `Timeline` ·
`AttachmentList` · `StatusBadge` · `ConfirmDialog` · `ExportMenu`.

## 4. Data

Voucher row: `type avatar (JV/CRV/CPV/BRV/BPV/CV/SINV/PINV)` · `voucher no` · `time` ·
`title + narration` · `StatusBadge` · `amount + Dr/Cr` · `type chip` · `created-by chip` · chevron.

Day group header: long date + voucher count. Group total is shown on the right at `lg` and above.

Inspector ledger entries: `# · Account · Particulars · Debit (Rs) · Credit (Rs)` with a totals row
and a **View in journal** link.

Type tabs (counts live): All · Journal · Receipts · Payments · Cash · Bank · Contra ·
Sales invoices · Purchase GRN. Status tabs: Posted · Draft · Pending approval · Reversed.

**Voucher types are filters here, never sidebar items.**

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| New voucher | primary split | `voucher:create` | — | `/vouchers/new`, menu pre-selects the type |
| Post (inspector) | primary | `voucher:create` | **yes** — restates lines, total, period | Posts; row moves to Posted; toast names the voucher |
| Reverse (inspector) | secondary | `voucher:reverse` | **yes** | New reversing voucher; this one gains `Reversed` |
| Cancel draft | danger | `voucher:create` | **yes** | Draft only; marks Cancelled, never deletes |
| Export | secondary split | `Reports` | no | Filtered set, CSV/XLSX/PDF |
| Open full page | link | — | no | `/vouchers/:id` |

Bulk posting is **not offered**. Posting is per voucher, with its entries visible in the same view.

## 6. States

- Empty register, filtered empty, error, permission — standard.
- Closed period: drafts dated in the closed period show a `Period closed` chip and their Post action
  is disabled with that reason; the register itself stays fully readable.
- Inspector with nothing selected: quiet placeholder — "Select a voucher to see its entries."

## 7. Financial rules on this page

- The inspector always shows the **actual ledger entries** before the user can post. No posting
  without sight of the double entry.
- A posted voucher exposes no edit path.
- Posting is idempotent: the confirm dialog's action carries the voucher's idempotency key, so a
  double-submit cannot double-post.
- Totals in the KPI row are period totals of **posted** vouchers only, and say so.

## 8. Responsive

`lg` inspector narrows to 380px · `md` inspector becomes an overlay drawer · `sm` day groups become
sticky headers in a single-column list · `xs` rows become cards with id, amount, status.

## 9. Accessibility

The list is a `listbox` of vouchers with `aria-selected`; arrow keys move selection and update the
inspector; the inspector is a labelled region, not a dialog, at `lg` and above, and a focus-trapped
dialog when it becomes an overlay.

## 10. Deviations from the prototype

The prototype ships three register layouts (`vg-*` grouped list, an accordion variant, and a plain
table). Production keeps **one**: the grouped list with split inspector.

## 11. Open questions

1. Does "Pending approval" need its own approval actions here, or only in `/approvals`?
2. Should the day-group header carry the day's Dr/Cr totals at all breakpoints?
3. Retention: how far back does the default date range look for a tenant with years of history?
