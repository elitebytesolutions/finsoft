# COA/standard-v1 — the minimal standard chart of accounts

| | |
|---|---|
| **Rule** | `COA/standard-v1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000). **Amended 2026-09-29 (M2-C, Accounting seat)** on a Product Owner scope decision of the same date: users may create accounts, and edit them within limits, in the MVP — §5 amended, §8 added. No account in the §2 template, no role, and no posting rule changes |
| **Implemented in** | M2 — migration 010 `accounts` + tenant seeding |
| **Governed by** | [PRD.md](../PRD.md) §4.2, §6.1 ("a minimal standard COA of about 20 accounts"); [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) (per-tenant mapping is configuration); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 4, 7, 11, 17 |
| **Golden** | Every `posting-p*.json` scenario runs on a tenant seeded with this template; [P13](../../tests/accounting/golden/posting-p13-coa-create-and-rename.json) pins chart maintenance (§8) |

---

## 1. Purpose and scope

The template every new tenant receives, and the only chart *shape* the MVP knows. From 2026-09-29 a tenant may add postable accounts to it (§8); it may not change its headers, roles or control accounts. It is deliberately small: enough accounts to post the MVP events, record the demo's opening capital and a handful of expenses by manual journal, and carry the control accounts later waves need — so that the template does not have to change shape when stock and purchasing arrive.

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
- Deactivation: rejected while the account's balance is non-zero, or while it holds a role. ~~The MVP ships the chart **read-only** to users; create, rename and deactivate are Wave 2 remainder work, each audited.~~
- **Amended 2026-09-29 (Product Owner scope decision, recorded by the Accounting seat).** The Product Owner overruled the read-only MVP chart for **create**, with edit implied by the screen. In the MVP a user holding `account.manage` may **create** a postable account under an existing header and **edit** it within the limits of §8. **Deactivate stays deferred** to Wave 2 remainder (§8.4). **Delete does not exist, now or later.** Headers, control accounts, role-holding accounts and restricted accounts stay read-only to users. §8 is the rule; this bullet only records the change.
- `tenant_id` on every row, RLS forced, composite foreign keys as Invariant 7 requires.

## 6. Seeding

- The template is applied **at tenant creation, in the same transaction** that creates the tenant, together with that tenant's periods ([periods.md](periods.md) §3). A tenant without a chart cannot exist.
- Seeding writes master data only. It is not a posting and creates no journal entry. It writes one audit record naming the template id (`COA/standard-v1`).
- `BHATTI1` and `BHATTI2` already exist before migration 010. They must be seeded with this template before M2 is demoable; the mechanism is the Database seat's ([README](README.md) §5).
- Opening balances are not part of the template. The demo tenants record opening capital by manual JV (`Dr 1120 Bank / Cr 3100 Owner's Capital`), which is an ordinary JV. `OPENING_BALANCE_LOADED` is specified with the Wave 10 migration.

## 7. Changing the template

`standard-v1` is frozen from the first tenant seeded with it. A change is `standard-v2`, applied to tenants created after it ships; existing tenants receive additions through audited chart changes, never by editing their rows in place. Golden scenarios name the template version they assume. An account a user creates under §8 is that tenant's own addition. It does not change the template, and it does not make the tenant's chart a different template version.

## 8. Chart maintenance in the MVP: create and edit

**Source:** the Product Owner's scope decision of 2026-09-29, which says users can add accounts from the Chart of Accounts screen in the MVP, and the screen implies edit. This section is the Accounting seat's rule for making that safe. It amends §5. It changes no posting rule, no role and no golden figure in P01–P12.

**The governing idea.** A user-created account is an ordinary leaf that a manual JV can reach. It holds no role, so no event ever resolves to it. It is not a control account, so no subledger claims it. It is not restricted. Everything that a posting rule, a subledger or Invariants 9 and 10 depend on stays where the template put it, and users cannot change it.

### 8.1 Create

