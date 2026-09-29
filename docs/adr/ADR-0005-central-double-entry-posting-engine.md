# ADR-0005: One central double-entry posting engine

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

---

> ## ⛔ Partial supersession — pipeline step 2 (:56) is no longer in force
>
> **This ADR is still in force**, and this notice is permanent. Its `Status:` stays `Accepted`. The notice records status only, and the decision, rationale and consequences below stay exactly as accepted, per [the ADR README](README.md) §4. Because the supersession is partial, this record does not become `Superseded by ADR-0027`.
>
> [ADR-0027](ADR-0027-posting-idempotency-resolved-against-the-journal.md) (**Accepted 2026-09-28**) supersedes **step 2 of the pipeline and nothing else in this record**. It also clarifies one field-table cell without changing it. The body below still states :56 as an unqualified rule, and this notice is the only thing that says otherwise, which is why it is not removed:
>
> | Provision | Under ADR-0027 |
> |---|---|
> | Line 56: "├─ 2  idempotency: INSERT (tenant_id, idempotency_key) → on conflict, return prior result" | **No longer in force.** Read instead: step 2 is a *lookup* in `journal_entries` by `(tenant_id, idempotency_key)`, and then by source. A replay returns the prior result. `journal_entries`' unique index is the only idempotency record. Numbering and the entry INSERT (`ON CONFLICT DO NOTHING`) run inside one kernel savepoint, `finsoft_posting_number`, which is rolled back on a lost race so that no number is consumed |
> | Line 48: "The kernel never opens its own." | **In force, clarified.** The kernel opens, commits and rolls back no transaction. Inside the caller's `tx` it may issue that one named savepoint (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`) and no other transaction-control statement |
>
> Everything else stays in force: steps 1 and 3–11 in ADR-0005's order, the field table, and Compliance :165's `UNIQUE (tenant_id, idempotency_key)`, which is the index ADR-0027 resolves against.
>
> **Before changing the posting pipeline, read ADR-0027.** For step 2 it, not the line below, is the operative rule. Nothing is blocked on this record.
>
> **Line numbers.** Every `ADR-0005:NN` citation in the repository was written against the **as-accepted** text. This notice adds 21 lines at the head, so an as-accepted line NN is now at NN+21: :48 → 69, :56 → 77. Citations are not rewritten. The notice is permanent, so the offset is permanent and fixed at +21. Any later edit here must preserve its line count.

---

## Context

A dozen modules — sales, procurement, banking, cheques, inventory, tax, HR, administration — all end in a journal entry. If each builds its own debits and credits, the system acquires a dozen implementations of double entry, each with its own account resolution, its own period check, its own rounding, its own idempotency handling, and its own bugs.

That is how the legacy system arrived at reports containing their own correction logic ([PRD.md §3](../PRD.md)): once posting logic is scattered, a fix in one path does not fix the others, and the "adjustment" accumulates in the report layer where nobody can audit it.

The invariants at stake are LEVEL 0 and apply to every posting regardless of which module caused it: `Σ debit = Σ credit` exactly (rule 1), a closed period never receives a posting (rule 5), posting is idempotent (rule 14), every financial mutation writes an audit record in the same transaction (rule 9), document numbers are server-generated (rule 12), the journal ledger is the sole source of truth for balances (rule 11).

Enforcing seven invariants in one place is tractable. Enforcing them in twelve places is a schedule of future incidents.

## Decision

**`packages/accounting-kernel` is the single implementation of accounting behaviour in the entire system. No module constructs journal lines. Ever.**

A feature module does not know which accounts a sale touches. It knows what *happened*, and it says so by raising a typed financial event:

```ts
await postingEngine.post({
  event: FinancialEvent.SALE_POSTED,
  tenantId,
  referenceType: 'sale',
  referenceId: sale.id,
  occurredAt: sale.transactionDate,
  idempotencyKey: command.idempotencyKey,
  actor,
  payload: { /* typed, event-specific facts — amounts, party, lines */ },
}, tx);
```

Field by field, because every one is load-bearing:

| Field | Meaning |
|-------|---------|
| `event` | A member of the closed `FinancialEvent` enum. Selects the posting rule. |
| `tenantId` | From `TenantContext`, never from request input (ADR-0004). |
| `referenceType` / `referenceId` | The source document. Backs the `(tenant_id, source_type, source_id)` unique constraint — a given sale produces one posted entry, ever (rule 14). |
| `occurredAt` | The **business** date. The kernel resolves the fiscal period from it and rejects a closed period (rule 5, ADR-0012). Distinct from `created_at`, which is server UTC (rule 13). |
| `idempotencyKey` | Recorded with a unique constraint on `(tenant_id, idempotency_key)` inside the posting transaction. A retry returns the original result — not an error, not a second posting (rule 14). |
| `actor` | The authenticated user. Written to the audit record; there is no service account that posts (rule 22). |
| `payload` | Typed, event-specific facts. Amounts as decimals (ADR-0011), entities by ID (rule 17). **Contains no account codes and no debit/credit direction.** |
| `tx` | The caller's transaction handle. The kernel never opens its own. Required — calling without it throws. |

