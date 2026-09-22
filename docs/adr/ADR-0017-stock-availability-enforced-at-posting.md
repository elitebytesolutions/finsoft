# ADR-0017: Stock availability is enforced at posting; negative stock is prevented, not costed

**Status:** Proposed
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Depends on:** ADR-0018 — the stock lock protocol. **Not yet written.** This record cannot be implemented until it is accepted.

## Context

The legacy system (Bhatti Traders) allowed stock to go negative and carried on costing against the negative balance. That behaviour was inherited into FinSoft's costing records as an assumption: [ADR-0007](ADR-0007-weighted-average-costing.md)'s edge-case table, and then [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) §4a, both describe rules for **"authorised negative stock."**

Nobody authorised it. The phrase entered the record because the legacy system did it, and a costing ADR needed *some* rule for a state the schema permitted. **That the legacy system's behaviour explains what can go wrong does not make it a requirement.** A distribution business that can sell stock it does not have has a control failure, and the accounting consequence — cost of sales recognised against goods that did not exist, trued up later at whatever price they were eventually bought at — is a misstatement in the intervening period, not an accounting policy.

The correct treatment is **prevention plus an exception report**, and the two are not alternatives:

- **Prevention** stops the operation that would create a negative balance.
- **An exception report** detects negatives that arrive anyway — from legacy migration, a bulk import, or corruption. Prevention cannot cover data it did not create.

A proposed design got this backwards in a way worth recording, because it is an easy mistake to repeat: it filtered negatives out of the authoritative stock view (`HAVING SUM(...) > 0`) and then defined the negative-stock report as a select over that same view. **The exception report would have been permanently empty.** Filtering rows does not prevent the condition; it removes the evidence of it.

## Decision

### 1. Availability is enforced inside the posting transaction, under the stock locks

**A check before saving is not enforcement.** Two sales can each read 10 units available and each sell 8. The window between the check and the write is exactly where the overdraw happens, and it is invisible in testing because it needs concurrency to appear.

Every posting path executes this sequence, in this order, in **one** transaction:

| # | Step |
|---|---|
| 1 | Acquire the stock locks in ADR-0018's order — costing scope, then location rows ascending, then batch rows in FEFO order |
| 2 | Read the **posted** balance at the applicable location and batch |
| 3 | Reject if insufficient — before anything is written |
| 4 | Write stock movements, valuation changes, journal entries and posting status |
| 5 | Commit, or roll every part of it back together |

Steps 2 and 3 are inside the lock held at step 1. That is the entire point; a read taken before the lock is a stale read with extra steps.

**PostgreSQL row locks serialise competing updates, but only for transactions that take them.** A posting path that skips the protocol is not slowed down by the others — it overtakes them. So the protocol is not advisory: it is the definition of a posting path, enforced in the inventory kernel, which is already the only code that may write `stock_movements` (ADR-0008).

**An aggregate stock view is not a lockable balance row.** `v_stock_balances` is a `GROUP BY` over the movement ledger; `SELECT … FOR UPDATE` against it locks nothing useful, and against some shapes PostgreSQL will refuse outright. The lock is taken on the balance rows ADR-0018 defines. This is stated because the aggregate view is the obvious thing to reach for and it fails silently.

### 2. The same protection applies to every path that reduces stock

Not just sales. **Sales, purchase returns, inter-location transfers, and receipt reversals** all reduce available stock and all can drive a balance negative. A reversal is the one most likely to be missed — reversing a receipt removes stock that may already have been sold, and it is a normal, authorised operation.

### 3. Drafts contribute nothing and consume nothing

A **draft purchase contributes no stock.** A sale may be *created* as a draft against stock that has not arrived — that is a legitimate workflow and is not blocked — but it **cannot post** until sufficient stock is itself posted. Draft status is not a reservation and does not confer one.

### 4. One document receives stock, and it is the GRN

