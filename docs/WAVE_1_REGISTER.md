# Wave 1 — task register

**Authority:** LEVEL 2, alongside [IMPLEMENTATION.md](IMPLEMENTATION.md). Scope changes need Product Owner approval.

> **Frozen as history, 2026-09-27, under [ADR-0024](adr/ADR-0024-operating-model.md).** Nothing below is rewritten. W1-002…W1-006
> continue as the **M1 — minimum platform** increment of the MVP slice, tracked on [BOARD.md](BOARD.md) with delivery briefs rather
> than contracts. Open technical signatures recorded here now belong to the Technical Council.

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

**Status: complete. Approved by both guardians; ADR-0021 and ADR-0022 Accepted
by the Product Owner 2026-09-25.**

Three review rounds, three rejections, one permitted pre-merge amendment.
Migration 005 hashes `376d8606e675…`; the Database Guardian verified that hash
against `CHECKSUMS` and re-ran every reproduction with their own probes rather
than accepting the report.

**What the three rounds found, because the shape matters more than the list.**
Round 1: a column grant is half a control — the privilege layer says which
columns may change, and only a trigger says which direction. Round 2: a trigger
that reads an unlocked parent row is half a trigger; revocation was recorded but
not effective in either direction; and a ceiling measured from a caller-supplied
timestamp is not a ceiling. Round 3: nothing in the schema at all — only a
document that had not caught up with it.

**Each round's finding was the previous round's fix, one level out.** The rule
to carry forward: *when you add an enforcement mechanism, ask what the mechanism
itself now depends on that is still a promise.* `FOR SHARE` exists because the
transition trigger depended on a snapshot; ADR-0021's condition 6 exists because
the `DEFAULT` depended on the application not naming a column.

### The task contract, written late — and that is itself a finding

CLAUDE.md says *"No task contract? Ask for one before starting."* There was no
W1-001 contract anywhere in `docs/` and the work started anyway; the
Architecture Guardian caught it during review and could not rule on scope
because there was nothing to rule against. Recorded here rather than
backdated, because a contract written after the fact is evidence about process,
not authority over what was built.

```
ALLOWED     database/migrations/005_create_sessions.sql
            database/migrations/CHECKSUMS
            database/tests/schema.spec.ts          (allowlist only — see below)
            tests/integration/refresh-rotation.spec.ts
            apps/api/src/health/health.service.ts  (REQUIRED_SCHEMA_VERSION only)
            packages/database/src/generated/schema.d.ts   (regenerated, never hand-edited)
            docs/adr/ADR-0021-*.md, docs/adr/ADR-0022-*.md
            docs/WAVE_1_REGISTER.md
READ ONLY   docs/adr/** (others), docs/NON_NEGOTIABLES.md, packages/observability/**
FORBIDDEN   packages/database/src/** (except generated), apps/** (except the
            constant above), any released migration
```

**Two scope rulings, Product Owner, 2026-09-25**, both prompted by the
Architecture Guardian rather than assumed:

*`database/tests/schema.spec.ts`* is IN, for the
`GLOBALLY_UNIQUE_INDEX_ALLOWLIST` only. ADR-0021's compliance requires it, and
the Architecture Guardian will not sign ADR-0021 as Accepted while its
compliance section has no owner. It must land in the SAME MERGE as 005: the
migration cannot merge before ADR-0021 is Accepted, and cannot merge green
without the allowlist. Nothing else in that file is in scope.

*`packages/observability/src/context.ts`* — the ADR-0021 requirement that
`sessionCorrelationId` may be set only alongside `tenantId` — is **W1-002's**,
which already owns the `asSessionCorrelationId` guard change for the `scid_`
format. The two observability edits land together rather than half here and
half later.

*`packages/database/src/generated/schema.d.ts`* is IN, as a regenerated
artefact only. `packages/database/src/**` is FORBIDDEN in this contract and
`npm run db:codegen` writes here; the D3 codegen-diff gate fails if it is
stale. The Database Guardian caught that I had flagged `health.service.ts` for
exactly this reason and not this file — same class, same ruling. It is never
hand-edited.

*`apps/api/src/health/health.service.ts`* (`REQUIRED_SCHEMA_VERSION` 4 → 5) is
IN. `app.spec.ts` asserts the constant equals the highest migration on disk with
no acknowledgement path, so adding a migration forces the change; the constant
belongs to whichever task adds a migration. One line, nothing else in `apps/`.

### What the two guardians rejected

Both reviews landed independently and **converged**; there was no split to take
to the Product Owner.

