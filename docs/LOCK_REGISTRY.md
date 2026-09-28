# Lock registry

Every advisory lock in FinSoft, and the order in which locks are acquired.

**Authority: LEVEL 3.** The *rule* that advisory locks are registered lives at
LEVEL 1, in [ARCHITECTURE.md](ARCHITECTURE.md) §7 and
[ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) §5. This file is
the *register*, appended to by ordinary pull request under Architecture
Guardian review. Splitting them is deliberate: a register that needed an ADR
per entry would not be maintained, and an unmaintained register is worse than
none, because it reads as complete.

**Owner: Architecture Guardian.** Ordering across modules and kernels is a
cross-cutting concern. The Database Guardian reviews each entry's SQL and its
lock footprint. **The Product Owner is not in the loop to add an entry** —
requiring a signature to register a lock is how a register stops being used.

---

## Why this file exists

Two locks were in the codebase before anyone wrote down that both were in the
same namespace.

`packages/database/src/migrate/apply.ts:72` has held
`pg_advisory_lock(hashtext('finsoft.migrations')::bigint)` since FND-006.
ADR-0020 then proposed a per-tenant lock in the same one-argument space and its
first draft claimed to be **"the first claimant"** of it. That was false, and
nothing in the repository would have caught it — there was no list to check
against. The two keys do not collide (`-2043191111` against a 64-bit-spread
tenant fold, roughly 2.3e-10 for random uuids), so the error was harmless and
invisible, which is the combination that makes a register worth having.

The acquisition order matters more than the namespace. A lock taken out of
order is a deadlock that appears under load, in production, on the posting
path — and it is legal, because nothing checks.

---

## The global acquisition order

Locks are acquired in ascending position. A transaction may skip positions; it
may not go backwards.

| # | Lock | Space | Scope | Owner | Governing record |
|---|------|-------|-------|-------|------------------|
| 1 | `pg_advisory_lock(hashtext('finsoft.migrations')::bigint)` = `-2043191111` | 1-arg | session | `packages/database/src/migrate/apply.ts:72` | FND-006 |
| 2 | `stock_costing_state (tenant, product)` | row | xact | *not built* | [ADR-0018](adr/ADR-0018-stock-state-scopes-and-locking.md) §4(b) |
| 3 | `stock_location_balances (tenant, product, location)`, ascending | row | xact | *not built* | ADR-0018 §4(b) |
| 4 | `stock_batch_balances`, FEFO order | row | xact | *not built* | ADR-0018 §4(b) |
| 5 | *(unclaimed — numbering counters, account balance caches, and any future `ARCHITECTURE.md` §7 whole-entity lock claim positions here)* | | | | |
| **6** | `pg_advisory_xact_lock(fold(tenant_id))` — **TERMINAL** | 1-arg | xact | migration 007, the audit append path | [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) §5 |

**Position 6 is terminal.** Nothing is acquired after it except the implicit
`KEY SHARE` row locks that the audit row's own foreign keys take, on `tenants`,
`users` and `audit_log`. Any new lock takes a position **below** 6, never
above, and a record that needs to lock after the audit append is a record that
needs a different design.

### The key expression at position 6

```sql
pg_advisory_xact_lock(
  ( ('x' || substr(replace(tenant_id::text, '-', ''),  1, 16))::bit(64)::bigint
  # ('x' || substr(replace(tenant_id::text, '-', ''), 17, 16))::bit(64)::bigint )
)
```

Both halves are XORed, and that is not decoration. Reading only the first 64
bits works for `gen_random_uuid()` tenants and **collapses to `16384` for every
structured fixture in the repository** — `…-4000-8000-000000000001`,
`…0002`, `…0003` all produce the same key. That would reintroduce cross-tenant
coupling in exactly the tests written to prove isolation. Folded: 200 000
distinct keys in 200 000 uuids, measured.

### Why the one-argument space, and why not `hashtext`