Confirmed against the schema rather than assumed: `grn_headers` carries `supplier_bill_no`, `supplier_bill_date`, `net_amount`, `amount_paid`, `balance_amount`, `payment_mode` and `due_date`. **The GRN is the purchase invoice.** There is no separate purchase-invoice table, so there is no second document that could receive the same goods, and the double-count risk the schema is often asked about does not exist in this shape.

`supplier_bill_no` is nullable and not unique, so two GRNs may be entered against the same supplier bill — each receiving stock and each raising a payable. That is the real double-count vector, and a uniqueness constraint alone **does not close it**. Four things are needed, and the first three are product decisions:

**(a) Unnumbered GRNs.** A partial unique index skips NULLs, so any number of unnumbered GRNs remain possible and the constraint protects nothing on exactly the entries most likely to be duplicates. **Decision: a supplier bill number is required on a GRN that raises a payable.** A GRN without one may be saved as a draft but may not post. Where a supplier genuinely issues no document, the entry uses an explicit system-generated placeholder recorded as such — visible as a placeholder, never silently blank.

**(b) Normalisation.** `BT-1042`, `bt-1042` and `BT‑1042 ` are the same bill to a human and three distinct values to a `UNIQUE` index. **Decision, documented and applied at write time:** trim leading and trailing whitespace, collapse internal runs of whitespace to a single space, and fold to upper case for comparison. The normalised form is stored in a generated column that the index covers; the original as-entered text is retained for display and audit, because the supplier's own formatting is evidence.

**(c) One bill, several receipts.** This needs confirming with the business before the constraint ships: a supplier invoice covering goods delivered across several days is common in distribution, and a naive `UNIQUE (tenant_id, vendor_id, supplier_bill_no_normalised)` would **reject legitimate partial receipts**. If that is legitimate here — and the `purchase_orders` → `grn_headers` partial-receipt flow suggests it is — then uniqueness belongs on `(tenant_id, vendor_id, bill_no, line/delivery discriminator)`, or the duplicate check becomes a warning on entry rather than a constraint. **This is an open product question and the constraint must not be written until it is answered**, because the wrong shape here blocks routine work.

**(d) Idempotency.** None of the above helps against a retry: the same GRN submitted twice — a double-clicked button, a retried request after a timeout, a replayed job — can receive stock twice under different GRN numbers. **Posting is idempotent**: a client-supplied idempotency key on the posting request, recorded with the resulting document, so a retry returns the original result rather than posting again. This is the same discipline the posting engine already requires (NON_NEGOTIABLES rule 8 — three identical requests produce one journal entry), applied to stock receipt.

**These are documented decisions, not deployed controls.** Nothing in (a)–(d) exists in the schema or the code today. Each needs a migration, a test and a passing CI run before any claim that duplicate receipt is prevented. An ADR records intent; only a deployed, tested constraint enforces it, and the distinction is not bookkeeping — the gap between the two is exactly where duplicate stock gets received.

### 5. Three views, three jobs — and the authoritative one never filters

| View | Contents | May it filter? |
|---|---|---|
| `v_stock_balances` | **All** balances, including unexpected negatives | **Never** |
| `v_available_stock` | Eligible positive stock, for pickers and sale entry | Yes — that is its job |
| `v_negative_stock` | Negative balances, read from the **authoritative** view | It *is* the filter |

`v_negative_stock` is a monitored exception report. A non-empty result is an incident, triaged against the migration or import that produced it.

### 6. Negative stock is an exception state, not a supported costing mode

This is the consequence for [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) §4a, and it changes that section's framing rather than its arithmetic.

- The phrase **"authorised negative stock" is withdrawn.** Nothing authorises it. This includes ADR-0008 §4's tenant policy and its `inventory.negative_allow` permission, which is where the phrase originated and which [ADR-0018](ADR-0018-stock-state-scopes-and-locking.md) removes.
- A posting that would *create* a negative balance is **rejected**, not costed.
- ADR-0015 §4a's rules for the negative state are **diagnostic arithmetic**, so that a balance arriving from outside the posting paths has defined, reportable behaviour rather than undefined behaviour.