| Question | Rule |
|---|---|
| **What may be created** | A `POSTABLE` account whose parent is an existing `HEADER` of the same tenant. Nothing else |
| **New headers** | **No**, not in the MVP. A header is a branch of the statements: the P&L groups by header (§2). The schema also keeps headers at the top level (`accounts_header_has_no_parent`), so a new header would be a new statement section, not a sub-group. Sub-headings and new sections belong with a deeper tree (Wave 2 remainder or Wave 10) |
| **Control accounts** | **No.** A user cannot create an account whose control kind is `AR`, `AP` or `INVENTORY`. Invariant 9 holds by construction only while each subledger has exactly one control account, and TD-011 records that the customer ledger and the customer balance already diverge if a second AR-control account exists. The create request has no control field, and the database must refuse one too (§8.7 R2, R7) |
| **Roles** | **None.** `role` is null on every user-created account. Roles cannot be reassigned in the MVP (§4) |
| **Restricted** | **No.** `restricted = false`. The restricted accounts are exactly the template's (§3) |
| **Result** | Active, `POSTABLE`, `control_kind = 'NONE'`, no role, not restricted. It can be posted to immediately, **by manual JV only** (§3): it passes every manual-JV test and no rule names it |

**Fields**

| Field | Source | Rule |
|---|---|---|
| `parentId` | The user, from a picker of the tenant's headers | Must be a `HEADER` of the caller's tenant. A foreign or unknown id is `ACCOUNT_PARENT_NOT_FOUND` (404 semantics, never 403). A postable account is `ACCOUNT_PARENT_NOT_HEADER` |
| `type` | **Inherited from the parent. Not a request field** | Always equal to the parent's type. The user cannot choose it, so the API cannot produce a mismatch. The database checks it anyway (§8.7 R5) |
| `normalBalance` | **Derived from type. Not a request field** | `ASSET` and `EXPENSE` → `DEBIT`. `LIABILITY`, `EQUITY` and `INCOME` → `CREDIT`. Normal balance is presentation and never blocks a posting (§2), so a user who needs a contra-style account (like 3300 Drawings) loses nothing: its balance shows on the other side. A user-set normal side is out of scope |
| `code` | **Entered by the user, with a server suggestion** | See below |
| `name` | The user | Leading and trailing whitespace is trimmed. 1–200 characters after trimming. Unique per tenant among postable accounts, **ignoring case** (the existing `accounts_tenant_postable_name_key` on `lower(name)`) |

**Code.** An account code is a master-data identifier the accountant chooses. It is not a document number, so rule 12 does not require the system to generate it. Accountants place codes deliberately (6150 beside 6100), and the code is how they find the account on every report.

- **Format, for a tenant on `standard-v1` (every tenant until Wave 10).** Exactly four ASCII digits, `^[1-9][0-9]{3}$`. The first digit equals the first digit of the parent header's code, and the code is not the header's own code, so under `6000 Operating Expenses` the range is `6001`–`6999`. A code of the wrong shape is `ACCOUNT_CODE_FORMAT`. A code of the right shape in the wrong block is `ACCOUNT_CODE_OUT_OF_RANGE`. Wave 10's legacy charts (`10-01-01`) bring their own format rule with their migration. The column stays `text` (§5).
- **Unique per tenant, as exact text.** `accounts_tenant_code_key` already enforces this. A collision is `ACCOUNT_CODE_TAKEN`, including when a concurrent create wins the race.
- **Suggestion.** The server pre-fills the create form with the smallest free code in the parent's block that is a multiple of 100. If there is none, it uses the smallest free multiple of 10, and after that any free code. On a fresh `standard-v1` tenant that is `6600` under `6000` and `1100` under `1000`: 1110, 1120, 1200 and 1300 are taken, but 1100 itself is free. (Corrected 2026-09-29, T3 review of M2-C: this example first read `1400`, which does not follow from the algorithm. The algorithm is the rule and the example was wrong.) The suggestion is advisory: it reserves nothing, it is re-validated at submit like any typed code, and no golden figure depends on it.