| # | Finding | State |
|---|---|---|
| R1 | **The central claim was false.** The header said single use was "enforced by the database, not by the application". `finsoft_app` could spend a token, `SET used_at = NULL`, and spend it again — and could un-revoke a family after reuse detection and un-revoke an admin-terminated session. Column grants without transition triggers. This is 004's defect #2 in a new table. | Fixed: five trigger functions |
| R2 | The header's fence SQL did `RETURNING family_id, session_id`; `refresh_tokens` has no `session_id`. It errors `42703` — neither executable nor what the test runs. | Fixed |
| R3 | The header declared ADR-0009:83's grace window "WRONG" citing a Product Owner instruction. LEVEL 1 retired by a LEVEL 3 comment plus LEVEL 2 approval — the authority table inverted. | Fixed: deferred to ADR-0022 |
| R4 | "Closes ADR-0016 debt D8" was false. `asSessionCorrelationId()` throws unless the value is a UUID; the schema stored values the only sanctioned reader rejects. | Fixed: "enables closure" |
| R5 | `sessions_correlation_key` global. Refuted on the merits — the log context already carries `(tenantId, sessionCorrelationId)` as a pair. | Fixed: tenant-scoped |
| R6 | The RLS deferral pointed at a Wave 1 register that did not exist on this branch. | Fixed: D-W1-004 below |
| R7 | Nine CHECK constraints verified by hand and asserted by no test. Hand verification is not a gate. | Fixed: 38 tests, up from 16 |
| R8 | ADR-0009 specifies `device_id`, `mfa_at`, `status`, `permission_version`; the draft shipped `mfa_completed boolean` and none of the rest. A boolean cannot express MFA *recency*, so step-up freshness was unevaluable. | Fixed: all four added, PO decision |
| R9 | **A token in a REVOKED family was still spendable.** After reuse detection killed a family, an unspent sibling returned rowcount 1 — which the header decodes as "this caller won and may rotate". Reuse detection *implies* an unspent sibling, so this was the live case. | Fixed: spend-transition guard, `FOR SHARE` |
| R10 | **Revoking a SESSION stopped nothing.** The family stayed live, its token spent, and a new token was appended to it; the chain kept rotating after an administrator ended it. `rtf_reject_revoked_session` only blocked *new* families, which an attacker has no need to open. | Fixed: `AFTER UPDATE` cascade |
| R11 | **`rt_lifetime_ceiling` was evadable.** Measured from a caller-supplied `issued_at`, so `issued_at = now()+350d, expires_at = now()+364d` was accepted — a 364-day credential — and the test named "refuses a token that outlives ADR-0009's ceiling" passed green over it. | Fixed: `issued_at <= now()` trigger |
| R12 | The `DEFAULT` on `session_correlation_id` was a strong default, not a control: a caller naming the column overrode it, and `id` and `created_at` were forgeable the same way (rule 13). | Fixed: column-scoped INSERT grants |
| R13 | Both `BEFORE INSERT` triggers failed **open** on a missing parent — rescued only by a constraint declared elsewhere. | Fixed: `IF NOT FOUND THEN RAISE` |
| The race | A trigger's unlocked `SELECT` read the pre-revocation snapshot, so a token could be inserted into a family revoked concurrently. Found by me, verified in an isolated reproduction, confirmed independently by the Database Guardian on two live connections (3.2s blocked, then refused). | Fixed: `FOR SHARE` |

### The correction that reframed the index question

The draft argued both globally unique indexes were "globally unique by
construction, like `id`". **That equivalence is false.** `id` is
`DEFAULT gen_random_uuid()` — entropy is a *schema fact*. Neither
`session_correlation_id` nor `token_hash` had a DEFAULT; both were
caller-supplied, and their CHECKs pin **shape, not entropy**.

The harm the draft reasoned about was also the wrong one. The real one,
measured on this schema:

```
tenant A:  SELECT ... WHERE token_hash = <B's hash>   ->  0 rows
tenant A:  INSERT ... token_hash = <B's hash>         ->  23505
```

**Unique index enforcement is not subject to RLS.** A `23505` is a cross-tenant
existence oracle that pierces ADR-0004, and one tenant's row can fail another
tenant's insert. `session_correlation_id` now carries a DEFAULT, which puts it
in `id`'s class; `token_hash` cannot, because the database must never see the
value it is the hash of.

### Debt

