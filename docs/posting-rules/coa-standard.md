# COA/standard-v1 — the minimal standard chart of accounts

| | |
|---|---|
| **Rule** | `COA/standard-v1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M2 — migration 010 `accounts` + tenant seeding |
| **Governed by** | [PRD.md](../PRD.md) §4.2, §6.1 ("a minimal standard COA of about 20 accounts"); [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) (per-tenant mapping is configuration); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 4, 7, 11, 17 |
| **Golden** | Every `posting-p*.json` scenario runs on a tenant seeded with this template |

---

## 1. Purpose and scope

The template every new tenant receives, and the only chart the MVP knows. It is deliberately small: enough accounts to post the MVP events, record the demo's opening capital and a handful of expenses by manual journal, and carry the control accounts later waves need — so that the template does not have to change shape when stock and purchasing arrive.

**Tenant-specific charts arrive in Wave 10.** Bhatti Traders' legacy tree (`10-01-01 Cash in Hand` and so on, recorded in `.claude/DB_REFERENCE.md`, which is reference material and not authority) is loaded by the Wave 10 migration as that tenant's own chart, mapped onto the same **roles** (§4). No posting rule changes when it does; only the role → account mapping differs. The schema must therefore not assume this template's 4-digit code format or its 2-level depth (§5).

## 2. The accounts

Six headers and nineteen postable accounts. *Manual JV* is whether `JOURNAL_VOUCHER_POSTED` may post to the account (§3).

| Code | Name | Kind | Type | Normal | Control | Role | Manual JV | Used in the MVP by |
|---|---|---|---|---|---|---|---|---|
| **1000** | **Assets** | HEADER | ASSET | Dr | — | — | — | — |
| 1110 | Cash in Hand | POSTABLE | ASSET | Dr | — | `CASH_DEFAULT` | Yes | Receipt (method `CASH`); JV |
| 1120 | Bank — Current Account | POSTABLE | ASSET | Dr | — | `BANK_DEFAULT` | Yes | Receipt (method `BANK`); JV |
| 1200 | Accounts Receivable — Trade Debtors | POSTABLE | ASSET | Dr | **AR** | `AR_CONTROL` | **No** | `SALE_POSTED/service`; `CUSTOMER_PAYMENT_RECEIVED` |
| 1300 | Inventory — Stock in Trade | POSTABLE | ASSET | Dr | **INVENTORY** | `INVENTORY` | **No** | Not used (Wave 5) |
| **2000** | **Liabilities** | HEADER | LIABILITY | Cr | — | — | — | — |
| 2100 | Accounts Payable — Trade Creditors | POSTABLE | LIABILITY | Cr | **AP** | `AP_CONTROL` | **No** | Not used (Wave 6) |
| 2900 | Suspense | POSTABLE | LIABILITY | Cr | — | `SUSPENSE` | Yes | JV only |
| **3000** | **Equity** | HEADER | EQUITY | Cr | — | — | — | — |
| 3100 | Owner's Capital | POSTABLE | EQUITY | Cr | — | `OWNER_CAPITAL` | Yes | JV (demo opening capital) |
| 3200 | Retained Earnings | POSTABLE | EQUITY | Cr | — | `RETAINED_EARNINGS` | **No** | Not used (opening balances; year-end close) |
| 3300 | Owner's Drawings | POSTABLE | EQUITY | Dr | — | `OWNER_DRAWINGS` | Yes | JV |
| **4000** | **Income** | HEADER | INCOME | Cr | — | — | — | — |
| 4100 | Sales Revenue — Goods | POSTABLE | INCOME | Cr | — | `SALES_REVENUE` | Yes | Not used by an event (stock lines, Wave 7); JV |
| 4200 | Service Revenue | POSTABLE | INCOME | Cr | — | `SERVICE_REVENUE` | Yes | `SALE_POSTED/service`; JV |
| 4900 | Other Income | POSTABLE | INCOME | Cr | — | — | Yes | JV |
| **5000** | **Cost of Sales** | HEADER | EXPENSE | Dr | — | — | — | — |
| 5100 | Cost of Goods Sold | POSTABLE | EXPENSE | Dr | — | `COGS` | **No** | Not used (Wave 5/7) |
| **6000** | **Operating Expenses** | HEADER | EXPENSE | Dr | — | — | — | — |
| 6100 | Salaries and Wages | POSTABLE | EXPENSE | Dr | — | — | Yes | JV |
| 6200 | Rent | POSTABLE | EXPENSE | Dr | — | — | Yes | JV |
| 6300 | Office Expenses | POSTABLE | EXPENSE | Dr | — | — | Yes | JV |
| 6400 | Utilities | POSTABLE | EXPENSE | Dr | — | — | Yes | JV |
| 6500 | Bank Charges | POSTABLE | EXPENSE | Dr | — | — | Yes | JV |
| 6900 | Rounding Differences | POSTABLE | EXPENSE | Dr | — | `ROUNDING` | **No** | Not used — no MVP rule produces a residual ([README](README.md) §2.3) |

Every postable account's parent is the header of the same thousand. A postable account's type equals its header's type.

### Choices worth justifying

- **Five types, not six.** Cost of goods sold is an `EXPENSE` grouped under the `5000 Cost of Sales` header. A separate `COGS` type (as in the legacy reference) adds a sixth branch to every type-driven rule for no posting benefit; the P&L groups by header.
- **Inventory, COGS, AP and Sales Revenue — Goods are seeded now though the MVP never posts to them.** A template that changes shape when Wave 5 arrives means two populations of tenants. Seeding them unused costs four rows. The three that a manual JV could damage (1300, 2100, 5100) are closed to manual JV from day one, so nothing accumulates in them that Invariants 9 and 10 would later have to explain.
- **Suspense is a liability with a credit normal balance.** Its balance may fall on either side, and the trial balance shows it on whichever side it falls ([ledger-and-trial-balance.md](ledger-and-trial-balance.md) §3). It is JV-postable because parking an unidentified item is its purpose. It must be cleared before year-end close; that check arrives with year-end close ([periods.md](periods.md) §7).
- **Rounding Differences is an expense.** A residual is a P&L item. The normal balance is Dr, but a credit residual is equally legitimate ([ADR-0015](../adr/ADR-0015-inventory-valuation-is-carried-value.md) sell-out credits it).
- **Owner's Drawings is a debit-normal equity account.** Bhatti Traders is an owner-managed business; drawings must not be booked as an expense.
- **No tax accounts.** No sales-tax payable, input tax or withholding account is seeded, because no tax rule exists (Product Owner, 2026-09-27). Seeding an account for a rule nobody has written invites someone to post to it. Tax accounts arrive with the Wave 9 tax rules, as `standard-v2` for new tenants and an audited chart change for existing ones.
- **One cash account and one bank account.** Wave 3 introduces bank-account master records, each mapped to its own GL account; 1120 remains the default. The MVP receipt chooses between `CASH` and `BANK` only.

**Normal balance never blocks a posting.** It is presentation — which side a balance is expected on. An account on its abnormal side (an overdrawn bank, a credit on 6900) posts and reports normally.

## 3. Which accounts a manual JV may reach

A manual journal voucher may post to an account only if it is **postable, active, not a control account, and not restricted**:

| Closed to manual JV | Why |
|---|---|
| **Control accounts** — 1200 AR, 2100 AP, 1300 Inventory | Their balance is defined by a subledger (customer documents, vendor documents, the stock movement ledger). A manual line would change the GL without the subledger, breaking Invariant 9 or 10 on the day it posts, or — if it carried a party — create a customer balance with no document for a receipt to allocate against. Customer balances are changed by customer documents and their reversals. A controlled "party journal" with a mandatory customer and its own golden scenario is a Wave 4 rule variant, not an MVP gap |
| **Restricted** — 3200 Retained Earnings | Written only by opening balances and year-end close. A manual line would mix a prior-period adjustment into the figure that close computes, invisibly |
| **Restricted** — 5100 Cost of Goods Sold | Its balance must equal the Σ of `cogs_amount` stored on outward movements ([ADR-0007](../adr/ADR-0007-weighted-average-costing.md), rule 16). A manual line makes gross profit disagree with the movement ledger |
| **Restricted** — 6900 Rounding Differences | Only kernel-computed residuals land here ([ADR-0011](../adr/ADR-0011-money-representation.md)). Keeping manual entries out is what makes a drift in this account *mean* something |
| **Headers** | No journal line ever posts to a header |
| **Inactive accounts** | No posting of any kind |

The restriction is on *manual* entry. The same accounts receive postings from their events through the kernel.

## 4. Roles and account resolution

A posting rule names a **role**; the kernel resolves it to an account for the posting tenant.

- Each role in the table above is held by **exactly one active postable account** per tenant. Two accounts holding a role, or none, is a configuration error. A posting that needs an unresolved role is rejected with `ACCOUNT_ROLE_UNMAPPED`; the kernel does not fall back to a code, a name or a similar account.
- Resolution is by role, never by code or name (rule 17). The codes in this document are how the *template* seeds the roles, and how golden scenarios refer to accounts.
- The resolved account must satisfy the rule's type expectation: `AR_CONTROL` is an `ASSET` with control `AR`; `SERVICE_REVENUE` is `INCOME`; `CASH_DEFAULT` and `BANK_DEFAULT` are `ASSET`. A mismatch is `ACCOUNT_ROLE_MISCONFIGURED`. This matters from Wave 10, when a tenant-specific chart supplies the mapping.
- Roles are not reassignable in the MVP. Reassignment (for example moving `BANK_DEFAULT` to a second bank account) is a Wave 3 audited configuration action.

Whether the role is a column on `accounts` or a separate mapping table is the Database seat's choice in migration 010. The requirement is the uniqueness and the rejection above.

## 5. Master-data rules for migration 010

- `UNIQUE (tenant_id, code)`; `UNIQUE (tenant_id, name)` among postable accounts. Codes are text; `standard-v1` uses 4 digits, but the column must accept legacy codes such as `10-01-01` (Wave 10). Depth is 2 here; the schema must allow a deeper tree.
- A header has no journal lines, ever — enforced in the kernel and by the database (a line's account must be `POSTABLE`).
- **Once an account has a journal line**, its type, kind and control kind are immutable, and it can never be deleted (rule 4). Before that, the MVP still has no delete: accounts are deactivated, never removed.
- Deactivation: rejected while the account's balance is non-zero, or while it holds a role. The MVP ships the chart **read-only** to users; create, rename and deactivate are Wave 2 remainder work, each audited.
- `tenant_id` on every row, RLS forced, composite foreign keys as Invariant 7 requires.

## 6. Seeding

- The template is applied **at tenant creation, in the same transaction** that creates the tenant, together with that tenant's periods ([periods.md](periods.md) §3). A tenant without a chart cannot exist.
- Seeding writes master data only. It is not a posting and creates no journal entry. It writes one audit record naming the template id (`COA/standard-v1`).
- `BHATTI1` and `BHATTI2` already exist before migration 010. They must be seeded with this template before M2 is demoable; the mechanism is the Database seat's ([README](README.md) §5).
- Opening balances are not part of the template. The demo tenants record opening capital by manual JV (`Dr 1120 Bank / Cr 3100 Owner's Capital`), which is an ordinary JV. `OPENING_BALANCE_LOADED` is specified with the Wave 10 migration.

## 7. Changing the template

`standard-v1` is frozen from the first tenant seeded with it. A change is `standard-v2`, applied to tenants created after it ships; existing tenants receive additions through audited chart changes, never by editing their rows in place. Golden scenarios name the template version they assume.
