# Executive dashboard

| | |
|---|---|
| **Route** | `/dashboard` (default route) |
| **Archetype** | I — Dashboard |
| **Module / permission** | Core · `Dashboard` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Dashboard`) |
| **Reference frame** | dark navy hero band; `design/todays task page .png` for the tile language |
| **Posts to the ledger** | no — and must never |

## 1. Purpose

The owner's first screen of the day. It answers "is the business fine?" in under ten seconds and
routes to the screen that answers "why not?". It is a read surface only.

## 2. Anatomy

```
HeroBand (dark navy)  "Good morning, Ahmed" · period · [View reports] [New voucher]
KpiRow                Sales today · Cash received · Receivables · Stock value
QuickActions          6 permission-filtered tiles
Grid 1.65fr / 1fr     [ Revenue & purchases trend (area) ] [ Composition donut + health list ]
Lower grid 1fr 1fr    [ Needs attention ]                  [ Recent documents ]
```

## 3. Components

`HeroBand` · `KpiRow` / `KpiCard` · `QuickActions` (6 tiles, tone 1–6) · `Panel` ·
`AreaChart`, `DonutChart` (Recharts) · `AttentionList` · `DataTable` (compact, 5 rows).

## 4. Data

| KPI | Figure | Period | Links to |
|---|---|---|---|
| Sales today | Net sales posted today | Today | `/sales` filtered to today |
| Cash received | Receipts posted today | Today | `/payments` |
| Receivables | Total outstanding | As at now | `/receivables` |
| Stock value | Inventory valuation | As at now | `/inventory` |

Deltas compare to the equivalent prior period and state it ("vs yesterday", "vs last month").

**Needs attention** rows: cheques maturing, invoices overdue past terms, stock below reorder,
batches expiring within 90 days, drafts awaiting approval, period close due. Each row carries an
icon tone, a count, and routes to a pre-filtered list.

## 5. Actions

| Action | Kind | Permission | Result |
|---|---|---|---|
| View reports | secondary (on hero) | `Reports` | `/reports` |
| New voucher | primary (on hero) | `voucher:create` | `/vouchers/new` |
| Quick action tiles | tile | per-tile action permission | routes to the entry screen |

No action on this page mutates anything.

## 6. States

- Loading: hero renders with the greeting; KPIs and charts render skeletons.
- Empty (new tenant): KPIs show `Rs 0.00`, charts show an empty-state illustration, attention list
  reads "Nothing needs your attention yet", quick actions remain.
- Permission: a user without `Dashboard` never lands here; the shell routes them to their first
  permitted module.

## 7. Financial rules on this page

- **No posting from a dashboard.** Tiles route to screens that post.
- Every figure states its period and is traceable in one click to the list or ledger that produces
  it. A dashboard figure that cannot be drilled into is a defect.
- Figures are server-computed. The client never aggregates postings to render a KPI.

## 8. Responsive

`xl` KPI row stays 4 · `md` grids stack, KPI row 2×2 · `sm` charts drop to 180px height ·
`xs` KPI row becomes a horizontal scroll strip, quick actions 2 columns.

## 9. Accessibility

Charts have an accessible summary and a "View as table" link; the donut has direct labels, not
colour alone; the hero band uses a light focus ring; the greeting is not the `h1` — the `h1` is
"Dashboard", visually rendered inside the hero.

## 10. Deviations from the prototype

The prototype's hard-coded chart data and greeting name come from the store; production takes both
from the server and the session. The prototype's "Quick actions" tile set is provisional — the
final six are chosen per role.

## 11. Open questions

1. Is the KPI set role-dependent (owner vs accountant vs salesman) or fixed?
2. Which period does "Sales today" use when the tenant's day boundary is not midnight?
3. Does the attention list need a snooze/dismiss, and is that state per user or per tenant?
