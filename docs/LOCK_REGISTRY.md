# Lock registry

Every advisory lock in FinSoft, and the order in which locks are acquired —
plus, since migration 008 (M1-R, DB-C2), every place a migration or a
repository method takes more than one *explicit row lock* in a single unit of
work.

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

A row-lock entry (as opposed to an advisory-lock position below) is added
whenever a migration or a repository method locks two or more rows, tables, or
families of rows non-atomically (i.e. not as a single statement's own,
PostgreSQL-managed row set) inside one transaction. A single `UPDATE ...
WHERE`, however many rows it touches, does not need an entry — PostgreSQL
manages its own internal lock order for one statement. An explicit `SELECT
... FOR UPDATE` (or `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`)
followed by a later, separate statement in the same transaction does. Each
such entry states: which rows are locked, in which mode, in which order, and
why a different order — or no explicit order at all — would risk a deadlock
(PostgreSQL error `40P01`).

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
| 5a | `journal_entries (tenant, id)` row of the entry being reversed, `FOR UPDATE` — reversal only | row | xact | `lockEntryForReversal`, `packages/database/src/accounting/journal.ts` | [ADR-0006](adr/ADR-0006-immutable-posted-transactions.md), reversal.md §8 |
| 5b | `fiscal_periods` rows — the posting date's period `FOR SHARE`; or, for a period transition, **every** period of the tenant `FOR UPDATE` in ascending `period_start` | row | xact | Posting gate: `findPeriodForDate`, `packages/database/src/accounting/periods.ts`. Transitions: `periodEngine.close/reopen/lock` → `lockedTarget` (whole-calendar lock), `packages/accounting-kernel/src/queries/periods.ts`. Re-read by triggers in migrations 011, 012 | [ADR-0012](adr/ADR-0012-fiscal-period-locking.md), periods.md §7, journal-voucher.md edge cases ("commits before the close or is rejected after it"; both orders tested in `database/tests/accounting-triggers.spec.ts`) |
| 5c | `document_sequences` counter row, via `INSERT ... ON CONFLICT DO UPDATE` on its scope's partial unique index | row | xact | `assignDocumentNumber` / `assignTenantDocumentNumber`, `packages/database/src/accounting/sequences.ts` | NON_NEGOTIABLES rule 12, README §4, K7 |
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

## Row locks in the accounting kernel (positions 5a-5c)

Migrations 010-013 (M2-A). Every lock here is tenant-scoped by its own key,
so two tenants never contend.

**The posting path** (`postingEngine.post`): 5b, then 5c, then 6.

1. **5b — the period gate.** `findPeriodForDate` reads the posting date's
   `fiscal_periods` row `FOR SHARE` *before* anything else is locked. The
   `journal_entries` INSERT trigger `journal_entries_enforce_open_period`
   (migration 012) re-reads the same row `FOR SHARE` — a row this
   transaction already holds, so it is not a new acquisition. A concurrent
   close (`FOR UPDATE`) either waits for the posting to commit or makes the
   posting wait and then observe `CLOSED` (periods.md §10).