**Never collected by the create form: an opening balance.** The mock at `8c5c283` had an "Opening balance (PKR)" field. An opening balance is a posting. Today it is recorded as an ordinary manual JV (§6), and from Wave 10 as `OPENING_BALANCE_LOADED`. A master-data form that wrote one would be a posting path outside the kernel. The mock's "Balance type", "Record type", "Chart level", "City" and "Contact / NTN" fields are not collected as account attributes either (§8.8).

### 8.2 Edit

An account is **protected** if it is a `HEADER`, holds a role, has a control kind other than `NONE`, or is restricted. In `standard-v1` that means every header, plus 1110, 1120, 1200, 1300, 2100, 2900, 3100, 3200, 3300, 4100, 4200, 5100 and 6900. **A user cannot edit any field of a protected account** (`ACCOUNT_PROTECTED`). Renaming `BANK_DEFAULT` to the real bank's name is a legitimate need, but it arrives with Wave 3's bank-account master and its audited role configuration, not through this screen.

For an unprotected account (one a user created, or the template's 4900 and 6100–6500):

| Field | Before the account's first journal line | After it has one | Why |
|---|---|---|---|
| `name` | Yes | **Yes** | The name is a label. Lines reference the account by id (rule 17), so no figure moves, and the audit log keeps every former name |
| `code` | Yes | **No** (`ACCOUNT_HAS_POSTINGS`) | The code is the identifier printed on every trial balance and ledger already given to the owner, the auditor or the FBR. If it changed after use, a regenerated report of a closed period would disagree with the one that was filed, in the column people match by |
| `parentId` | Yes, to a header **of the same type**. The code must then lie in the new parent's block, so a move normally changes the code in the same edit | **No** (`ACCOUNT_HAS_POSTINGS`) | Moving a posted expense account from `6000 Operating Expenses` to `5000 Cost of Sales` silently restates gross profit for every closed period. A restatement is made by reversal and re-entry, not by changing a pointer |
| `type` | Never directly. It follows the parent, and the parent must have the same type, so in practice it never changes | Never | §5. `accounts_enforce_posted_immutability` also blocks it for every database role |
| `normalBalance` | Never. It is derived | Never | |
| `kind`, `controlKind`, `role`, `restricted` | Never, by a user | Never | The template's structure (§8.1) |
| `isActive` | Not in the MVP (§8.4) | | |

- **"Has a journal line"** means at least one `journal_lines` row for the account, in an entry of any status. A reversed pair nets to zero but is still history, so an account whose only postings were reversed keeps its code and parent for ever.
- **Optimistic concurrency.** An edit carries the `version` the user loaded. A stale version is `ACCOUNT_VERSION_CONFLICT`, and nothing is written. A successful edit increments `version`.
- **An edit that changes nothing** writes nothing. It bumps no version, writes no audit record, and returns the account as it stands.
- **The request names only editable fields:** `name`, `code`, `parentId` and `expectedVersion`. Any other field (`type`, `controlKind`, `isActive` and so on) is rejected with `PAYLOAD_INVALID`, never silently ignored, so a client can never believe it changed something it did not.

### 8.3 What create and edit do to the books

- **No journal entry, no period, no posting.** Creating or editing an account changes master data. It needs no open period, and a closed period does not reject it, because it changes no balance in any period.
- **The trial balance** includes a new account from its first line onward (ledger-and-trial-balance.md §3: postable accounts with activity). An account with no lines does not appear.
- **Reports show the current code and name.** A line stores the account id and nothing else (rule 17). A regenerated report of any period, closed ones included, shows the account's current name. **The figures never change; only the label does**, and the audit log records what the label used to be. Because code and parent cannot change after a posting (§8.2), a regenerated report can differ from a filed one only in names.
- **A posting may be dated before the account was created.** An account's existence has no date. A JV dated 2026-09-10 to an account created on 2026-09-27 is valid if 2026-09 is open. The period rule protects closed periods; the account does not need to.
- **No event rule reaches a user-created account.** Every rule resolves by role (§4), and a user-created account has none. If the tenant adds `4300 Consulting Revenue`, `SALE_POSTED/service` still credits 4200. Moving service revenue onto such an account is a role reassignment, which is Wave 3 work.

### 8.4 Deactivate: **deferred** to Wave 2 remainder

The Product Owner's decision covers create, with edit implied. Deactivation stays out of the MVP for two reasons.

1. **It needs a change to the database gate on the posting path.** `journal_lines_enforce_line_gate` (migration 012) reads `accounts.is_active` without a lock, and its own comment says to revisit a deactivate racing a posting once `UPDATE` is granted. Without that fix, a deactivation can commit alongside a concurrent first posting and leave an inactive account with a balance. It is a kernel-trigger change with its own concurrency tests, and "users can add accounts" does not need it.
2. **Its preconditions are balance reads under a lock,** not field validation. They are written down here so that the Wave 2 task starts from a rule:
   - the account holds no role and is not a control account;
   - its inception-to-date balance is exactly `0.0000`, read under a lock that serialises the check against new lines;
   - no open draft of any kind references the account by id. The MVP has no such draft: there is no JV draft (journal-voucher.md §1), and invoice and receipt drafts reach accounts only through roles. Any future draft type that stores an account id must join this check;
   - deactivation and reactivation are both audited.

**There is no delete, ever** (rule 4), whether or not the account has postings, and the mock's Delete button at `8c5c283` is not built. Until Wave 2, a user can rename or re-code an account created by mistake, and can re-parent it if it has no postings (§8.2). It cannot be removed or hidden. **The Product Owner should know this before the demo.**

### 8.5 Permission

- **Recommended code: `account.manage`**, covering both create and edit. It is one code because in the MVP both are the same act of shaping the chart, and splitting them gains nothing while deactivate is deferred. Wave 2's deactivate gets its own review and may earn its own code.
- **Held by Owner and Accountant**, not Viewer.
- **Not privileged** (no MFA step-up). It cannot change a balance, a role or a control account. The worst misuse is an account with a confusing name, and that leaves an audit trail. This is unlike `period.reopen` or `voucher.reverse`.
- **The Security seat ratifies it.** That covers the catalogue in `packages/permissions`, the grants in `system-roles.ts`, and a backfill for existing tenants in the style of migration 014. The permission is checked on the server (rule 18). The UI hides Add and Edit from users without it, but that is presentation only.

### 8.6 Audit

A successful create writes **one** `audit_log` record in the same transaction (rule 9), and so does every edit that changes something. The record goes through the application-layer hash chain (ADR-0020) with the acting user and the request id.

- `ACCOUNT_CREATED` records the full row as created: id, code, name, parent id and code, type, normal balance, kind, control kind, role, restricted, is_active and version.
- `ACCOUNT_UPDATED` records the account id, the before and after values of each changed field, and the version before and after.

A rejected request writes nothing: no account row, no audit record and no version bump.

### 8.7 Database requirements (for the Database seat, migration **018**)

Migrations 016 and 017 are taken by M3-P, so the next free number is **018**. Migration 010 has been released and is not edited (ADR-0013, forward-only). What follows are requirements, not SQL; the design is the Database seat's.

| # | Requirement | Why |
|---|---|---|
| R1 | Grant `finsoft_app` a **column-scoped `UPDATE`** on `name`, `code`, `parent_id`, `updated_by` and `version` only. **Not** on `type`, `kind`, `control_kind`, `role`, `restricted`, `normal_balance`, `is_active`, `tenant_id`, `id` or `created_*`. Revoke the table-level privilege first (the lesson of 008 and 010) | Enforces §8.2 at the privilege layer. `is_active` stays ungranted until deactivate is designed (§8.4) |
| R2 | **The user-create path must not be able to insert a header, a control account, a role or a restricted account**, and this is enforced below the application. Today `finsoft_app`'s column `INSERT` includes `kind`, `control_kind`, `role` and `restricted`, because tenant seeding needs them. The Database seat chooses how. Two options: seed through a narrowly scoped definer function and narrow `finsoft_app`'s `INSERT`, or add a trigger that admits those values only in the tenant-provisioning transaction | An application bug or a crafted request must not be able to create a second AR account (Invariant 9, TD-011) |
| R3 | **Protected rows reject `UPDATE`** from every role when the row is a header, holds a role, has a control kind other than `NONE`, or is restricted. Wave 3's audited role reassignment will amend this deliberately | §8.2. Without it, R1's grant lets `finsoft_app` rename 1200 |
| R4 | Extend `accounts_enforce_posted_immutability` (012) to cover **`code` and `parent_id`**. `name` is deliberately excluded | §8.2. Today the trigger covers only type, kind, control kind, tenant and id |
| R5 | **Parent integrity on INSERT and UPDATE:** a postable account's parent is a `HEADER` of the same tenant **and the same type**. Today this is a seeding convention (§2) that no constraint enforces | Without it, an income account under the Expenses header can be stored |
| R6 | `normal_balance` stays unconstrained against type, because 3300 is `EQUITY` with a `DEBIT` normal balance and so no blanket CHECK is possible. The application derives it on create, and R1 makes it non-updatable | |
| R7 | **At most one account per tenant with `control_kind = 'AR'`, and at most one with `'AP'`.** `INVENTORY` is left to Wave 5 | Closes the configuration TD-011 depends on structurally, not just by the absence of a UI |
| R8 | **Serialise the "has no journal line" check against a concurrent first line.** A code or parent edit must not pass its no-lines check while another transaction inserts the account's first line. `code` is in a unique index, so an `UPDATE` of it already conflicts with the line FK's `KEY SHARE` lock; `parent_id` is not. Test both. The note in 012's line gate about Wave 2 is due now for `parent_id`, and in full when deactivate arrives | §8.2 |
| R9 | Keep `accounts_tenant_code_key` (`UNIQUE (tenant_id, code)`) and `accounts_tenant_postable_name_key`. The API maps their 23505 errors to `ACCOUNT_CODE_TAKEN` and `ACCOUNT_NAME_TAKEN` | The uniqueness rules of §8.1, which already exist |
| R10 | Update `COMMENT ON TABLE accounts`, which still says "Ships read-only in the MVP" | Documentation that is wrong is worse than none |
| R11 | Adversarial tests. `finsoft_app` updating `type`, `role`, `control_kind` or `is_active` is refused. Updating a protected row is refused. Changing code or parent after a line exists is refused for **every** role. Inserting a second AR-control account is refused, including through the seeding columns. Tenant B cannot insert under tenant A's header: composite FK plus RLS, with the migration role used to rule out RLS as the reason | Invariants 7 and 9 |

**Where the code lives.** `accounts` belongs to the accounting kernel and `packages/database/src/accounting`. Create and edit are functions exported from that kernel boundary and called by `apps/api`. No module writes `accounts`. The Architecture seat should confirm the export. This section supersedes §5 of M2-B's `api-contract.md` ("POST /api/accounts — NOT BUILT, staying that way"), and the API lane needs to update that contract.

**Idempotency.** Account maintenance is not a posting and carries no idempotency key. A create submitted twice fails the second time with `ACCOUNT_CODE_TAKEN` on the unique code, instead of creating two accounts. An edit submitted twice fails the second time on `version`.

### 8.8 The screen (from the mock at `8c5c283`)

| Mock element | MVP |
|---|---|
| "Code (auto)" | Entered by the user, pre-filled with the server's suggestion (§8.1) |
| Record status | Not collected; the account is created active |
| Record type, Balance type | Not collected. Type is shown read-only from the parent, and the derived normal balance is shown read-only |
| Chart level | Fixed. The MVP creates level-2 postable accounts only |
| Parent account | A picker filtered to the tenant's headers |
| Opening balance (PKR) | **Removed.** It would be a posting (§8.1) |
| City, Contact / NTN | Removed; they are not account attributes |
| Bulk Edit / Move / Activate / Deactivate | Not in the MVP |
| Delete | **Never** |

The UI displays the server's error codes and does not re-implement the code-block, parent or protected-account rules (rule 19). It may disable controls in advance using data the server returns, such as a per-account `protected` flag and `hasPostings` flag. The server remains the authority.

### 8.9 Errors

`PAYLOAD_INVALID` (an unknown or non-editable field, or a wrong JSON type) · `ACCOUNT_NOT_FOUND` · `ACCOUNT_PARENT_NOT_FOUND` · `ACCOUNT_PARENT_NOT_HEADER` · `ACCOUNT_PARENT_TYPE_MISMATCH` (an edit to a header of a different type) · `ACCOUNT_CODE_FORMAT` · `ACCOUNT_CODE_OUT_OF_RANGE` · `ACCOUNT_CODE_TAKEN` · `ACCOUNT_NAME_INVALID` (empty after trimming, or longer than 200 characters) · `ACCOUNT_NAME_TAKEN` · `ACCOUNT_PROTECTED` · `ACCOUNT_HAS_POSTINGS` · `ACCOUNT_VERSION_CONFLICT` · `FORBIDDEN` (the caller lacks `account.manage`)

**Evaluation order**, so that a request with several faults always reports the same one: permission, then payload shape, then account found and not protected (edit), then version (edit), then parent, then code format, then code range, then has-postings (edit of code or parent), then code and name uniqueness. P13 depends on this order.

### 8.10 Edge cases

| Case | Outcome |
|---|---|
| Two users create the same code at the same time | One commits. The other gets `ACCOUNT_CODE_TAKEN` from the unique constraint |
| A code edit races the account's first posting | Serialised (R8). Either the edit commits first and the posting lands on the same account id under its new code, or the posting commits first and the edit is rejected with `ACCOUNT_HAS_POSTINGS` |
| A name that differs only in case from an existing postable account (`rent` beside `Rent`) | `ACCOUNT_NAME_TAKEN` |
| A name equal to a header's name | Allowed. Names must be unique among postable accounts only (§5) |
| A user names an ordinary account "Accounts Receivable — Other" | Allowed, and it is still not a control account: it can take manual JVs and is outside Invariant 9. A name cannot make an account a control account. Anyone reviewing a tenant's chart should be aware of this |
| The parent's block is full (all 999 codes used) | Any further code is rejected with `ACCOUNT_CODE_OUT_OF_RANGE`. On `standard-v1` this will not happen in practice |
| Renaming an account that has lines in a closed period | Allowed. The closed period's figures do not change, and its regenerated report shows the new name (§8.3) |
| An account whose only postings were reversed | It still has postings, so its code and parent are frozen |
| An account created in tenant A, and a JV posted by tenant B that names its id | `ACCOUNT_NOT_FOUND`, from RLS plus the composite FK. Unchanged from M2 |

### 8.11 Golden

[P13](../../tests/accounting/golden/posting-p13-coa-create-and-rename.json) creates 6600 and rejects six invalid creates. It posts to 6600 and checks the trial balance and the account ledger. It renames 6600 and proves that no line, figure or entry count moves. It rejects a code edit, a parent edit, a stale-version edit and edits to protected accounts. Finally it re-codes and re-parents a second account before that account's first posting. The scenario is specified and hand-computed, and it is **PENDING**: it becomes executable once migration 018 and the kernel's create and edit functions exist.
