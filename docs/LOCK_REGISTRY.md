# Lock registry

**Authority:** LEVEL 2 (IMPLEMENTATION.md family) — a review aid, not a rule that overrides
NON_NEGOTIABLES or an ADR. Its purpose is narrow: every place in the schema where application
code (a trigger, a repository, a migration) takes more than one row lock in a single unit of
work states its acquisition order **here**, so that a second author adding a second multi-lock
path can check it against every existing one instead of discovering a conflict in production.

A lock-order entry is added whenever a migration or a repository method locks two or more
rows, tables, or families of rows non-atomically (i.e. not as a single statement's own,
PostgreSQL-managed row set) inside one transaction. A single `UPDATE ... WHERE`, however many
rows it touches, does not need an entry — PostgreSQL manages its own internal lock order for
one statement. An explicit `SELECT ... FOR UPDATE` (or `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR
KEY SHARE`) followed by a later, separate statement in the same transaction does.

Each entry states: which rows are locked, in which mode, in which order, and why a different
order — or no explicit order at all — would risk a deadlock (PostgreSQL error `40P01`).

---

## migration 005 — sessions / refresh_token_families / refresh_tokens

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

## migration 008 — roles / role_permissions / user_roles → users (DB-C2)

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
