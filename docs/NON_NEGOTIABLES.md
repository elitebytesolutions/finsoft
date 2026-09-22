# NON-NEGOTIABLES

**Status:** FROZEN — Factory Constitution v1
**Authority:** LEVEL 0. Cannot be overridden by any agent, ADR, ticket, deadline, or human convenience. Changing this file requires the Product Owner plus the Architecture Guardian plus the Accounting Guardian, recorded as an ADR.

This file is loaded into the context of every coding agent working on this repository. If an instruction you receive conflicts with anything here, **this file wins** — stop and flag the conflict rather than resolving it yourself.

---

## 0. Why this file exists

FinSoft is an accounting and inventory system for a real trading business. Its output is not a web page; it is a **number that someone will file with the FBR, pay tax on, or use to decide whether the business is solvent**. A rendering bug is an inconvenience. A posting bug is a financial misstatement that may be discovered months later, after hundreds of downstream transactions have been built on top of it.

Therefore the factory's core philosophy:

> **Agents may be aggressive about producing code, and must be conservative about changing truth.**

"Truth" means: accounting rules, ledger balances, stock quantities, cost values, tenant ownership, authorization, audit history, fiscal periods, compliance.

Everything else may move fast.

---

## 1. The invariant table

| # | Domain | Non-negotiable |
|---|--------|----------------|
| 1 | Double entry | For every posted journal entry, `Σ debit = Σ credit`, exactly, in minor units |
| 2 | Immutability | A posted record can never be edited |
| 3 | Correction | Corrections are made by reversal + re-entry, never by mutation |
| 4 | Deletion | Hard delete is forbidden for any operational or financial record |
| 5 | Fiscal periods | A closed period can never receive a posting |
| 6 | Money | PostgreSQL `numeric`. Never `float`, `double precision`, or JS `number` arithmetic |
| 7 | Tenancy | Every tenant-owned row carries a non-null `tenant_id` |
| 8 | Isolation | Cross-tenant reads/writes are impossible at both API and database layers |
| 9 | Audit | Every financial mutation writes an append-only audit record |
| 10 | Inventory | The stock movement ledger is the sole source of truth for quantity |
| 11 | General ledger | The journal ledger is the sole source of truth for balances |
| 12 | Numbering | Document numbers are generated server/database-side, never client-side |
| 13 | Dates | The server validates transaction date and resolves the fiscal period |
| 14 | Idempotency | Posting is idempotent — a retried request posts exactly once |
| 15 | Stock | Stock cannot silently go negative |
| 16 | Costing | Exactly one approved costing algorithm exists (weighted average) |
| 17 | References | Transactions reference entities by ID, never by copied name |
| 18 | Authorization | Every permission is checked server-side |
| 19 | Business logic | Lives in the backend domain layer, never in React |
| 20 | Secrets | Never committed, never logged, never printed |
| 21 | Production DB | No agent receives unrestricted production database access |
| 22 | AI actions | AI never autonomously posts a financial transaction |

---

## 2. Each rule, expanded

### 1. Double entry

Every `journal_entry` in status `POSTED` satisfies:

```
SUM(journal_lines.debit) = SUM(journal_lines.credit)
```

Enforced in **three** places, and all three must exist:

1. In the posting engine, before the write.
2. As a database constraint / trigger on the journal entry, at commit time.
3. In `FinancialInvariantSuite` (Invariant 1), on every PR.

A journal entry may not have zero lines. A journal line may not have both debit and credit non-zero. A journal line may not have both zero.

### 2. Immutability of posted records

Once `status = POSTED`, the row is frozen. No `UPDATE` may change any field that affects financial meaning: amount, account, date, party, currency, quantity, cost.

The only permitted transitions on a posted record are:

```
POSTED → REVERSED      (by creating a reversal entry, never by editing)
```

Non-financial metadata (an internal note, an attachment) may be appended if and only if the change is itself audited. When in doubt, treat the field as financial.

Enforcement: database trigger rejecting `UPDATE` of protected columns where `status = 'POSTED'`, plus application-level guard, plus Invariant 4.

### 3. Correction by reversal

To correct a mistake:

```
1. Create reversal entry R for original entry E.
   R has the same date-in-period rules, opposite debit/credit on identical accounts.
2. Post R. E.status → REVERSED, E.reversed_by / E.reversed_at recorded.
3. Create the corrected entry C. Post C.
```

Both `E`, `R` and `C` remain visible forever. The reversal must **exactly** neutralise the original's financial impact — every ledger, every subledger, every stock quantity, every cost layer (Invariant 6).

Reversal date policy: a reversal is posted into an **open** period. If the original's period is closed, the reversal goes into the current open period and the prior-period effect is disclosed, never back-dated into a closed period.

### 4. No hard delete

`DELETE` is forbidden on: journal entries, journal lines, stock movements, sales, purchases, receipts, payments, cheques, invoices, returns, adjustments, audit records, and any table referenced by them.