Inside the caller's `tx`, the kernel performs all of it:

```
postingEngine.post(command, tx)
  │
  ├─ 1  validate command shape (typed payload for this event)
  ├─ 2  idempotency: INSERT (tenant_id, idempotency_key) → on conflict, return prior result
  ├─ 3  resolve fiscal period from occurredAt; reject unless OPEN   (ADR-0012)
  ├─ 4  load the posting rule for (tenant, event)                   (docs/posting-rules/)
  ├─ 5  resolve accounts — per-tenant COA mapping, control accounts, tax accounts
  ├─ 6  build journal lines; apply rounding once, to the rounding account (ADR-0011)
  ├─ 7  assert Σ debit = Σ credit, exactly, in minor units          (rule 1)
  ├─ 8  assign document number from the per-tenant locked counter   (rule 12)
  ├─ 9  INSERT journal_entry + journal_lines, status POSTED
  ├─ 10 INSERT audit_log record, hash-chained                       (rule 9)
  └─ 11 return { journalEntryId, documentNumber, lines }
  
  all of the above inside tx — the caller commits, or nothing happened
```

### Financial events

The closed set ([ARCHITECTURE.md §3](../ARCHITECTURE.md)):

```
SALE_POSTED                  PURCHASE_RECEIVED
SALE_RETURNED                PURCHASE_RETURNED
CUSTOMER_PAYMENT_RECEIVED    SUPPLIER_PAYMENT_MADE
CHEQUE_ISSUED                CHEQUE_RECEIVED
CHEQUE_CLEARED               CHEQUE_DISHONOURED
STOCK_WRITTEN_OFF            STOCK_ADJUSTED
EXPENSE_RECORDED             JOURNAL_VOUCHER_POSTED
OPENING_BALANCE_LOADED       PERIOD_CLOSED
```

Each maps to a declarative posting rule in `docs/posting-rules/`, reviewed by the Accounting Guardian and implemented once. `JOURNAL_VOUCHER_POSTED` is the one event whose payload carries accounts explicitly — it *is* the manual-entry event, and it goes through the same validation, period check, numbering, balance assertion and audit as every other posting. It is not a back door.

### Worked example — a cash sale of Rs 10,000 with COGS of Rs 7,000

The sales module raises one event. It never names an account:

```ts
await postingEngine.post({
  event: FinancialEvent.SALE_POSTED,
  tenantId, referenceType: 'sale', referenceId: sale.id,
  occurredAt: sale.transactionDate,
  idempotencyKey: command.idempotencyKey, actor,
  payload: {
    settlement: 'CASH',
    customerId: sale.customerId,
    lines: [{ productId, quantity: '10.000000', unitPrice: '1000.0000' }],
    netAmount: '10000.0000',
    taxAmount: '0.0000',
    cogsAmount: '7000.0000',   // from inventoryKernel.postMovement — ADR-0007, ADR-0008
  },
}, tx);
```

The kernel resolves the rule and produces:

```
Dr Cash                        10,000
    Cr Sales Revenue                    10,000

Dr Cost of Goods Sold           7,000
    Cr Inventory                         7,000

Σ debit = 17,000   Σ credit = 17,000   ✓
```

Both pairs are in **one** journal entry, in one transaction, with one document number and one audit record. The COGS figure is not computed by the accounting kernel — it is the cost the inventory kernel captured on the outward movement (ADR-0007). The accounting kernel consumes it; it never recalculates it.

On a credit sale the rule substitutes `Dr Accounts Receivable (customer control)` for `Dr Cash`, plus `Cr Output Sales Tax` where the tax profile applies. The module's event is identical apart from `settlement: 'CREDIT'`. That is the point: the module describes the business fact, the kernel owns the accounting.

### Governance

**Adding a financial event, or changing an existing event's mapping, is an Accounting Guardian decision — never a side effect of a feature ticket.** A ticket that says "sales needs a new revenue split" does not authorise editing a posting rule. The sequence is: propose the rule change, Accounting Guardian reviews the rule document in `docs/posting-rules/`, golden scenarios are updated or added *first* with hand-computed expected numbers, then the implementation follows. An agent that finds itself writing a debit/credit rule to unblock a feature has taken the wrong ticket (rule 19).

