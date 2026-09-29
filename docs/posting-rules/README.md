# Posting rules

**Owner:** Accounting seat of the Technical Council ([ADR-0024](../adr/ADR-0024-operating-model.md), [OPERATING_MODEL.md](../OPERATING_MODEL.md) §2)
**Authority:** these documents are the reviewable surface [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) requires — *"each [financial event] maps to a declarative posting rule in `docs/posting-rules/`, reviewed by the Accounting Guardian and implemented once."* They sit **below** [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) (LEVEL 0) and the ADRs (LEVEL 1), and **above** the kernel code. If code and a rule disagree, the code is wrong. If a rule and an ADR disagree, stop and raise it; do not resolve it in either file.
**Risk tier:** everything under this directory is **T3** (`tools/ci/risk-tiers.json`).
**Created:** 2026-09-27, task M2-000.

---

## 1. What is in this directory

| Document | Rule id(s) | Status | Implemented in |
|---|---|---|---|
| [coa-standard.md](coa-standard.md) | `COA/standard-v1` | APPROVED | M2 — migration 010 + tenant seeding |
| [journal-voucher.md](journal-voucher.md) | `JOURNAL_VOUCHER_POSTED@1` | APPROVED | M2 — `postingEngine` |
| [reversal.md](reversal.md) | `REVERSAL@1` | APPROVED | M2 — kernel reversal engine |
| [periods.md](periods.md) | `PERIODS/monthly-v1`, `PERIOD_CLOSED@1` | APPROVED | M2 — migration 011 + kernel |
| [ledger-and-trial-balance.md](ledger-and-trial-balance.md) | `REPORT/account-ledger@1`, `REPORT/trial-balance@1` | APPROVED | M2 — ledger + trial balance |
| [service-sale.md](service-sale.md) | `SALE_POSTED/service@1` | APPROVED — Council decision recorded | M3 |
| [customer-receipt.md](customer-receipt.md) | `CUSTOMER_PAYMENT_RECEIVED@1` | APPROVED | M3 |

Golden scenarios for every rule above live in [`tests/accounting/golden/`](../../tests/accounting/golden/), files `posting-p01-*.json` … `posting-p12-*.json` (§6).

**Amendments of 2026-09-28 (M3-000c, Accounting seat).** Customer receipts gain a draft lifecycle (Product Owner decision, 2026-09-28; [customer-receipt.md](customer-receipt.md) §1.1, ruling R-1). Sales invoice drafts are likewise cancelled, never deleted (Product Owner, 2026-09-28; [service-sale.md](service-sale.md) §2, ruling R-3). An inactive customer may be paid but not invoiced ([customer-receipt.md](customer-receipt.md) ruling R-2). The party foreign key now runs to the kernel's `parties` registry ([ADR-0026](../adr/ADR-0026-journal-line-party-dimension.md); §4.1, §5). Customer codes are system-generated (Product Owner, 2026-09-28) and appear in no rule (§6). No payload, entry, amount or expected figure of P01–P10 changed.

**Not specified, and therefore not postable:** every other member of the `FinancialEvent` set — `SALE_RETURNED`, `PURCHASE_*`, `SUPPLIER_PAYMENT_MADE`, `CHEQUE_*`, `STOCK_*`, `EXPENSE_RECORDED`, `OPENING_BALANCE_LOADED` — and the `STOCK` line kind and `CASH` settlement of `SALE_POSTED`. The kernel rejects an event or variant whose rule is not `IMPLEMENTED` with `RULE_NOT_ENABLED`. It does not fall back to a nearby rule. **No sales tax rule exists** (Product Owner, 2026-09-27: no sales tax in the MVP); any tax field in a payload is a schema rejection, never a zero.

---

## 2. The shape of a rule

Every rule document uses these headings, in this order. A rule missing one is not finished.

```
RULE            id, version, status
EVENT           the FinancialEvent member (closed set, ADR-0005)
TRIGGER         the business action that raises it — and the one that does NOT
PRECONDITIONS   what must hold before any line is built
PAYLOAD         typed facts, amounts as strings; never an account code or a direction
ENTRY           the exact lines, by account ROLE, with Dr/Cr
RESOLUTION      how each role resolves to an account for this tenant
AMOUNTS         how each amount is derived; the ONE rounding boundary, or "none"
SUBLEDGER       the customer / vendor / stock effect, and what is NOT a GL line
REVERSAL        what reversing it must undo, everywhere
IDEMPOTENCY     the key, the source uniqueness, the replay behaviour
EDGE CASES      zero, partial, cross-period, concurrency, what is deferred
ERRORS          stable domain error codes
GOLDEN          the scenario file(s) that pin it
```