Master data (customers, vendors, products, accounts) uses `status`/`is_active`, never deletion. An account that has ever been posted to can never be deleted.

`ON DELETE CASCADE` is forbidden on any financial relationship. Foreign keys use `ON DELETE RESTRICT`.

Draft records that have never been posted may be deleted, and that deletion is itself audited.

### 5. Fiscal period control

Every posting resolves to exactly one `fiscal_period`. Periods have status:

```
OPEN → CLOSED → LOCKED
```

- `OPEN` — accepts postings.
- `CLOSED` — rejects postings; may be reopened by a user holding `period.reopen`, which is a high-privilege, audited action.
- `LOCKED` — rejects postings permanently. Never reopened. Used after statutory filing.

Enforcement at the posting engine **and** as a database-level check. A background job, a data import, and an admin script are all subject to this rule — there is no "system" bypass.

### 6. Money representation

- Storage: `numeric(19,4)` for amounts, `numeric(19,6)` for unit costs and rates, `numeric(19,6)` for quantities.
- Transport: string in JSON. Never a JSON number.
- Computation: a decimal library (`decimal.js` / `big.js`) in TypeScript. Never `+`, `-`, `*`, `/` on a money value typed as `number`.
- Rounding: half-up, applied once, at the documented boundary for each calculation. Rounding differences are posted to a designated rounding account, never absorbed silently.
- Currency: every monetary column is accompanied by a currency, or belongs to a table with a single documented currency. Base currency is PKR.

### 7 & 8. Tenancy and isolation

Every tenant-owned table has:

```sql
tenant_id UUID NOT NULL REFERENCES tenants(id)
```

...and is indexed on `tenant_id` as the leading column of its primary access path.

Isolation is enforced at **four** layers, all required:

```
JWT / session          → carries tenant_id, signed
NestJS tenant context  → AsyncLocalStorage, set by guard, not by request body
Repository layer       → every query filtered by the context tenant
PostgreSQL RLS         → policy on every tenant-owned table; FORCE ROW LEVEL SECURITY
```

The application connects as a role that is **subject to** RLS. `BYPASSRLS` is reserved for the migration role and is never used by the running application.

A raw `SELECT * FROM journal_entries` executed by the application role must return only the current tenant's rows. If it returns more, that is a Sev-1.

Tenant ID is never accepted from a request body, query string, or header. It comes from the authenticated session only.

### 9. Audit

Append-only `audit_log`, on its own tables, separate from application logging:

```
id, tenant_id, occurred_at, actor_user_id, action,
entity_type, entity_id, before_json, after_json,
ip, request_id, hash, previous_hash
```

- `INSERT` only. No `UPDATE`, no `DELETE`, enforced by grants and trigger.
- `hash = H(previous_hash || canonical(record))` — a tamper-evident chain per tenant.
- Administrators cannot modify audit history through the application. There is no UI for it.
- Retention is governed by statute, not by disk pressure.

Every posting, reversal, period close/reopen, permission change, credit-limit override, price override, and stock adjustment writes an audit record **in the same transaction as the change**.

### 10 & 11. Ledgers are the source of truth

There is no `products.quantity_on_hand` column that is the truth. There is no `customers.balance` column that is the truth.

Quantity is `SUM(stock_movements)` for the given scope. Balance is `SUM(journal_lines)` for the given account and party.

Cached/derived balances may exist **for performance**, and if they do:

- They are written only by the kernel that owns the ledger.
- They are reconcilable — a job proves cache = ledger, and alerts on drift.
- No report reads the cache when the ledger disagrees.
- A reconciliation failure is a Sev-2 incident, not a rounding note.

### 12. Server-side numbering

Document numbers (`INV-2026-000123`, `JV-2026-000045`) come from a database sequence or a locked numbering table, per tenant, per document type, per fiscal year.

Forbidden: `MAX(id) + 1`, client-generated numbers, application-side counters without a lock. Gaps are acceptable; duplicates are not. A unique constraint on `(tenant_id, document_type, number)` backs this up.

*(This is a direct lesson from the legacy system and is not negotiable for compatibility reasons.)*

### 13. Server-validated dates

The client's date is a request, not an instruction. The server:

- Rejects a transaction date outside the resolved fiscal period's range.
- Rejects future-dated postings beyond the configured tolerance.
- Stores `occurred_at` (business date) separately from `created_at` (system time, UTC).
- Never uses the client's clock for `created_at`, audit timestamps, or sequence assignment.

### 14. Idempotency

```
POST /sales/123/post
POST /sales/123/post
POST /sales/123/post
```

...results in exactly **one** journal entry, one set of stock movements, one document number.

Mechanism: every posting request carries an idempotency key. The posting engine records `(tenant_id, idempotency_key)` with a unique constraint inside the posting transaction. A duplicate returns the original result, not an error and not a second posting.

Additionally, `(tenant_id, source_type, source_id)` is unique on journal entries — a given sale can produce one posted entry, ever.