**And that is where it stops. Diagnosis is not a posting path.**

The failure mode to avoid is specific and easy to walk into: "migration fallback" quietly becomes a second authorised negative-stock route, because the next receipt absorbs the discrepancy and the books reconcile without anyone deciding that they should. A corruption signal would then be discharged automatically, as routine, by the ordinary flow of business.

So there is **no automatic correction**:

| | |
|---|---|
| **Quarantine** | Invalid opening balances are quarantined **before** migration acceptance. A migration with unexplained negative balances is not accepted, and cutover does not proceed on it |
| **Block** | If a negative balance is detected after cutover, **stock-affecting posting is blocked for the affected scope** and the condition is investigated. The scope is the product's costing scope, since that is the unit the value is carried at |
| **Remediate** | Corrections are applied **only** through an approved, auditable remediation process, with a named actor, a recorded reason and a reversible entry. Never by a receipt silently absorbing the difference |

**The negative-stock variance account is deferred.** It is not created, nothing posts to it, and it is not in the schema — until a remediation posting rule for it is separately written and approved. Creating an account so that imported balances reconcile is the same error as a tolerance: it makes the books agree by giving the discrepancy somewhere to go, instead of by resolving it.

**The purchase-return valuation difference is a different matter and still needs its own balanced posting rule** — a purchase price variance account, per ADR-0015 §4a. That one is required, because the entry does not balance without it; it is not a remediation plug.

### 7. No reservations in this release — a scope decision, not an omission

**Availability is defined as posted stock on hand at the applicable location and batch.** Nothing else counts.

| | |
|---|---|
| A draft sale | Does **not** reserve stock |
| A confirmed sales order | Does **not** reserve stock |
| Availability shown before posting | **Informational only** — a snapshot, not a hold |
| The posting check | Atomic, under the locks, and authoritative |

The consequence is explicit and is accepted rather than worked around: **a sale that showed as available may be rejected at posting** because a competing transaction committed first. That is the correct behaviour for a system with no reservation concept — the alternative is a hold that nothing honours, which is worse because it looks like a guarantee.

This is recorded as a **release decision**, not an unresolved question. Reservations are a real feature with real design weight — what creates one, how long it lives, whether a confirmed order holds stock, how expiry releases it, what happens to a reserved batch that expires — and they are added later through a separate approved design, not improvised into a costing or locking record.

The UI consequence is a requirement, not a nicety: availability figures shown before posting are labelled as indicative, and the rejection path at posting is a designed, recoverable state — not an error dialog.

## Consequences

**Positive.** Cost of sales cannot be recognised against goods that do not exist. The exception report can actually fire. The negative-stock variance becomes a rare, investigable event rather than routine noise. The costing rules stop carrying a legacy behaviour as though it were a requirement.

**Negative, and accepted.** Counter-sale throughput is bounded by the lock protocol — a real cost, already priced into ADR-0018's coarse-before-fine ruling and the P95 < 800 ms posting budget (ARCHITECTURE §11). Users who relied on selling ahead of a GRN must now post the GRN first; this is a genuine workflow change for the pilot and belongs in migration training, not in a technical note.

**Migration.** Legacy data will contain negative balances. They are imported **as they are** — not silently zeroed, which would destroy the evidence and misstate opening inventory — and they surface immediately in `v_negative_stock` for reconciliation before cutover.

## Compliance