**D-W1-003 · `refresh_tokens` growth is unbounded and no retention policy exists.**
Roughly 96 rotations per session per day, appended forever because rule 4 grants
DELETE to nobody; ~1.75M rows/year at 50 active users. `sessions` is the same
shape an order of magnitude down.
*Decision (Product Owner, 2026-09-25): recorded as debt rather than decided now.*
Partitioning an empty table would impose complexity on every query and RLS policy
before there is data to justify it.
**Owner:** Database Guardian. **Trigger:** before `refresh_tokens` reaches 1M rows
in any environment, or at the first Wave where a retention/partition decision
blocks other work — whichever is first. **Candidate:** range partition by
`(tenant_id, issued_at)` monthly, or an explicit retention policy for
expired-and-spent tokens with the rule-4 analysis that justifies it.

**D-W1-004 · The pre-tenant by-hash lookup has no sanctioned mechanism.**
A refresh token is presented with no tenant context, but `refresh_tokens` is
tenant-owned with RLS ENABLE+FORCE and `current_setting('app.tenant_id')` with no
`missing_ok`, so an unauthenticated read **raises** rather than returning zero
rows. ADR-0004:77 is unambiguous that a caller with no tenant "operates only on
global tables", and `withGlobal` structurally cannot name this table.

Both guardians confirmed deferring is correct: the table's shape is invariant
under every candidate resolution, because all of them look up by hash alone and
none needs a column 005 lacks. **No code may read `refresh_tokens` without a
tenant until an ADR is Accepted.** Three conditions on W1-002:

1. It needs its own ADR, reviewed by the Database Guardian **and** the
   Architecture Guardian.
2. A `SECURITY DEFINER` resolver owned by `finsoft_migration` is a BYPASSRLS path
   by another name for every statement inside it. Measured alternative: a
   dedicated `finsoft_login` role with **no BYPASSRLS**, crossing the boundary via
   a named policy in `pg_policies` rather than a role attribute, with column-level
   grants bounding what it can read. Verified working — it returns the right
   tenant, can read `password_hash` but not `full_name` or `last_login_at`, holds
   no UPDATE, and leaves `roles.spec.ts`'s "`finsoft_migration` is the only
   BYPASSRLS role" assertion intact. Whatever is chosen must return
   `(tenant_id, token_id)` and nothing else, and must never surface or log a
   `23505` or its `DETAIL`.
3. **Rate limiting on that endpoint must be tenant-independent**, because there is
   no tenant to key it by before the lookup succeeds.

Also: the test `cannot spend another tenant's token by presenting its hash`
derives its whole guarantee from RLS being in force on the by-hash lookup — and
the real login path by definition has neither. **That IDOR property must be
re-proved through whatever mechanism W1-002 introduces**, or it silently stops
being tested at the moment it starts to matter.

**D-W1-006 · ADR-0021 states condition 5's scope three times (`:68`, `:70`, `:80`), and the production-minter gate twice in different wordings.**
Introduced by the `:55` amendment, which added paragraphs above the original
without merging it. **Not corrected**: the record is Accepted and the text is
accurate, merely redundant, so README §4 forbids tidying it — that rule exists
precisely so LEVEL 1 records are not quietly rewritten. Had it been caught
during the amendment it should have been merged; that window closed at
acceptance.
**Anyone editing one of the three must check the other two.** Merge them if
ADR-0021 is ever superseded. Owner: Database Guardian.

**D-W1-007 · A cost-based plan assertion over an append-only table will
eventually flip for everyone.** No live instance — the one recorded during
W1-001 was withdrawn as non-reproducing. The fix is to assert plans against a
corpus the test constructs and controls (a dedicated tenant, its own `ANALYZE`)
rather than against whatever the suite has accumulated. `refresh_tokens` is the
same shape as `outbox` and will grow faster. Owner: Database Guardian, Wave 2.

**D-W1-008 · `ADR-0008:25` instructs the wrong action at ADR-0018's acceptance.**
It reads "This notice is removed when ADR-0018 lands." ADR-0018 supersedes
ADR-0008 only on the balance row shape, the lock protocol and the negative-stock
policy — partial, so under README §4 as amended the notice is **replaced** by a
permanent scope notice, never removed. The sentence sits inside the notice
rather than the body, and §4 permits notice edits, so it may be corrected at the
Architecture Guardian's discretion at any time; it **must** be handled when
ADR-0018 is signed. Third partial supersession in the directory.

**D-W1-005 · `mfa_at`, `device_id`, `status` and `permission_version` are columns with no code.**
Added per ADR-0009 and the Product Owner's decision, because today is the last
cheap moment — each would otherwise be an `ALTER` on a released table. Nothing
writes or reads them yet. W1-003 owns `status` and `last_seen_at` throttling;
W1-004 owns `permission_version` bumping on role change.

