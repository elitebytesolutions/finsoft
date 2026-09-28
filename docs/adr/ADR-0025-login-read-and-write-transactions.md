# ADR-0025: Login reads and writes in two transactions, and the write re-asserts account state

**Status:** Proposed
**Date:** 2026-09-27
**Deciders:** Architecture seat, Database/Security seat ([ADR-0024](ADR-0024-operating-model.md))
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0023](ADR-0023-pre-tenant-authentication-reads.md) **in part: one sentence of §3, at ADR-0023:191, and nothing else.** It also clarifies ADR-0023 §5 layer 4 (:235) without changing it. Line numbers are as-accepted. The rest of ADR-0023 stays in force, including :187 and §3's requirements 1–4 (:201–:204).

*Not the "ADR-0025" at ADR-0023:404 or on the BOARD's withdrawn A4 row. That one was a proposed ADR-0013 allowlist extension, withdrawn before it was written. The number was never assigned.*

## Context

ADR-0023:191 reads: *"Sharing the helper also means the credential verification and the `last_login_at` write share one transaction with the tenant established once, which §1's claim about RLS being in force during verification requires and does not otherwise get."*

Two things are wrong with it. First, §1's RLS claim is met by the **read**. `password_hash` is read under RLS with the tenant already set, and that read is the property that matters. Verification is argon2id working on a value already in memory, and RLS has nothing to enforce while it runs. Second, keeping a transaction open through argon2id holds a pooled connection for tens of milliseconds of CPU on an unauthenticated endpoint. Under a burst, that is a way to exhaust the connection pool, and the hashing semaphore does not cover it. The Security review of M1-A (C2) found this, and the lane split the transaction.

The split creates a window between the read and the write. An admin can disable the user, change the password or suspend the tenant during that window. The first resubmission (`0926851`) was rejected by the Architecture seat for three reasons:

- **F1.** The write was guarded only on `version`, with a retry that re-read `version`. That proves nothing about account state, so a disabled user, or a user whose password had just changed, still got a session and a 14-day refresh token.
- **F2.** Tenant status was not checked again at write time.
- **F3.** The write transaction was entered through `TenantContext.run` with transaction one's id as a bare string, instead of through `withResolvedTenant`. That weakened ADR-0023 §3/A2.

Commit `5e1d3cd` on `feature/M1-A-auth` fixes all three. This record makes that shape the rule.

An alternative was to keep one transaction and accept the pool-exhaustion vector behind the semaphore. It was rejected because the semaphore bounds memory and CPU, not connections held.

## Decision

1. **The replacement rule for ADR-0023:191.** *The resolve+read transaction and the write transaction are separate. Both enter via `withResolvedTenant`. The write re-asserts user status, the verified `password_hash`, tenant identity and tenant status atomically. No transaction is open during credential verification.*

2. **What "atomically" means here, exactly.**
   - User status and the verified `password_hash` are predicates of the one `UPDATE users … WHERE tenant_id AND id AND status = 'ACTIVE' AND password_hash = $verified`. PostgreSQL evaluates them under that row's lock, and re-checks them against the latest row version if a concurrent update committed first.
   - Tenant identity and tenant status are checked by the write transaction's own resolver read, before the `UPDATE` and in the same transaction. That read must resolve to the same tenant id as transaction one's, and its status must be `ACTIVE`.
   - The `UPDATE` sets `version = version + 1` unconditionally. `version` is **not** a predicate, so two concurrent valid logins both succeed.
   - Tenant status is a statement snapshot, not a lock. A suspension that commits during the write transaction's sub-millisecond body cannot be distinguished from one that commits just after it, so tenant suspension must revoke live sessions in any case. The design ADR-0023 accepted read tenant status at the start of a transaction that stayed open through argon2id, so this window is strictly shorter than that one.

3. **A failed re-assertion is an ordinary authentication failure.** A different tenant id, a non-`ACTIVE` tenant, a code that no longer resolves, or zero rows updated all return ADR-0023 §4's identical 401. None of them throws, and none of them retries. **No version-only retry, and no re-read that decides anything the write predicate does not.**

4. **Tenant identity crosses between the transactions only by re-resolution.** No tenant id from transaction one is passed into `TenantContext` or into any tenant-scoping call. Transaction one's id is used for one thing only: the equality check in statement 2.