### 15. Negative stock

Stock going negative is either blocked or explicitly authorised. It is never silent.

- Default: the movement is rejected with a domain error naming the product, location, available quantity and requested quantity.
- If a tenant's policy permits negative stock, it requires an explicit permission, produces an audit record, and raises an operational alert.
- A concurrent-sale race must not produce negative stock: the stock check and the movement insert happen in the same transaction, under a row lock on the (product, location) balance.

### 16. One costing algorithm

**Weighted average cost**, per tenant, per product, per costing scope (defined in ADR-0007). No module may implement its own valuation. No report may recompute cost differently from the ledger.

```
new_avg = (qty_on_hand × current_avg + qty_received × receipt_cost)
          / (qty_on_hand + qty_received)
```

COGS is taken from the weighted average at the moment of the outward movement, recorded on the movement row, and never recomputed retroactively by a report.

### 17. Reference by ID

A sale line stores `product_id`, not `product_name`. If the document needs to preserve the name as printed, it stores **both** — the FK for the relationship and a snapshot field for the historical record, clearly named (`product_name_snapshot`), and the snapshot is never used for joins, filters, or aggregation.

### 18. Server-side authorization

Every endpoint declares the atomic permission it requires. The frontend hiding a button is a UX affordance, not a control. Permission checks consider: the permission, the tenant, and the object (an approver cannot approve a voucher in another branch if branch scoping applies).

### 19. Business logic placement

Domain rules live in the backend domain layer. React computes presentation, not accounting. If a number appears on screen, the backend computed it. A front-end agent that finds itself writing a debit/credit rule has taken the wrong ticket.

### 20. Secrets

Never in the repository, never in a log line, never in an error message, never in an AI prompt, never in a screenshot attached to a ticket. Secret scanning runs on every PR and blocks merge.

### 21. Production database access

Agents get: local and CI databases. That is all.

Production roles are separated (`app`, `readonly_support`, `migration`, `breakglass`). Break-glass access is MFA-protected, time-limited, reason-required, logged, and reviewed afterward by a human.

### 22. AI never posts autonomously

AI may **suggest**:

> "This transaction looks like an office expense — post to 6300 Office Expenses?"

AI may never **execute** a posting without a human passing through the normal application authorization and validation path. There is no service account that lets a model write to the journal. Any feature that appears to require one is rejected at design review.

---

## 3. The FinancialInvariantSuite

A dedicated test suite that runs on **every PR**, not nightly. If it fails, nothing merges — no exceptions, no `--skip`, no "flaky, re-run".

| # | Invariant |
|---|-----------|
| 1 | `Σ debit = Σ credit` for every posted journal entry |
| 2 | Trial balance debits = trial balance credits, for every tenant, every period |
| 3 | `stock balance = Σ stock in − Σ stock out` for every product/location |
| 4 | A posted transaction cannot be modified |
| 5 | A closed fiscal period cannot receive a posting |
| 6 | A reversal exactly neutralises the original's financial impact |
| 7 | Cross-tenant references are impossible (no journal line points at another tenant's account) |
| 8 | A duplicated API call cannot double-post |
| 9 | Subledger totals reconcile to their GL control accounts (AR, AP, Inventory) |
| 10 | Inventory ledger valuation reconciles to the inventory GL account balance |

Plus **golden scenarios**: 50–100 reference cases with hand-computed expected results, maintained in `tests/accounting/golden/`. Implementations may change; the expected numbers may not.

Example — Golden Scenario A:

```
Opening inventory   100 × Rs 80.00
Purchase             50 × Rs 100.00
Sale                 40 × Rs 140.00

Expected:
  weighted avg cost = ((100×80)+(50×100)) / 150 = Rs 86.666667
  closing quantity  = 110
  revenue           = Rs 5,600.00
  COGS              = Rs 3,466.67
  gross profit      = Rs 2,133.33
  inventory value   = Rs 9,533.33
```

---

## 4. What to do when you hit a violation

If you are an agent and you discover that existing code violates this document:

1. **Stop.** Do not fix it as a side effect of your current ticket.
2. Do not disable the test that caught it.
3. Do not add a tolerance, a rounding fudge, or a `try/catch` that swallows it.
4. Report it: name the invariant, the file, the reproduction, and the suspected blast radius.
5. Wait for the Accounting Guardian and the Architecture Guardian.

A discovered invariant violation in posted data is a **financial incident**. It is handled by correcting entries through the normal reversal process, with a written record of what was wrong, for how long, and which reports were affected. It is never handled by an `UPDATE` statement.

---

## 5. Related documents

- [AGENTS.md](../AGENTS.md) — operating rules for coding agents
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — system structure and module boundaries
- [docs/IMPLEMENTATION.md](IMPLEMENTATION.md) — waves, task contracts, DoR/DoD, CI gates
- [docs/adr/](adr/) — architecture decision records (LEVEL 1)