Per-tenant variation is **configuration** — account mappings and posting-rule variants stored per tenant — not a forked code path (ADR-0003).

## Consequences

### Positive

- Seven LEVEL 0 invariants are enforced in one place, on one code path, with one set of tests. The balance assertion, period check, numbering, idempotency and audit write cannot be forgotten by a module, because a module cannot post without them.
- Accounting review has a surface: `docs/posting-rules/` plus the golden scenarios, rather than a diff across twelve modules.
- Changing a chart-of-accounts mapping for a tenant is configuration, not a deploy.
- New modules get correct posting behaviour by construction; adding sales after banking costs one posting rule, not a re-derivation of double entry.
- Agents are given one legitimate way to post, which is far easier to state and to check than a list of forbidden patterns.

### Negative / accepted costs

- The kernel is a central dependency and a bottleneck for accounting change. Accepted — that bottleneck is the Accounting Guardian's review gate, and it is deliberate.
- Modules must express themselves in event payloads rather than "just writing the rows", which is an extra design step per feature and occasionally feels indirect.
- A posting rule is a layer of indirection between a business requirement and the SQL, so tracing "why did this hit account 6300" means reading a rule document, not a module.
- Events are a closed enum, so a genuinely novel business fact requires an ADR-level conversation before code. That friction is intentional.
- The kernel must stay dependency-poor — `packages/database`, `validation`, `shared-types` and nothing else ([ARCHITECTURE.md §5](../ARCHITECTURE.md)) — which sometimes means duplicating a small utility rather than importing one.

## Alternatives considered

**Each module writes its own journal entries, with a shared helper for balance validation.** Rejected. A shared helper is advice; modules route around advice. Twelve implementations of period validation is twelve chances to miss rule 5.

**A generic `postJournalEntry(lines[])` API that modules call with accounts and amounts.** Rejected, and this is the near-miss worth naming explicitly. It looks central but is not: the accounting decision — which account, which direction — stays in the module, so the kernel degrades into a validation utility, per-tenant COA mapping leaks into feature code, and the Accounting Guardian has nothing reviewable. Typed events are what keep the *decision* in the kernel.

**Asynchronous posting: modules emit events to a queue, a posting service consumes them.** Rejected. The journal entry would commit after the sale, leaving a window in which stock had moved and the books had not caught up — the exact "books may be wrong for a while" condition ADR-0001 rejects. Posting is synchronous and in-transaction; only *side effects* are asynchronous (ADR-0019).

**A rules engine with tenant-editable posting scripts.** Rejected for v1. Tenant-authored accounting logic is unreviewable and untestable against golden scenarios. Tenants configure account mappings and select among Guardian-approved rule variants; they do not author rules.

**Letting reports recompute figures when a posting looks wrong.** Rejected absolutely. That is the legacy failure mode. Reports read the ledger (rule 11); a wrong posting is corrected by reversal (ADR-0006).

## Compliance

- Lint rule: `INSERT INTO journal_entries` / `journal_lines`, and any repository method writing those tables, may appear only inside `packages/accounting-kernel`. Any occurrence in `modules/*` or `apps/*` fails the build.
- `dependency-cruiser`: `packages/accounting-kernel` may import only `packages/database`, `packages/validation`, `packages/shared-types` — never `modules/*`, HTTP or UI code.
- Type-level: `postingEngine.post` requires `tx`; there is no overload without it. A transaction-less call does not compile, and throws at runtime if constructed dynamically.
- Database: trigger asserting `Σ debit = Σ credit` at commit; no zero-line entry; no line with both debit and credit non-zero, nor both zero (rule 1). `UNIQUE (tenant_id, idempotency_key)` and `UNIQUE (tenant_id, source_type, source_id)` (rule 14).
- FinancialInvariantSuite Invariants 1, 2, 5, 7, 8, 9 run on every PR.
- Golden scenarios in `tests/accounting/golden/` — 50–100 hand-computed cases including the cash sale above. Implementations may change; the expected numbers may not.
- CI: adding a member to the `FinancialEvent` enum or modifying a file in `docs/posting-rules/` requires Accounting Guardian review (CODEOWNERS) and a corresponding golden scenario in the same PR.

## Related

- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — what happens when a posting is wrong
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the kernel that supplies the COGS figure
- [ADR-0007](ADR-0007-weighted-average-costing.md) — how that figure is computed
- [ADR-0011](ADR-0011-money-representation.md) — amounts, precision and the rounding account
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — the period check at step 3
- [ADR-0019](ADR-0019-transactional-outbox.md) — side effects, after the commit
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 1, 5, 9, 11, 12, 13, 14, 17, 19, 22
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §3 the accounting kernel, §5 dependency rules