### 2.1 Accounts are named by role, never by code

A rule says `Dr AR_CONTROL`, not `Dr 1200`. The kernel resolves a role to exactly one active, postable account of the posting tenant ([coa-standard.md](coa-standard.md) §4). This is what makes a tenant-specific chart — Bhatti's legacy tree in Wave 10 — a configuration change rather than a rule change ([ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) "per-tenant variation is configuration"). A role that does not resolve is a loud configuration error, `ACCOUNT_ROLE_UNMAPPED`; the kernel never guesses a substitute.

The one exception is `JOURNAL_VOUCHER_POSTED`, whose payload carries account ids because it *is* manual entry — and which is fenced accordingly ([journal-voucher.md](journal-voucher.md) §4).

### 2.2 Amounts

| Rule | Detail |
|---|---|
| Representation | Decimal **strings** everywhere: payloads, golden files, API. Amounts at exactly 4 dp (`"10000.0000"`), quantities and unit prices at 6 dp (`"3.000000"`, `"833.333333"`) — [ADR-0011](../adr/ADR-0011-money-representation.md). A JSON number is a rejection (`AMOUNT_NOT_STRING`), not a coercion |
| Input scale | An input carrying more decimals than its scale is rejected (`AMOUNT_SCALE`), never rounded on the way in — [ADR-0014](../adr/ADR-0014-decimal-js.md) `Money.from` |
| Sign | Journal lines carry a non-negative `debit` and a non-negative `credit`, exactly one of them non-zero ([NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rule 1). Direction is the column, never a sign |
| Exactness | `Σ debit = Σ credit` is compared at **storage scale, 0.0001** — stricter than the paisa. No tolerance, anywhere, ever |
| Arithmetic | `Money` / `Quantity` / `UnitCost` from `packages/validation`. No `number` arithmetic on a monetary value |

### 2.3 Rounding

Each rule states its **single** rounding boundary, half-up ([ADR-0011](../adr/ADR-0011-money-representation.md) §Rounding), or states "none". For the MVP rules:

| Rule | Rounding boundary |
|---|---|
| `JOURNAL_VOUCHER_POSTED@1` | **None.** The user's amounts are the amounts. An unbalanced voucher is rejected, never completed |
| `REVERSAL@1` | **None.** Stored amounts are copied with Dr/Cr swapped ([ADR-0014](../adr/ADR-0014-decimal-js.md): reversals do not re-round) |
| `SALE_POSTED/service@1` | **Per line:** `lineNet = round_half_up(quantity × unitPrice, 4)`. Invoice total = Σ lineNet, unrounded. No residual can arise |
| `CUSTOMER_PAYMENT_RECEIVED@1` | **None.** Allocations are user-entered amounts that must sum exactly |

The `ROUNDING` role account ([coa-standard.md](coa-standard.md)) therefore receives **no posting from any MVP rule**. That is asserted by the golden scenarios (`roundingAccountBalance: "0.0000"`), so a later change that starts routing residuals there shows up as a failing expectation rather than a quiet line.

A rule never "completes" an entry. There is no code path that adds a balancing line to make an entry balance — an imbalance is a rejection with the difference in the error (Accounting Guardian absolute stop).

### 2.4 Every entry records the rule it was posted under

`journal_entries` stores the rule id and version (e.g. `SALE_POSTED/service@1`). A rule change is a new version; it never reinterprets a posted entry, and reversal copies the entry's stored lines rather than re-running any rule ([reversal.md](reversal.md)). Requirement on migration 012.

---

## 3. Versioning and change

```
PROPOSED ──► APPROVED ──► IMPLEMENTED ──► SUPERSEDED
             Accounting    kernel code +      by @n+1; the old
             seat signs,   golden executing   version's document
             golden in     in the financial   stays, marked
             the same PR   gate               SUPERSEDED
```

1. **Who decides.** The Accounting seat. Adding a financial event, adding a variant or line kind, or changing any mapping, amount derivation or rounding boundary is an Accounting seat decision — never a side effect of a feature ticket ([ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) §Governance). A new *event* additionally needs the Architecture seat, because the event set is closed at LEVEL 1.
2. **Golden first, same PR.** A rule change and its golden scenario land in the **same** PR, with hand-computed expected numbers ([ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md) Compliance). A rule without a golden scenario is `PROPOSED`, however complete its prose.
3. **Once `IMPLEMENTED`, never edited in place.** Changing an implemented rule means writing `@n+1`, which applies to postings made after it ships. Entries posted under `@n` keep `@n` forever.
4. **Before `IMPLEMENTED`,** an `APPROVED` rule may be amended by the Accounting seat, with its golden scenarios amended in the same commit and the reason in the commit message.
5. **Expected numbers change only with the Accounting seat**, and the reason goes in the commit ([golden README](../../tests/accounting/golden/README.md)). If code makes a golden scenario fail, the code is wrong.
6. **A tax rule is never inferred.** If a change touches tax and the rule is not written here, work stops (CLAUDE.md "Stop and ask").

---

## 4. The kernel contract every rule relies on

The pipeline is [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md)'s eleven steps. The rules here depend on these properties of it, stated once:

| Property | Specification |
|---|---|
| Idempotency first | Step 2 runs before the period check. A replay of a request that already posted returns the original result **even if its period has since closed** — a replay is not a posting |
| Key semantics | `idempotencyKey`: 1–128 chars, `[A-Za-z0-9._:-]`, client-generated (the UI generates a UUID per form submission). Unique per `(tenant_id, idempotency_key)`, retained forever. Same key + same request fingerprint → the original result. Same key + different fingerprint → `IDEMPOTENCY_KEY_REUSED`, nothing posted |
| Fingerprint | Canonical form of `(event, referenceType, referenceId, occurredAt, actor user id, payload)` |
| Rejected requests leave no trace | A rejected posting rolls back the caller's transaction: no key recorded, no number consumed, no entry, no audit record of a posting |
| Concurrency | Two concurrent requests with the same key: the second waits on the unique index, then returns the first's result; if the first rolled back, the second proceeds |
| Source uniqueness | `UNIQUE (tenant_id, source_type, source_id)`: one entry per source document, ever. A second post of the same source under a *different* key → `SOURCE_ALREADY_POSTED`, naming the existing entry |
| Numbering | Assigned at step 8, **after** all validation, from the `document_sequences` row taken `FOR UPDATE` in the posting transaction. A rejected or rolled-back posting consumes no number. Format `{SERIES}-{FY}-{NNNNNN}`, per tenant, per series, per fiscal year (FY label per [periods.md](periods.md) §2) |
| Series | `JV` manual journal vouchers · `RV` reversals · `JE` entries raised by a source document (sales invoice, receipt). Documents carry their own numbers from the same facility: `INV` sales invoices, `RCT` customer receipts (M3) |
| Business date | `occurredAt` is a date in the tenant's timezone (default `Asia/Karachi`). Server-validated: it must resolve to an `OPEN` period and must not be after *today* in that timezone (future tolerance **0 days** in the MVP — [periods.md](periods.md) §5) |
| Audit | One audit record per posting, same transaction, hash-chained ([ADR-0020](../adr/ADR-0020-audit-hash-chain-canonicalisation.md)); a reversal also records the original's status transition |
| No bypass | No actor — job, import, script, admin, AI — posts outside this path. There is no service account that posts ([NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rule 22) |
| Entry status | `journal_entries.status ∈ {POSTED, REVERSED}`. The journal has no draft state; drafts live in the source document's table |

### 4.1 Journal line dimensions

A line carries a **party** (`CUSTOMER` in the MVP; `VENDOR` from Wave 6) **if and only if** its account is a control account of the matching kind:

```
account.control = AR   ⇔  line.party_type = 'CUSTOMER' and line.party_id is not null
account.control = AP   ⇔  line.party_type = 'VENDOR'   and line.party_id is not null
otherwise              ⇒  line.party_type is null and line.party_id is null
```

`party_id` is an id in the kernel's `parties` registry. For a customer it is the customer's own id, because `customers.id` is its party id ([ADR-0026](../adr/ADR-0026-journal-line-party-dimension.md)). The line stores the id only, never a name or a customer code (rule 17).

This is what makes Invariant 9 structural: no AR-control line can exist without a customer, so `Σ customer ledgers = AR control balance` holds by construction and the invariant test checks the document subledger against it ([customer-receipt.md](customer-receipt.md) §8).

---

## 5. Hand-offs these rules create

Stated here so no lane infers them. None is decided by this directory.

| To | What the rules require | Decided by |
|---|---|---|
| Migration 010 `accounts` | Kind (header/postable), type, normal balance, control kind, role (unique per tenant among active accounts), manual-JV eligibility, `is_active`; no delete; type/kind/control immutable once posted to ([coa-standard.md](coa-standard.md) §5) | Database seat |
| Migration 011 `fiscal_periods` | Monthly periods, FY label, contiguity, exclusion constraint, transition trigger incl. in-order close/lock ([periods.md](periods.md)) | Database seat |
| Migration 012 journal | `posting_rule` (id@version), `reversal_of` (unique), `reversed_by`/`reversed_at`, `reversal_reason`, `source_type`/`source_id` unique, idempotency key + fingerprint, party columns and the §4.1 check. **The party FK target is the kernel-owned `parties` registry, which 012 itself creates**, not `customers`: `journal_lines (tenant_id, party_type, party_id) → parties (tenant_id, party_type, id)`. A customer's id *is* its party id. `customers` (migration 014, M3) has a foreign key *to* `parties`, and no kernel table references a module table. §4.1 is declarative, through `account_control` | **Decided — [ADR-0026](../adr/ADR-0026-journal-line-party-dimension.md), Accepted 2026-09-28** (Database/Security + Architecture seats) |
| Migration 013 `document_sequences` | Series × FY counters, row-locked, gapless on the success path (§4) | Database seat |
| Existing tenants | `BHATTI1`/`BHATTI2` exist before 010/011 run. COA seeding and period creation must reach tenants that already exist, not only new ones | Database seat |
| Kernel clock | "Today" in the tenant timezone is an input to the future-date check and the reversal date rule; the golden scenarios fix `today`. The kernel needs an injectable clock | Architecture seat |
| Kernel reversal API | Document-sourced entries are reversed only via their owning module ([reversal.md](reversal.md) §5); the call shape is Architecture's | Architecture seat |

---

## 6. Golden scenarios for posting rules

Scenario A ([`scenario-a.json`](../../tests/accounting/golden/scenario-a.json)) has a costing-specific shape read by `golden-scenarios.spec.ts`. Posting scenarios need steps, rejections and checkpoints, so they use an **extended format, `posting-scenario/v1`**, in new files beside it. `golden-scenarios.spec.ts` reads `scenario-a.json` by name, so the new files are inert until the **M2 QA lane** writes the runner. Nothing in test code was changed by M2-000.

```jsonc
{
  "id": "P01",
  "format": "posting-scenario/v1",
  "name": "…",
  "rules": ["JOURNAL_VOUCHER_POSTED@1"],        // rule ids under test
  "source": "docs/posting-rules/journal-voucher.md",
  "governedBy": ["ADR-0005", "…"],
  "executableFrom": "M2",                        // M2 or M3; a step may override
  "description": ["…"],
  "fixture": {
    "coa": "standard-v1",
    "timezone": "Asia/Karachi",
    "fiscalYearStartMonth": 7,
    "today": "2026-09-27",                       // the kernel clock, tenant timezone
    "periods": { "fiscalYear": 2027, "status": "all OPEN" },
    "tenants": ["GOLDEN_A"],
    "customers": [{ "ref": "CUST-A", "tenant": "GOLDEN_A" }]
  },
  "steps": [
    {
      "step": 1,
      "do": "post",                               // post | reverse | reverseDocument | period | assert
                                                  // | saveDraft | editDraft | cancelDraft | customer  (P11, P12)
      "event": "JOURNAL_VOUCHER_POSTED",
      "idempotencyKey": "p01-1",
      "occurredAt": "2026-09-01",
      "payload": { "narration": "…", "lines": [{ "account": "1120", "debit": "500000.0000" }] },
      "expect": {
        "outcome": "POSTED",                      // POSTED | REPLAYED | REJECTED | TRANSITIONED
        "entryNumber": "JV-2027-000001",
        "period": "2026-09",
        "lines": [{ "account": "1120", "debit": "500000.0000", "credit": "0.0000" }],
        "totals": { "debit": "…", "credit": "…" }
      }
    },
    { "step": 2, "do": "assert", "trialBalance": { "asOf": "2026-09-27", "rows": [], "totals": {} } }
  ]
}
```

Conventions:

- Accounts are referenced by their **`standard-v1` code**; customers, invoices and receipts by fixture `ref`. The runner resolves them to ids when it builds the fixture. That is a test-fixture convenience — rule 17 (reference by id) governs what the kernel stores, and the runner must pass ids.
- **A customer `ref` (`CUST-A`, `CUST-B`) is a fixture label, not a customer code.** Customer codes are system-generated (Product Owner, 2026-09-28). No posting rule, payload or expected figure depends on a code, whether user-entered or generated. The kernel stores the party id and nothing else. The runner must not create customers with the ref as their code, and must not assert any code. `[CUST-A]` in a rule's worked example means "the party id of fixture customer CUST-A".
- **Document lifecycle steps (from P11).** `saveDraft` creates a draft document (`document`: the fixture ref, `fields`: its content). `editDraft` changes a draft's fields. `cancelDraft` moves a draft to `CANCELLED`. `customer` changes customer master data (`action`: `deactivate` | `reactivate`). None of them reaches the posting engine. Each asserts `journalEntriesWritten: 0`, the document's status, and `documentNumber: null` while no number has been assigned. A `post` step whose `referenceId` names a saved draft posts that draft as it currently stands.
- `expect.lines` lists the entry's lines in a canonical order: debits before credits, then by account code, then by party ref. The kernel may store any order; the runner sorts before comparing.
- Trial balance rows list every account **with activity** up to `asOf`, including those whose balance is zero; each row carries `debit` and `credit` columns per [ledger-and-trial-balance.md](ledger-and-trial-balance.md) §3.
- Running balances are **signed, debit-positive** strings (`"-6000.0000"` is a 6,000 credit balance).
- A `REJECTED` step names its `error` code and asserts `entriesAfter` — the count that proves nothing was written.
- Every expected figure was computed by hand, and the computation is in the scenario's `description` or `$comment`.

| File | Covers | Executable from |
|---|---|---|
| `posting-p01-jv-simple.json` | Two-line JV; TB | M2 |
| `posting-p02-jv-multi-line.json` | Four-line JV; decimal amounts; TB | M2 |
| `posting-p03-jv-rejections.json` | Every JV validation rejection; no number consumed | M2 |
| `posting-p04-service-invoice.json` | Service invoice 10,000.0000; per-line rounding; MVP variant fences | M3 |
| `posting-p05-customer-receipt.json` | Partial receipt 6,000.0000; customer ledger 4,000.0000; allocation rejections | M3 |
| `posting-p06-reversal.json` | Invoice reversal blocked by allocation; receipt reversal; invoice reversal; reversal-of-reversal rejected; TB to zero | M3 (the kernel's reversal of a JV is exercised from M2 by P07) |
| `posting-p07-closed-period.json` | Closed and locked period rejection; reversal of a closed-period entry into the open period; replay after close; no period; future date; out-of-order close | M2 |
| `posting-p08-idempotent-retry.json` | Three identical requests → one entry; key reuse; content duplicates are not key duplicates; source uniqueness | M2 (JV steps) · M3 (invoice steps) |
| `posting-p09-mvp-journey.json` | The whole MVP journey in two tenants; TB at each checkpoint; final TB balances with reversed pairs at zero | M3 |
| `posting-p10-service-line-rounding.json` | A true half-way tie at the line boundary: half-up versus half-even and truncation | M3 |
| `posting-p11-receipt-draft-lifecycle.json` | Receipt drafts have no GL, allocation or numbering effect; a draft in a since-closed period is rejected, re-dated and posted; a stale proposal is rejected at post; draft → cancel; replay of the post | M3 |
| `posting-p12-inactive-customer.json` | An inactive customer cannot be invoiced (no number consumed) but is paid in full against its open invoice | M3 |