- **Concurrency test (this is the one that matters):** two concurrent sales of 8 against a balance of 10, posted in parallel. Exactly one commits; the other is rejected for insufficient stock. Asserted against a real database, not a mock — a mocked transaction cannot exhibit the failure this ADR exists to prevent.
- **The same test for each path:** purchase return, inter-location transfer, receipt reversal.
- **Protocol test:** a posting path that reads the balance before acquiring the lock fails review; the kernel exposes no API that permits the ordering.
- **Lock target test:** `FOR UPDATE` is taken on ADR-0018's balance rows, never on an aggregate view.
- **View test:** `v_stock_balances` returns a seeded negative balance (it must not filter), `v_available_stock` excludes it, and `v_negative_stock` returns exactly it. This is the regression test for the empty-report defect.
- **Draft test:** a draft purchase does not increase available stock; a draft sale against absent stock may be saved and may not post.
- **Constraint tests:** `chk_disc_limit` rejects a discount exceeding the discountable amount **including when a contributing column is NULL**; `chk_grn_total_qty_positive` rejects a zero or NULL received quantity before any division; `chk_grn_cost_nonneg` rejects a negative `cost_per_unit`.
- **Signed-column test:** a reversal with negative `inventory_value_delta` and negative journal amounts posts successfully — proving no blanket nonnegativity constraint was applied to signed ledger columns.
- **Exception monitor:** a non-empty `v_negative_stock` raises an alert. Sev-2.
- **No-reservation test:** a confirmed sales order does not reduce `v_available_stock`; a second sale may consume the same units; the first order is rejected at posting rather than silently held. Asserts §7's accepted consequence actually happens, so nobody later "fixes" it into an accidental reservation.
- **No-auto-correction test (this is the guard on §6):** with a seeded negative balance, a receipt that would clear it is **rejected**, the scope is blocked, and **no journal entry is produced**. Asserts no account absorbed the difference. This test fails the moment someone reintroduces an automatic variance posting, which is the whole reason it exists.
- **Remediation test:** a correction applied through the approved remediation path succeeds, records a named actor and reason, and is reversible; the same correction attempted through an ordinary posting path is rejected.
- **Idempotency test:** the same GRN posted twice with one idempotency key receives stock once and returns the original document. Asserted with a real retry, including a retry after a simulated timeout where the first request did in fact commit.
- **Normalisation test:** `BT-1042`, `bt-1042` and `  BT-1042 ` collide on the normalised form; the as-entered text survives for each.

**Documented is not deployed.** Every bullet above describes a control that does **not exist yet**. None may be cited as enforcement until it is migrated, tested and green in CI on the exact commit. This ADR is intent; the suite is the enforcement.

## Alternatives considered

**Allow negative stock and cost it.** This is the legacy behaviour. Rejected: it recognises cost of sales against goods that do not exist, and the correction lands in a later period — a misstatement, and under a closed period (ADR-0012) one that cannot be corrected where it belongs.

**Check availability in the application before saving.** Rejected in §1: it is a time-of-check-to-time-of-use race that concurrency testing finds and unit testing does not.

**Block negative balances with a database `CHECK`.** Not possible. A balance is an aggregate over movement rows; a row-level `CHECK` cannot see it. This is exactly why the transactional protocol and the row constraints are both needed — they enforce different things and neither substitutes for the other.

**Filter negatives out of the stock views.** Rejected, and recorded in Context as the defect that motivated this record.

## Related

- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — the movement ledger and the kernel as sole writer; carries a conflict notice pending ADR-0018
- ADR-0018 (not yet written) — `stock_balances` row shape and lock ordering. **This ADR cannot be implemented until ADR-0018 is accepted**, because it names locks ADR-0018 defines
- [ADR-0015](ADR-0015-inventory-valuation-is-carried-value.md) — the carried value; §4a's negative-stock rules are reframed by §6 above
- [ADR-0012](ADR-0012-fiscal-period-locking.md) — why a later correction is not always available
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — reversal as the correction mechanism
- [.claude/DB_REFERENCE.md](../../.claude/DB_REFERENCE.md) — the legacy schema this corrects; reference material, not authority

## Open

Nothing. The reservation question that would otherwise sit here is **decided** in §7 as a release scope decision, not deferred.
