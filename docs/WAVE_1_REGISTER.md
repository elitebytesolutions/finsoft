# Wave 1 — task register

**Authority:** LEVEL 2, alongside [IMPLEMENTATION.md](IMPLEMENTATION.md). Scope changes need Product Owner approval.

**Exit criterion:** *a user in tenant A provably cannot read tenant B's data, by test, at both API and SQL levels.*

The SQL half was met in Wave 0 — [FND-007/008](WAVE_0_REGISTER.md) proves isolation serially, with interleaved requests on one connection, and with transactions genuinely open on separate backends. **The API half could not be tested at all**, because `TenantGuard` was a fail-closed stub with no authenticated request to admit. Wave 1 builds that request.

**The exit test must prove authorised access SUCCEEDS as well as cross-tenant access failing.** A test suite of refusals passes against a guard that refuses everyone, which is precisely what the stub did.

| Status | Meaning |
|---|---|
| **complete** | Acceptance criteria met, evidenced |
| **in progress** | Started, with the remainder named |
| **blocked** | Cannot proceed; the blocker is named |

---

## W1-000 · ADR-0020 and the dependency reviews

**Scope.** The decisions that must be made before any code: the audit canonicalisation scheme, and the two dependencies Wave 1 introduces.
**Dependencies.** None.

**Acceptance criteria.** ADR-0020 written and signed by three parties · both dependencies security-reviewed, pinned exactly, `npm audit` unchanged · argon2id verified in a **musl** environment, not merely locally · parameters benchmarked on the staging host.

**Status: in progress.** ADR-0020 is written and unsigned; the reviews are done.

### ADR-0020 — audit hash chain canonicalisation

Rule 9 requires `hash = H(previous_hash || canonical(record))` and never defines `canonical`. [ADR-0020](adr/ADR-0020-audit-hash-chain-canonicalisation.md) defines the exact bytes, versions the format, and specifies the ordering and locking that stop the chain forking.

**Two things were measured rather than assumed, and both ruled out the obvious approach:**

```sql
SELECT '{"b":1,"aa":2}'::jsonb::text;   →  {"b": 1, "aa": 2}
```

PostgreSQL orders `jsonb` keys **length-first**; RFC 8785 orders by code unit and puts `aa` before `b`. They agree for single-character keys and diverge the moment one is longer — so a scheme validated on `{"id":…,"qty":…}` breaks on `{"id":…,"quantity":…}`.

```js
JSON.stringify(1.10)  →  1.1
```

The trailing zero is lost. A tampered `1.10 → 1.1` would not break a chain built on `JSON.stringify`, which is the one change such a chain most needs to catch. Hence the rule that **every value in the canonical record is a string** — money arrives as `"1.1000"`, already fixed-scale per ADR-0011.

The genesis golden vector in the ADR carries a **computed** hash, `38e6aa16…`, not a placeholder. A reimplementation in another language is checked against it first.

### `@node-rs/argon2@2.2.1` — approved, and the smoke test earned its place

MIT, zero runtime dependencies. Pinned exactly in `packages/auth`.

**`npm audit` before and after: two advisories both times**, `postcss` via `next` — the pre-existing chain in [GAP-002](COMPLIANCE_GAPS.md). It introduced nothing.

**The Alpine smoke test failed first, which is why it was required.** `@node-rs/argon2` resolves its native binding through platform-keyed optional dependencies; installing on Windows fetched only `win32-x64-msvc`, so loading it under musl gave `Cannot find native binding`. The lockfile does record `linux-x64-musl`, so `npm ci` inside the image installs the right one — verified by running the real thing on Alpine:

```
musl native binding: LOADED
encoded prefix     : $argon2id$v=19$m=19456,t=2,p=1$i
verify correct     : true
verify incorrect   : false
```

**A local pass would have proved nothing about the deployed image.**

### Argon2id parameters — benchmarked on the staging host

Measured on the staging server (4 vCPU, 7.9 GB), in a container limited to 2 CPU / 1 GB — the shape the API runs in:

| memory | t | p | serial | 20 concurrent | peak memory at 20 |
|---|---|---|---|---|---|
| 19 MiB | 2 | 1 | 16.1 ms | 146 ms | 380 MiB |
| **19 MiB** | **3** | **1** | **23.4 ms** | **211 ms** | **380 MiB** |
| 32 MiB | 3 | 1 | 41.1 ms | 403 ms | 640 MiB |
| 46 MiB | 3 | 1 | 60.0 ms | 620 ms | 920 MiB |
| 64 MiB | 3 | 1 | 88.9 ms | 1093 ms | 1280 MiB |

**Chosen: `memoryCost = 19456` (19 MiB), `timeCost = 3`, `parallelism = 1`.**

At or above the OWASP floor on every axis, and above it on time. The reasoning is the column on the right: **memory cost is the denial-of-service lever, not the security lever.** Login is unauthenticated, so every concurrent attempt allocates its memory cost before anything has proved who the caller is. Twenty concurrent logins at 64 MiB is 1.28 GB and would OOM a 1 GB container — an attacker would not be cracking anything, just switching the API off.

Raising `timeCost` instead buys attacker work without buying attacker leverage over our memory. 23.4 ms is imperceptible at login.

**Two controls make that choice safe, and both are in scope:**

- **Rate limiting on `/auth/login`**, per IP and per account. An unthrottled login endpoint is a password-guessing service.
- **A concurrency cap on hashing.** Rate limiting is per-origin; a distributed burst still converges on one process. A semaphore bounds peak memory regardless of how the requests arrived, and is the control that makes the OOM arithmetic above a ceiling rather than a hope.

Revisit when the API's memory limit is set deliberately rather than inherited.

### `jose@6.2.12` — approved

MIT, zero runtime dependencies, RS256 and JWKS with key rotation. Pinned exactly.

Chosen over `jsonwebtoken` for one reason that matters here: `jose` requires the caller to state the permitted algorithms, so **algorithm-confusion is a compile-time concern rather than a runtime hope**. A verifier that accepts whatever the token's header claims will accept `alg: none`, or an RS256 public key presented as an HS256 secret.

### Both guardians REJECTED the first draft, 2026-09-25

27 required changes between them. The scheme survived; the document did not.

**What held.** Both guardians independently regenerated the golden vector `38e6aa16…` from the specification alone — one with the input keys deliberately shuffled. That reproduction *is* the ADR's central claim, tested rather than asserted, and §1–§4's canonicalisation needed no change beyond corrections.

**The serious finding: "forks are structurally impossible" was false.** With only the two unique constraints, three forged rows insert cleanly — an orphan referencing no parent, a duplicate `hash`, and a self-link. Reproduced here before accepting it. `UNIQUE (tenant_id, previous_hash)` gives *at most one child per parent hash* and nothing more.

**That is the same defect `004` draft 2 was rejected for** — a document stating a protection it does not provide — written again by the same author who recorded that lesson. Now corrected with what the constraints actually give, plus `UNIQUE (tenant_id, hash)`, `NOT NULL` on both hash columns, a not-self CHECK, a genesis-ties CHECK and a linkage trigger. Measured: the orphan now fails with `previous_hash does not match the hash at seq 499`, and a legitimate append still succeeds.

**The finding that broke the golden vector itself.** The ADR defined the record over *logical values* and required the verifier to recompute from *stored columns*, without ever stating the mapping. PostgreSQL does not render either of the two most exposed columns in the specified form:

```
'2026-09-24T00:16:59.383000Z'::timestamptz::text  →  2026-09-24 00:16:59.383      trailing zeros gone
'203.0.113.7'::inet::text                         →  203.0.113.7/32               prefix appended
Date.prototype.toISOString()                      →  ...383Z                      3 digits, not 6
```

**Under an `inet` column this ADR's own example did not verify.** `ip` is now `text`, `occurred_at` has a normative `to_char` expression, and §4 carries a column→canonical-value table for all twelve.