5. **Clarification of ADR-0023 §5 layer 4 (:235), "alert and global slowdown, never a hard block".** The **global slowdown** is the capped argon2id semaphore in `packages/auth/src/password.ts`: 8 concurrent verifications and a queue of 64. Queueing is the slowdown. Past the cap, the request fails fast with 503 `busy` (`HashingQueueFullError`). That is capacity load-shedding, not a block triggered by a failure count, and the account-keyed throttle budget the request spent is refunded. The **layer-4 counter** (`login:global`) is alert-only (`blocking: false`), and its alert is deduplicated to once per 60 seconds. Nothing keyed on the global failure count ever rejects a request.

## Consequences

**Positive.** No pooled connection is held through argon2id. A state change in the window can no longer produce a session. The write is the point of truth, which matches the refresh path's *"the resolver decides where, the spend decides whether"* (ADR-0023:177–179). The tenant id still enters `packages/database` only through a resolver.

**Negative / accepted.**
- Two transactions and two `tenants` reads per successful login. The second read is an indexed lookup by code.
- A login races an argon2id parameter upgrade that rehashes the same password. It fails once with a 401 and succeeds on retry. Accepted, because it fails closed.
- The test-only `beforeWrite` hook is on the production signature of `login()` and `withLoginAttempt()`. It is inert unless passed, and it is how the window is tested. It is booked as debt, not as a pattern to copy.

## Compliance

| Statement | Mechanism |
|---|---|
| 1, 2, 3 — user state | `tests/integration/login-toctou.spec.ts`: *user disabled between verification and the write*, and *password changed (and version bumped) between verification and the write*. Both inject the change on a separate connection at `beforeWrite` and assert `failed` with zero `sessions` rows. *A password change with NO version bump is unreachable* proves that `users_enforce_transition` (migration 007) rejects an `UPDATE` that does not bump the version. |
| 2, 3 — tenant | `login-toctou.spec.ts`: *tenant suspended between verification and the write*. The suspension goes through `finsoft_migration`, and the test asserts `failed` with zero sessions. |
| 2 — `version` is not a predicate | `login-toctou.spec.ts`: *two genuinely concurrent valid logins for the same user both succeed*. Two sessions. |
| 1 — no transaction open during verification | **Condition C1**, below. Today the property rests on the structure of one function. `decide` is called between two awaited `withResolvedTenant` calls, and each of them commits before it returns. Nothing tests that yet. |
| 4 — re-resolution only | `withResolvedTenant`'s `ResolvedTenantId` brand and WeakSet check (`packages/database/src/transaction.ts`). **Condition C2**, below. |
| 5 — semaphore cap | `login-toctou.spec.ts`: *item 1d: the hashing queue cap is real*. It fills 72 slots with real calls and asserts the 73rd throws `HashingQueueFullError`. `packages/auth/src/login.spec.ts` covers the refund, and `packages/auth/src/throttle.spec.ts` covers *refundLayers (item 1d)*. |
| 5 — layer 4 alert-only, deduplicated | `packages/auth/src/throttle.spec.ts`, *checkLayers — alert dedup (N5)*. |

**Conditions on the M1-A merge** (Architecture seat):

- **C1.** A test asserting that no `finsoft_app` connection is checked out, or `idle in transaction`, while `decide` runs. For example, `decide` can query `pg_stat_activity` over a separate connection. Without it, statement 1's last clause is a preference.
- **C2.** An ESLint `no-restricted-imports` rule forbidding `../tenant-context.ts` in `packages/database/src/auth/login.ts` and `refresh.ts`, with a case in `tests/security/lint-boundaries.spec.ts`. F3 was exactly that import, and it compiled.

## Signatures

| Seat | Verdict |
|---|---|
| **Architecture seat** | ✅ **APPROVED WITH CONDITIONS C1–C2, 2026-09-27.** Author. Reviewed diff `0926851..5e1d3cd` of `packages/database/src/auth/login.ts`, `packages/auth/src/login.ts` and `tests/integration/login-toctou.spec.ts`. F1, F2 and F3 are closed. The conditions bind the M1-A merge, not this record. |
| **Database/Security seat** | ☐ pending. Reviewing `5e1d3cd` in parallel. |