2. **5c — numbering.** One `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
   on the counter row. Two scopes (K7): `FISCAL_YEAR` arbitrates on
   `(tenant_id, series, fiscal_year) WHERE fiscal_year IS NOT NULL`,
   `TENANT` on `(tenant_id, series) WHERE fiscal_year IS NULL`. Each is a
   single statement; there is no read-then-write in application code.
3. **6 — the audit terminal lock**, last, as always.

*Correction to the first draft of this entry:* it registered the period
before numbering while the posting engine actually assigned the number
first and took the period lock only inside the INSERT trigger — the
registered order was not the executed one. Fixed by taking the period lock
in `findPeriodForDate`, which the engine already calls before numbering.

**The reversal path** (`reversal.ts`): 5a, then the posting path above
(5b, 5c), then 6. The original entry E is locked `FOR UPDATE` first so two
concurrent reversals of E serialise; the loser then reads `REVERSED`. No
other path locks a `journal_entries` row, so 5a cannot close a cycle.

**Period transitions** (`periodEngine.close` / `.reopen` / `.lock`, packages/accounting-kernel): 5b in
its calendar form, then 6. Before touching the target, the transaction locks
**every** period of the tenant `FOR UPDATE` in ascending `period_start`
(`lockedTarget` in `packages/accounting-kernel/src/queries/periods.ts`). Without that, migration 011's trigger locks siblings
`FOR SHARE` in directions that differ by transition — `close P2` holds P2 and
wants P1 while `reopen P1` holds P1 and wants P2 — a `40P01` cycle. The
single ascending pass makes a tenant's transitions strictly serial (rare,
human-initiated, 12 rows per fiscal year). A posting's `FOR SHARE` on one
period blocks a transition only for that posting's duration. A posting never
waits on a transition while holding anything the transition needs: a
transition takes no 5c lock and takes 6 only after all of 5b.

**Callers outside `periodEngine`.** A raw `UPDATE fiscal_periods` (an admin
script as the migration role) skips that calendar lock. It stays *correct*
(the 011 trigger still enforces order) but can hit `40P01` against a
concurrent transition. That is a safe failure, and a reason such scripts go
through `periodEngine` — which the ESLint fiscal-period rule enforces for code.

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

## Row locks — migration 005 (sessions / refresh_token_families / refresh_tokens)

**Order:** `sessions` → `refresh_token_families` → `refresh_tokens`

Every trigger that reads a parent row before writing a child takes `FOR SHARE` on it —
`rtf_reject_revoked_session()` locks the `sessions` row before allowing a new
`refresh_token_families` row; `refresh_tokens_reject_revoked_family()` and
`refresh_tokens_enforce_transition()`'s revoked-family check lock the `refresh_token_families`
row before allowing a `refresh_tokens` row to be inserted or spent. `FOR SHARE`, not `FOR KEY
SHARE`: revoking a family takes `FOR NO KEY UPDATE`, which `FOR KEY SHARE` does not conflict
with — the weaker mode would look like a guard and block nothing. See
`database/migrations/005_create_sessions.sql`'s own header for the full reasoning, including
why a revoke that waits on an in-flight insert is correct rather than a cost to avoid (no
`NOWAIT` / `SKIP LOCKED` / short `lock_timeout` anywhere on this path).

## Row locks — migration 008 (roles / role_permissions / user_roles → users, DB-C2)

**Order:** `roles` → `users` (one row at a time, ascending `id`)

Three triggers bump `users.version` when a user's effective permissions change:
`role_permissions_bump_permission_version()`, `user_roles_bump_permission_version()`, and
`roles_bump_permission_version()`. The first two explicitly lock their `roles` row before
touching any `users` row; the third needs no separate `roles` lock, because it fires on an
`UPDATE` of `roles` itself, and the row triggering it is already locked by that statement.

- **`role_permissions_bump_permission_version()`** — a consequence of a *write* to the role's
  permission set. Takes `FOR UPDATE` on `roles`.
- **`user_roles_bump_permission_version()`** — only *reads* which role was assigned or revoked.
  Takes `FOR SHARE` on `roles`. `FOR UPDATE` conflicts with a peer's `FOR SHARE`, so two
  cascades for the SAME role now queue on `roles` before either reaches `users` — this is what
  `tests/security/rbac-lock-order.spec.ts` proves with two real connections.
- Both role_permissions- and roles-triggered cascades then lock every affected `users` row
  **one at a time, in ascending `id` order**, via an explicit `PERFORM ... FOR UPDATE` inside a
  loop — never a single `UPDATE ... WHERE EXISTS (...)` left to PostgreSQL's own row order.
  `SELECT ... ORDER BY id FOR UPDATE` does **not** guarantee PostgreSQL *acquires* the locks in
  that order, only that matching rows are *returned* in it; the loop is what actually fixes
  acquisition order. Two cascades for two *different* roles that happen to share members
  therefore always attempt `users` locks in the same relative order as each other and can
  never form a cycle on those rows, whatever their relative timing.

**The race this closes.** A revoke of a role's permission (touching every current holder) and
a grant/revoke of that same role for one specific user could, before this order existed, each
hold one `users` row the other wanted, with nothing forcing them into a consistent order —
`40P01`. Locking `roles` first serialises the two kinds of cascade against each other; the
per-row ascending-id loop serialises same-shaped cascades against each other even without that.

**What is NOT covered by this order.** A statement that locks a `users` row *outside* one of
these three cascades — an ordinary profile update, for instance — is not required to lock
`roles` first, and does not participate in this order at all. It can still form a deadlock with
a cascade if it locks the SAME rows those loops would, out of order, at the same time as a
concurrent cascade; that is an unavoidable property of any system where more than one code path
locks a shared row, not something this registry claims to solve for every future case. Locking
`users` rows and expecting a cascade to be running concurrently is unusual enough in this
codebase's transaction shapes that it is accepted rather than defended against here — a future
path that does this regularly should add its own entry and follow the SAME ascending-`id`
discipline these two functions do.

Recorded per the Database Guardian's review of `feature/M1-R-rbac` (DB-C2). See
`docs/briefs/M1-R-rbac.md` for the fuller narrative and
`database/migrations/008_create_rbac.sql`'s own comments for the code-adjacent version of this
entry.

---

## Adding an entry

1. Name the key expression exactly as the code computes it (advisory locks) or
   the exact table/row/order (row locks).
2. For an advisory lock: state the space (1-arg / 2-arg), the scope (session /
   xact), and the release point if it is not transaction end. For a row lock:
   state the mode (`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY
   SHARE`) and the order across tables/rows.
3. Claim a **position** in the global acquisition order above if it is an
   advisory lock; row locks are grouped by migration instead, since they do
   not share the same numbered space.
4. Cite the ADR or Guardian review that governs it. A lock with no governing
   record does not get a row here; it gets that review first.
5. Architecture Guardian approves the position/placement; Database Guardian
   reviews the SQL and the lock footprint.

**Enforcement.** A CI assertion fails if `pg_advisory` appears in any file this
register does not name. That is the same inbound allowlist posture the
repository already uses for `observability-importers-are-allowlisted` — applied
to the same class of problem, an edge that is legal only because nobody wrote a
rule. Not yet built; it is a merge condition on migration 009.

**There is deliberately no `packages/locks`.** Two claimants with different key
shapes — a constant string hash and a folded uuid — do not share an
abstraction. A markdown table and a grep is the whole mechanism.