`ARCHITECTURE.md` §7 previously said to key advisory locks with
`(tenant_id, entity)`, which in practice meant
`pg_advisory_xact_lock(4919, hashtext(tenant_id::text))`. That line was amended
by ADR-0020, because `hashtext` is an undocumented internal function with no
stability contract, and its `int4` output collides — **199 997 distinct in
200 000 random uuids, measured**. A collision puts tenant A's posting behind
tenant B's long import until a timeout fires: an availability coupling across a
tenant boundary, in the posting path, in a multi-tenant ERP.

**The two spaces are provably disjoint**, so nothing here can collide with a
future two-argument claimant: `pg_locks.objsubid` is **1 for the
one-argument form and 2 for the two-argument form**, measured on PostgreSQL
17.10 and labelled by `classid` so the two rows cannot be confused. That is a stronger separation than the
namespace convention it replaces.

---

## One ordering fact that existed only in someone's head

**Migration 009 creates each tenant's `seq = 0` anchor row while the migration
runner holds position 1**, and creating that row takes position 6. So a
migration transaction holds the first lock and then the terminal one.

That is safe — no posting transaction ever wants the migration lock, so the
edge cannot close into a cycle — but it is precisely the kind of fact that is
obvious to whoever wrote it and invisible to everyone else. It is written down
here because that is what this file is for.

---

## Row locks on `audit_log`

No application code takes an explicit row lock (`FOR UPDATE`, `FOR NO KEY
UPDATE`, `FOR SHARE`, or `FOR KEY SHARE`) on `audit_log` outside migration 009
itself. The ONE exception is `audit_log_enforce_linkage()`'s own `FOR SHARE`
read inside the `audit_log_link` trigger (ADR-0020 §5, the 005:114-131
doctrine) — every other row lock on this table is either the implicit `KEY
SHARE` the table's own foreign keys take on `tenants`, `users` and on itself
(named in the "position 6 is terminal" paragraph above), or forbidden. This is
enforced by `tests/security/lock-registry.spec.ts`'s source scan, which
rejects any of those four locking clauses appearing against `audit_log`
outside `database/migrations/009_create_audit_log.sql`.

Why this matters enough to register: a query construction bug — for example
an `INSERT ... ON CONFLICT (...) DO UPDATE SET ip = ...` reaching for
`FOR UPDATE`-shaped conflict resolution — would take a lock this table's
append-only design never anticipated, in a place the terminal advisory lock
(position 6) does not protect against, because it would not be recognised as
part of the audit append path at all.

### Test-only advisory lock — NOT a claimant of the numbered positions above

`database/tests/trigger-mutation-lock.ts` uses a session-scoped
`pg_advisory_lock(918273645)` / `pg_advisory_unlock(918273645)` pair to
serialise tests that disable an `audit_log` trigger against tests asserting
one is enabled. It is registered here for the same reason
`tests/security/lock-registry.spec.ts` exists at all — an unregistered
`pg_advisory` call is exactly the kind of thing that looks safe until a second
claimant appears — but it does **not** take a position in the ordered list
above: it is never held by application code, never taken on a request or job
path, and the one-argument space's own size (2^64 possible keys) is what
makes a collision with a real tenant's folded key negligible, not any claimed
separation from that space — see the constant's own comment for the
correction of an earlier, wrong claim to the contrary.

---

## Adding an entry

1. Name the key expression exactly as the code computes it.
2. State the space (1-arg / 2-arg), the scope (session / xact), and the release
   point if it is not transaction end.
3. Claim a **position**, and justify it against the entries above and below.
4. Cite the ADR that governs it. A lock with no governing record does not get a
   row here; it gets an ADR first.
5. Architecture Guardian approves the position; Database Guardian reviews the
   SQL and the lock footprint.

**Enforcement.** A CI assertion fails if `pg_advisory` appears in any file this
register does not name. That is the same inbound allowlist posture the
repository already uses for `observability-importers-are-allowlisted` — applied
to the same class of problem, an edge that is legal only because nobody wrote a
rule. Not yet built; it is a merge condition on migration 009.

**There is deliberately no `packages/locks`.** Two claimants with different key
shapes — a constant string hash and a folded uuid — do not share an
abstraction. A markdown table and a grep is the whole mechanism.