**Other corrections worth naming:** §4 contradicted itself on whether `hash_version` is in the record, and the two readings give different hashes (`38e6aa16…` vs `50855dd5…`, both recomputed). The separator rationale described an attack that is not achievable — separators kept, justification replaced with forward compatibility. The `jsonb` numeric claim was wrong in the ADR's own favour: notation is normalised (`1e21` → `1000000000000000000000`), not preserved. The scheme's dependence on READ COMMITTED was undeclared. `previous_hash` was nullable, which voids a UNIQUE silently. `seq` allocation was unspecified while §6 treats a gap as a deleted row. RLS was mentioned zero times in a document authorising a tenant-owned table. And the `REVOKE` rationale named the wrong mechanism — default privileges apply at `CREATE TABLE`, so "granted to nobody" is satisfied by writing no `GRANT` while the application role can still rewrite history.

**One deferral was rejected and split.** The per-tenant lock serialises every audited write, not just posting. Measurement stays in Wave 2; **lock placement is decided now** — last write before commit, no external calls while held, bounded by `lock_timeout` — because it is the variable the measurement depends on and the difference is roughly 40× against the 800 ms P95 budget.

**Decisions taken in the revision**, each with its rejected alternative recorded: the linkage trigger over a self-FK plus anchor row (the anchor needs an authorship 002 deliberately does not provide); a one-argument advisory lock keyed on the tenant's own bits over `(4919, hashtext(…))` (which couples unrelated tenants and rests on an undocumented function); `audit_log` exempt from the §11 mandatory column set, named in `schema.spec.ts` rather than left to the migration author.

**Outstanding.** Re-review, then three signatures. Migration 007 does not merge before them.

---

## W1-001 · Migration 005 — sessions and refresh token families

**Status: not started.** Blocked on nothing; next.

---

## W1-002 · `packages/auth`

**Status: not started.**

**A correction carried into the design, recorded because the plan had it wrong.**

The approved plan said concurrent refresh from two browser tabs is *"a legitimate race that must not revoke a family"*. That is wrong, and the Product Owner corrected it: **a replayed stolen refresh token and a second browser tab are indistinguishable to the server.** Both present a spent token; both look identical. OAuth 2.0 security guidance identifies exactly this inability to tell attacker from client during replay.

So there is **no blanket "concurrent reuse is allowed" exception.** Rotation is atomic and single-use; presenting a spent token revokes the family, whoever presented it. The client coordinates — one in-flight refresh per browser context — and the retry policy handles the loser rather than the server guessing intent.

---

## W1-003 · `apps/api` — the authenticated request

**Status: not started.**

**A signed tenant claim is necessary and not sufficient**, per the Product Owner's correction. The server must establish that the user belongs to the tenant **before** issuing the claim; a signature only proves the server said it, not that it was right to. Verification checks signature, **permitted algorithm**, issuer, audience and expiry, with explicit behaviour for session revocation and membership change.

Headers, body, query parameters and resource ids never override the authenticated context — four separate doors, four separate tests.

---

## W1-004 · Migration 006 and `packages/permissions` — RBAC

**Status: not started.**

---

## W1-005 · Migration 007 and the audit chain

**Status: not started.** Blocked on ADR-0020's signatures.

The deliverable is **the verifier**, not the table. A chain nobody verifies is a column called `hash`.

---

## W1-006 · The exit criterion

**Status: not started.**

Per the Product Owner, the suite must prove **both** directions:

| | |
|---|---|
| 1 | Tenant A can read **and update** its own record — authorised access succeeds |
| 2 | Tenant A cannot read or modify B's record by changing an id, or by supplying B's tenant id anywhere in the request |
| 3 | Missing, tampered, expired and revoked credentials are each rejected |
| 4 | The API connects as the **restricted** database role |
| 5 | Concurrent A/B requests stay isolated |

Case 1 is the one that stops this suite passing against a guard that refuses everyone — which is what the Wave 0 stub did, and would have.

Plus the residual Wave 0 items: the `npm audit` policy ([GAP-002](COMPLIANCE_GAPS.md)) and **D2**, the per-`Pool` `types` hole that is open at both layers and sits between a JS float and a money column.