### The gate, and one claim I withdraw

**The red gate is `database/tests/schema.spec.ts > scopes every unique
constraint on tenant-owned data by tenant (ADR-0003:28)`, on
`rt_token_hash_key`.** It is caused by 005, it is squarely inside W1-001, and
the test is right: ADR-0021 is `Proposed`, so ADR-0003:28 is still the rule in
force and the gate is reporting exactly the condition the migration's own
header declares. Closed by the `GLOBALLY_UNIQUE_INDEX_ALLOWLIST` added under
the Product Owner's scope ruling above, which merges in the same movement as
ADR-0021's acceptance. Under [GAP-001](COMPLIANCE_GAPS.md) nothing enforces a
red check, so this is held here rather than by CI.

**WITHDRAWN — the outbox plan-test failure.** An earlier version of this entry
recorded, as fact, that `database/tests/outbox.spec.ts > the claim query uses
the partial index rather than a sequential scan` had started failing because
accumulated rows flipped the planner to `outbox_correlation_idx`, and that
`ANALYZE` did not restore it. **It does not reproduce.** The Database Guardian
ran the suite at 22,614 rows across 117 tenants — more than the 20,569 I
measured — and got 50/50 green with `outbox_pending_idx` on an index-only
scan, and I reproduced that result afterwards. The mechanism I described
cannot produce the failure I described: `outbox_pending_idx` leads with
`tenant_id`, the claim query runs under RLS and therefore sees one tenant's
rows, and `outbox_correlation_idx` covers neither `status` nor the `ORDER BY`.
Most likely a window between autoanalyze and the suite's own `ANALYZE`.

I recorded a transient observation as a standing fact and stated "ANALYZE does
not restore it" without testing that claim. The entry is struck rather than
softened.

What survives is the general principle, which the Database Guardian has taken
as **D-W1-006**: a cost-based plan assertion against an append-only table that
nothing cleans up will eventually flip for everyone. `refresh_tokens` is the
same shape and will grow faster.

### Observed — outside this contract, not fixed

- **`version` could be rolled backward on every table**, including `outbox` from
  004. 005's three tables are now guarded by their transition triggers; **004 is
  not**, and the same `SET version = 0` works there. Ruled by the Database
  Guardian: **no forward migration now.** The exposure differs — on `outbox`,
  `lease_id` is the real fence on every dispatcher path (`004:316` says so
  deliberately), so a rewound `version` is an ABA on a secondary optimistic
  lock, not a lost claim; on `sessions` it would be the only lock. The fix is
  not a migration but **a schema test asserting that every table carrying a
  `version` column has a monotonic guard, with `outbox` on a dated, named
  exemption list** so the next table cannot rediscover this and 004's exemption
  has to be argued rather than forgotten. Owner: Database Guardian.
- **`users` holds table-level UPDATE for `finsoft_app`** with no REVOKE and no
  column scoping (migration 002), so `users.tenant_id` and `users.created_by` are
  application-writable today. Previously raised during the 004 review; still open.
  Needs a forward migration.

---

## W1-002 · `packages/auth`

**Status: not started.**

**A correction carried into the design, recorded because the plan had it wrong.**

The approved plan said concurrent refresh from two browser tabs is *"a legitimate race that must not revoke a family"*. That is wrong, and the Product Owner corrected it: **a replayed stolen refresh token and a second browser tab are indistinguishable to the server.** Both present a spent token; both look identical. OAuth 2.0 security guidance identifies exactly this inability to tell attacker from client during replay.

So there is **no blanket "concurrent reuse is allowed" exception.** Rotation is atomic and single-use; presenting a spent token revokes the family, whoever presented it. The client coordinates — one in-flight refresh per browser context — and the retry policy handles the loser rather than the server guessing intent.

### Review step carried from W1-001 — run it BEFORE `finsoft_login` lands

**After tightening any grant, ask which existing tests now pass *earlier* than
the thing they exist to prove.**

Measured on W1-001: `cannot plant a row under another tenant's id` asserted
`42501` for an RLS `WITH CHECK` violation and named `session_correlation_id` in
its INSERT. Once the column-scoped INSERT grant landed, that statement still
raised `42501` — from the grant — so the test would have gone on passing,
green, without ever reaching the policy it was written to test. A security
suite that passes for the wrong reason is decoration.

W1-002 tightens grants again: the `finsoft_login` role's column-level reads.
**This runs against the tenancy suite before that role is introduced, not
after** — afterwards there is no green-for-the-right-reason baseline left to
compare against.

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
