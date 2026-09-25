# Technical debt

Known, accepted shortcomings that are **not** LEVEL 0 compliance gaps.

**Authority: LEVEL 3.** Appended by ordinary pull request. Owner: Architecture
Guardian, with the relevant specialist guardian named per item.

**This is not [COMPLIANCE_GAPS.md](COMPLIANCE_GAPS.md).** That file is scoped to
partial enforcement of a [NON_NEGOTIABLE](NON_NEGOTIABLES.md) — GAP-001, where a
control exists but nothing makes it binding. An item belongs *here* when it is a
real shortcoming that violates no invariant: an unset parameter, a measurement
not yet taken, a redundancy that cannot be tidied because the record is frozen.

**Why a separate file rather than the wave registers.** A wave register closes
when its wave does. The `users` table-level `UPDATE` finding was raised during
the migration 004 review and is still open two waves later, discoverable only by
whoever remembers which register it landed in. Debt that outlives its wave needs
an address that does not move.

Each entry states **what**, **why it is accepted**, **who owns it**, and **what
would force it**. An entry with no forcing condition is a wish, not debt.

---

## TD-001 · `lock_timeout` is set nowhere

**What.** [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) §5 states
that "a `lock_timeout` bounds the queue so contention surfaces as a bounded error
rather than an unbounded stall." No `lock_timeout` is set in this repository.
Verified: the string appears only in ADR prose and in one migration comment
saying *not* to add one locally.

The only bound in force is `statement_timeout`, set at
`packages/database/src/pool.ts:222` to `15_000` ms — **roughly nineteen times the
800 ms P95 posting budget** in [ARCHITECTURE.md](ARCHITECTURE.md) §11, and sized
for slow queries rather than for a lock wait. A transaction blocked on the
per-tenant audit lock therefore stalls for up to fifteen seconds before anything
intervenes.

**Why it is accepted for now.** No posting path exists yet — both kernels are
`export {}`, and `audit_log` does not exist until migration 007. There is
nothing to stall. Choosing the value blind is also worse than choosing it
against a measurement: too low and legitimate contention becomes spurious
posting failures, which is a worse failure than a slow posting.

**Owner.** Database Guardian, with the Architecture Guardian on the value, since
it trades against the §11 budget.

**What would force it.** Migration 007, or the first code path that takes the
per-tenant audit lock — whichever is first. ADR-0020's §5 sentence must either
name the value and where it is set, or be withdrawn; it must not ship as a
stated protection with no mechanism.

---

## TD-002 · The per-tenant audit lock serialises logins against postings

**What.** [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) §5 takes
one advisory lock per tenant for the audit append. Every audited write in a
tenant contends on it — not only postings. A login writes an audit record; so
does a permission change, a session revocation and an import. On a busy tenant,
a login can queue behind a long-running posting for no reason either operation
cares about.

**Why it is accepted.** The alternative — a finer lock keyed by
`(tenant_id, entity)` — reintroduces the ordering problem that the terminal
single lock exists to remove, and the chain is per tenant by
[rule 9](NON_NEGOTIABLES.md), so the serialisation point cannot be narrower than
the chain without splitting the chain. ADR-0020 records a fallback design
(`UPDATE audit_chain_head … RETURNING`) if measurement demands it.

**Owner.** Database Guardian. Measurement deferred to Wave 2 by ADR-0020.

**What would force it.** A measured P95 regression against ARCHITECTURE §11's
800 ms budget, or the first tenant where audited non-posting writes are frequent
enough to queue.

---

## TD-003 · The pre-push hook typechecks generated Next.js output

**What.** `npm run typecheck` covers `apps/web`, whose `tsconfig` includes
`.next/types`. `.next/` is gitignored build output, so switching between
branches with different routes leaves stale generated types behind and the
pre-push hook fails on a file that is not in the repository. Observed switching
from a branch carrying `/delivery-challans` to one without it:

```
.next/types/validator.ts(221,52): error TS2344:
  Type '"/delivery-challans"' does not satisfy the constraint 'AppRoutes'.
```

The fix is `rm -rf apps/web/.next`, which is not discoverable from the error.

**Why it is accepted.** It fails safe — a false failure that blocks a push,
never a false pass — and it costs one command. Excluding `.next/types` from the
typecheck would remove a real check on route correctness.

**Owner.** DevOps Guardian.

**What would force it.** A second person hitting it, or CI hitting it (CI builds
clean, so it does not today).

---

## TD-004 · ADR-0021 states one rule three times

**What.** [ADR-0021](adr/ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md)
states condition 5's scope at `:68`, `:70` and `:80`, and the production-minter
gate in two independent wordings at `:70` and `:80`. Introduced by the condition-6
amendment, which added paragraphs above the original without merging it.

**Why it is accepted — and why it must NOT be fixed.** The record is Accepted and
the text is accurate, merely redundant.
[README](adr/README.md) §4 permits correcting text that is *false about the
document's own contents*; it forbids tidying. That rule exists precisely so that
LEVEL 1 records are not quietly rewritten. Had this been caught during the
amendment it should have been merged; that window closed at acceptance.

**Owner.** Database Guardian.

**What would force it.** ADR-0021 being superseded for any other reason — merge
the three statements then. **Meanwhile: anyone editing one of the three must
check the other two.** That sentence is the entire value of this entry.

---

## TD-005 · `users` grants table-level `UPDATE` to `finsoft_app`

**What.** Migration 002 grants `SELECT, INSERT, UPDATE` on `users` with no
`REVOKE` and no column scoping. Table-level `UPDATE` supersedes any column list,
so `users.id`, `users.tenant_id`, `users.created_at` and `users.created_by` are
all application-writable today — the authorship root of the entire system.

Raised during the migration 004 review and again during 005. Migrations 004 and
005 both carry the `REVOKE`-then-column-grant pattern that closes it; `users`
predates the lesson.

**Why it is accepted.** 002 is released, so this is a forward migration, not an
edit. Nothing currently writes those columns.

**Owner.** Database Guardian.

**What would force it.** The first code path that updates a `users` row —
W1-002's login flow updates `last_login_at`, so this is live now, not later.
