# ADR-0023: Reading before a tenant is known — authentication's one exception

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** Product Owner, Architecture Guardian, Database Guardian, Security Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) in respect of **account lockout only**, at two sites: the clause at ADR-0009:121 (*"Failed attempts feed the same lockout and alerting path as password failures"*) and the words *"account lockout with progressive backoff"* in the supporting-controls sentence at ADR-0009:123. Everything else in ADR-0009 remains in force. Line numbers are **as-accepted**, per the convention in ADR-0009's own head notice; those two are currently at :145 and :147 under the +24 offset.
**Blocks:** `packages/auth`, the `/auth/login` and `/auth/refresh` endpoints, and migration 006

## Context

[ADR-0004](ADR-0004-postgresql-row-level-security.md):77 is unambiguous: a caller with no tenant *"operates only on global tables."* Every tenant-owned table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy comparing `tenant_id` to `current_setting('app.tenant_id')` **with no `missing_ok`** — so an unset tenant does not return zero rows, it **raises**. That loud failure is deliberate, and `withGlobal` is typed so a tenant-owned table cannot even be named inside it.

Authentication is the one place where that rule and the system's requirements meet head-on, because two reads need a tenant-owned table *before* any tenant is known — establishing the tenant is what the read is **for**.

**Login.** ADR-0009:48: *"login → server resolves the user's tenant from the database."* `users` is tenant-owned.

**Refresh.** A refresh token arrives as a bare opaque 256-bit value in a cookie, stored SHA-256-hashed in `refresh_tokens` (tenant-owned). The lookup is `WHERE token_hash = $1` with nothing to scope by. [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) made that index globally unique for precisely this reason: under `(tenant_id, token_hash)` the same hash could legitimately exist in two tenants, so the lookup would have to tolerate several rows and pick one **in response to an unauthenticated request** — spending the wrong tenant's token or revoking the wrong tenant's family, a cross-tenant write and a rule 8 violation.

Migration 005 deliberately did not resolve this. It recorded the problem as debt D-W1-004 and both guardians confirmed deferring was correct, because the table's shape is invariant under every candidate mechanism: all of them look up by hash alone.

### Why this record exists in the shape it does

A first draft proposed one mechanism for both paths: a `SECURITY DEFINER` resolver owned by a `NOBYPASSRLS` role, crossing the tenant boundary through a named policy rather than a role attribute, for `users` **and** `refresh_tokens`.

**The security review killed the login half before this ADR was written**, which is why this is a design rather than a design with findings appended. Three things it established:

**`users_tenant_email_key` is `UNIQUE (tenant_id, lower(email))`.** Email is unique **per tenant**, not globally, and ADR-0009:86 explicitly contemplates a user belonging to several. So a resolver keyed on email alone returns **N rows**, and every disposal of N > 1 is a distinct vulnerability:

| Disposal | What it actually is |
|---|---|
| Verify against each hash until one matches | N × argon2id per request. An attacker who can seed one address across N tenants turns each attempt into N× server CPU — amplification the rate limiter cannot see, because it counts requests, not work. Also a timing oracle for N. |
| Return the tenant list for the client to choose | **Cross-tenant disclosure to an unauthenticated caller who knows only an email address.** |
| Pick the first row, or the lowest id, or the most recent login | A tenant-assignment rule with no security meaning, decided by physical row order, influenced by anyone who can provision a row. |
| Make `lower(email)` globally unique | Closed at LEVEL 1. ADR-0021's own text: an email *"fails condition 2 on sight and condition 3 in practice."* |

**The `USING (true)` policy would have sat on the table holding every password hash in the system.** That is the largest possible target for the smallest possible convenience.

**Two claims in the first draft's own measurement were wrong**, and both are recorded here rather than quietly fixed, because the second is a repeat:

1. The circulated DDL used `CREATE SCHEMA … AUTHORIZATION finsoft_login` and then `CREATE FUNCTION`. `AUTHORIZATION` sets the **schema's** owner; `CREATE FUNCTION` owns the function to the **executing** role — `finsoft_migration`, which has `BYPASSRLS`. Implemented from that write-up, the function would have run with unrestricted cross-tenant reach: the exact design the draft's own rationale rejected, reached silently. (The measurement itself used `SET ROLE` and verified `proowner`; the write-up did not, and a write-up is what someone implements from.)
2. The measurement ran in a scratch database that never executed `00-bootstrap.sh`. Verified afterwards: `has_schema_privilege('public','public','USAGE')` is **false** on the real cluster and **true** in that scratch database, so the resolver role inherited `USAGE` through `PUBLIC` and the function ran. On the real cluster it raises `permission denied for schema public`. **A security posture measured outside the bootstrap is not measured** — and the migration 005 grant audit had failed the same way, for the same reason, one task earlier.

## Decision

### 1. Login takes a tenant at the form. There is no login resolver.

`/auth/login` accepts a **tenant code** alongside the credential. The server resolves it against `tenants` — a **global** table: no `tenant_id`, no RLS, on `GLOBAL_TABLES`, and whose own migration header already says it is read by login before a tenant context exists. It then sets `app.tenant_id` and reads `users` **under ordinary RLS with all four layers intact**.

This is not an exception to ADR-0004:77. It is exactly the case ADR-0004:77 describes.

What it buys, and each is load-bearing:

- **`users` never carries a cross-tenant policy.** The pre-tenant surface halves, and what remains holds SHA-256 digests of random values rather than password hashes.
- **Exactly one candidate row**, so exactly one argon2id verification, so §4's constant-time rule is achievable rather than aspirational.
- The `tenant_id` that issues the claim is the one **under which the credential verified, with RLS in force during the verification read** — not asserted afterwards over a read taken with the policy disabled.

**THE BOUNDARY, IN THESE WORDS, because "ADR-0023 allowed a tenant input" is exactly how a per-request `tenantId` comes back:** a tenant hint **at the login form** is not what ADR-0009:151 rejected. ADR-0009 rejected `tenant_id` *supplied per request on authenticated endpoints and validated against memberships*, because correctness then depends on every handler performing the check, forever, and one omission is a cross-tenant write. A login-form selector **cannot grant access to a tenant the credential does not open**: a wrong code yields a miss, which yields the same 401 as a wrong password. It is an input to a single unauthenticated endpoint that mints a claim, never an input to an endpoint that consumes one.

**A form field, not a subdomain.** A per-tenant subdomain gives better UX and a natural cookie scope, but publishes every tenant code through DNS, TLS SNI and Certificate Transparency logs — permanently and publicly. A form field does not.

**The tenant code is included in the rate-limit key** (§5), so it cannot be used to multiply attempts against one address.

### 2. Refresh keeps one resolver, and it is narrow by construction

A `SECURITY DEFINER` function that maps a token hash to a tenant, and nothing else.

```sql
CREATE ROLE finsoft_refresh NOLOGIN NOBYPASSRLS;
GRANT finsoft_refresh TO finsoft_migration WITH INHERIT FALSE, SET TRUE;

GRANT SELECT (tenant_id, id, token_hash) ON refresh_tokens TO finsoft_refresh;
CREATE POLICY refresh_lookup ON refresh_tokens FOR SELECT TO finsoft_refresh USING (true);

CREATE SCHEMA auth_lookup;
REVOKE ALL    ON SCHEMA auth_lookup FROM PUBLIC;
REVOKE CREATE ON SCHEMA auth_lookup FROM finsoft_refresh;
GRANT  USAGE  ON SCHEMA auth_lookup TO finsoft_app;
GRANT  USAGE  ON SCHEMA public      TO finsoft_refresh;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth_lookup REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SET ROLE finsoft_refresh;                        -- OWNERSHIP. Not AUTHORIZATION.
CREATE FUNCTION auth_lookup.resolve_refresh(p_token_hash text)
RETURNS TABLE (tenant_id uuid, token_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.tenant_id, t.id FROM public.refresh_tokens t WHERE t.token_hash = p_token_hash
$$;
RESET ROLE;

REVOKE EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_app;
```

Every line above is normative. The ones that are not obvious:

- **`SET ROLE`, not `AUTHORIZATION`.** See Context. `AUTHORIZATION` owns the schema; only the executing role owns the function.
- **`WITH INHERIT FALSE, SET TRUE`.** `SET TRUE` permits the `SET ROLE`; `INHERIT FALSE` means `finsoft_migration` never holds the privilege passively, only by assuming it deliberately.
- **`CREATE SCHEMA` without `AUTHORIZATION`**, so the resolver's owner owns nothing and can create nothing. A `SECURITY DEFINER` function's owner should be as powerless as the function allows.
- **`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC`.** PostgreSQL grants `EXECUTE` to `PUBLIC` on every new function. The explicit `REVOKE` covers this function; this line covers the next one, which someone will add without reading this record.
- **`GRANT USAGE ON SCHEMA public TO finsoft_refresh`.** `00-bootstrap.sh` revokes `ALL` from `PUBLIC` on `public` and grants `USAGE` back to two roles only. Without this line the function raises. This is the grant whose absence the first draft's measurement concealed.
- **`search_path = pg_catalog, pg_temp`**, with `public` **dropped** and every relation schema-qualified. `pg_temp` is implicitly searched first for relations when it is not named, so naming it last is the only way to put it last. `finsoft_app` cannot create temp tables today (no `TEMPORARY` privilege), but that is an accident of the bootstrap rather than a decision, and functions and operators *are* resolved from `public`.
- **`STABLE`.** Not a planning hint. PostgreSQL rejects a data-modifying statement inside a non-`VOLATILE` function at runtime, so this is a mechanically enforced *"this resolver cannot write."* It also keeps the body from being inlined and re-planned under the caller's privileges, which `SECURITY DEFINER` plus the `SET` clause already prevent.
- **`LEAKPROOF` must stay false**, so the body can never be pushed below an RLS qual. Only a superuser can set it; this is a tripwire, not a likely accident.

**The resolver returns `(tenant_id, token_id)` and no state.** Not `used_at`, not `expires_at`, not the family's `revoked_at`.

> **The resolver decides *where*. The spend decides *whether*.**

There is a TOCTOU gap between resolving and spending, and it is **harmless because the spend re-evaluates everything atomically** — [ADR-0022](ADR-0022-no-grace-window-on-refresh-rotation.md)'s `UPDATE … WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, under the tenant context, under RLS, under the row lock, under the transition triggers. Stating the gap is what stops someone closing it by trusting the resolver's read, which is how it would become real.

**The spend statement additionally carries `AND tenant_id = $resolved AND id = $resolved_token_id`.** That is the repository layer of ADR-0009's four, and it converts a resolver bug from a wrong-row write into zero rows.

**The resolver touches one table and writes nothing.** If the spend were moved inside it, the role would need grants on `refresh_token_families` and `sessions`, and migration 005's whole trigger chain — the `FOR SHARE` reads, the revocation cascade, every finding from that review — would execute under a role whose policy set nobody has reasoned about.

### 3. One transaction shape, in one place

`packages/database` gains a third helper beside `withTenant` and `withGlobal`, because the refresh path is neither: it must resolve and *then* set the tenant, **inside one transaction**, since `set_config(…, true)` is transaction-scoped and a resolve and a spend on two pool checkouts are two connections.

```ts
withResolvedTenant(resolver, fn)
```

Four requirements:

1. It is the **only** place a resolver function may be called. ADR-0004's lint rule confining `set_config('app.tenant_id'` to `packages/database` extends to the resolver call sites, or the boundary moves without anyone noticing.
2. The callback receives a `TenantTx` **only after** `app.tenant_id` is set, so no tenant-table statement can run before it. This preserves ADR-0004:77's loud failure on the one path that otherwise weakens it.
3. The value passed to `set_config` is the resolver's return value, and **no request-derived value is in scope in the same function.**
4. It sets the tenant **exactly once**. A second call in the same transaction is an error, not a re-scope.

### 4. One argon2id verification per login request. Always. Exactly one.

Argon2id is 50–150 ms; a miss is ~1 ms. That ratio is measurable remotely in a few hundred samples. **The oracle is not the function — it is the branch the application takes on row count.**

There is a second fast path that is easy to miss: `users.password_hash` is nullable and `users_active_requires_password` only constrains `status = 'ACTIVE'`, so an `INVITED`, `SUSPENDED` or `DISABLED` row may have no hash. A natural *"no hash, fail fast"* gives a third timing class — an oracle distinguishing *"an invited account exists at this address"* from *"nothing exists"*, which names a real person at a real company who has not yet set a password. That is worth more to an attacker than plain existence.

Normative:

1. **Exactly one** verification per request, on every path. Zero is an oracle; two or more is an oracle *and* a CPU amplification vector.
2. On a miss, and on any hit where `password_hash IS NULL`, the verification runs against a **decoy hash computed at process start** from a CSPRNG value **using the live parameter object** — the same object the real verifier uses. A decoy baked in with yesterday's parameters becomes an oracle the day the parameters are tuned.
3. **Order: resolve → verify (always) → evaluate `users.status` → evaluate `tenants.status` → issue.** Never skip work on a lifecycle state.
4. **One response for every failure**: identical status, body bytes, error code and headers. Unknown tenant code, unknown email, wrong password, invited, suspended, disabled, suspended tenant, throttled — all identical. *"Your account is locked"* is an enumeration oracle **and** confirms to an attacker that their denial-of-service landed.
5. **Counters increment identically on a miss and a hit**, or the rate limiter is the oracle: probe until throttled, compare against a control.
6. **This binds every account-bearing endpoint**, not only login: invite acceptance, password-reset request, MFA challenge, email-change confirmation. A constant-time login beside a reset endpoint that says *"no such user"* buys nothing.
7. **Accepted and stated rather than engineered away:** a login failure against an unknown tenant code or unknown email **cannot be audited**, only logged, because `audit_log` is tenant-owned and rule 7 forbids a tenantless row. Someone will propose a tenantless audit row to close that gap. The answer is no, recorded here in advance.

### 5. Throttling and lockout are different things

ADR-0009:121 and :123 describe a sticky per-user lockout triggered by an attacker-chosen key. **Anyone who knows an employee's email address can make that employee unable to work** — possibly the only holder of `period.close` on the last day of a month. That is a business-impacting attack with a one-line exploit, and it is superseded here.

**Throttling** is keyed on attacker-controllable input, always time-decaying, always self-recovering, and **never requires administrator action**. All layers are evaluated on every request; the request is rejected if **any** is exhausted.

| Layer | Key | Character |
|---|---|---|
| 1 | normalised email + tenant code | **throttle only, never a sticky lock** — the key is attacker-chosen |
| 2 | IP prefix — **/32 v4, /64 v6** | higher volume, faster window |
| 3 | (IP prefix, email) | tightest and cheapest |
| 4 | global failed-logins per minute for the endpoint | **alert and global slowdown, never a hard block** — a global block is self-DoS and is the attacker's actual goal |
| 5 | escalation on layer 1 | proof-of-work or CAPTCHA after N failures: **the attacker pays, the victim does not** |

- **`X-Forwarded-For`: take the Nth-from-the-right entry for a configured N.** Never the leftmost, never a framework's `req.ip` default. Leftmost parsing gives an attacker an unbounded key space *and* the ability to spend a victim's budget by spoofing their address — a worse primitive than the bypass.
- **The limiter fails closed.** If Redis is unreachable, `/auth/login` and `/auth/refresh` return 503. A limiter that fails open is one an attacker removes by attacking Redis first.
- **Normalise the email exactly as the lookup does**, or `Victim@x.com` and `victim@x.com` are two budgets for one account.

**Lockout** — a sticky state needing an unlock — may only be keyed on something an attacker cannot choose *on someone else's behalf*. The defensible key is **(user, device/IP)**, never (user): it stops the attacker's source and leaves the victim's own device working.

**Throttle state lives in Redis, not on `users`.** On `users` it would need `locked_until` and `failed_attempt_count` in a pre-tenant column grant, widening the read and putting a mutable counter behind a permissive policy. The cost is that throttle state is lost on a Redis flush — accepted, because a throttle is not an audit record and the durable record is the business event written after the tenant is known.

### 6. What a database error may become

- On `/auth/login` and `/auth/refresh`, a driver error is caught at the boundary and rethrown carrying **only a code**. No `detail`, `hint`, `where`, `internalQuery`, `internalPosition`, `schema`, `table` or `constraint` is logged or serialised. **Existing redaction does not cover this**: it denies object *keys* by substring, and a bare 64-hex digest inside a free-text `detail` string matches no rule.
- A `23505` on `rt_token_hash_key` is reachable on the **insert**, never on the presentation `SELECT`. It is a ~2⁻¹²² event or a broken minter. It is **a generic 500 plus a Sev-2 alert with the hash absent from the payload**, and an investigation. **It must never be handled by retrying with a fresh value and succeeding silently** — that converts a broken-minter alarm into normal operation.
- **ADR-0021's production-minter test becomes this record's gate too**, not an inherited one. ADR-0021 says its `rt_token_hash_key` allowlist entry *"is invalid until that test exists"*, and this ADR is what makes the pre-tenant lookup live in front of it.

## Consequences

### Positive

- One cross-tenant read, on one table, holding digests of random values. Not password hashes.
- The tenant that issues a claim is established under RLS on both paths.
- Exactly one candidate row on login makes constant-time behaviour reachable.
- The throttle/lockout split removes a named-user denial of service that ADR-0009 would have required building.

### Negative, and accepted

- **`refresh_tokens` is readable across tenants by one role.** ADR-0004's backstop does not apply on that path; isolation rests on the column grant, the function body and role-membership containment. This is the same shape of admission ADR-0021 made for one index, and it is recorded with the same candour.
- **The function body is protected by migration immutability, not by a mechanism.** Nothing outside a migration can `SET ROLE finsoft_refresh`, but a future *numbered* migration can widen the body or the grant, and only review catches it. A review gate, honestly labelled — the same class as ADR-0021 condition 5.
- **Tenant enumeration through the code field**, mitigated by §4's identical-response rule and by including the code in the rate-limit key.
- **A resolver miss cannot be audited**, only logged.
- **`email` will appear in `LOGIN_FAILED` log lines.** Operationally necessary and standard, but it is PII in an aggregated store. Decided here rather than discovered in the aggregator.

## Alternatives considered

**One resolver for both paths, keyed on email.** Rejected — see Context. The N > 1 problem has no safe disposal and the policy would sit on the password-hash table.

**A resolver owned by `finsoft_migration`.** Rejected: that role has `BYPASSRLS`, so every statement in the body runs with unrestricted reach and a bug in the body is a full cross-tenant read. This is also what the first draft would have built by accident.

**A global `token_directory(token_hash → tenant_id)` table.** Rejected by the Architecture Guardian at W1-001: it puts a credential-derived value on an unprotected table readable before authentication — a worse blast radius than the index it avoids — and creates a two-table consistency obligation on the authentication path.

**Verifying the password inside the database.** Rejected, and the decisive reason is not the usual one: it requires the **raw password** to cross into the database, where it reaches `log_min_duration_statement` output on any slow login, `log_statement` if it is ever turned up during an incident, and any error log for a failed statement. A plaintext password in a database log is a breach; a hash in the API's heap is a secret. Also: pgcrypto has no argon2; parameters must be rotatable with rehash-on-login, which ADR-0009 puts in the application; and argon2id at 19 MiB per login inside the database process consumes the least horizontally scalable resource in the system, on the one endpoint whose rate an unauthenticated attacker controls.

**A per-tenant subdomain instead of a form field.** Rejected — publishes every tenant code through DNS, TLS SNI and Certificate Transparency.

**Keeping ADR-0009's per-user lockout.** Rejected as a named-user denial of service available to anyone who knows an email address.

## Compliance

**The primary gate, and the single most valuable assertion in this record:**

- **With `refresh_lookup` dropped, `resolve_refresh` must FAIL.** If it still returns rows, it is running with bypass and the mechanism is not what this document claims. Run as a transactional `DROP POLICY` and rollback. Every other outcome — correct tenant returned, `finsoft_app` still raising, the BYPASSRLS assertion intact — is *also* produced by the rejected design, so this is the only test that discriminates.
- `SET ROLE finsoft_refresh; SELECT expires_at FROM refresh_tokens;` raises `42501`. Proves the column grant bounds the read, not the role's identity.

**Catalogue assertions, written over the class and not over this one function:**

- For **every** `prosecdef = true` function: the owner is in an explicit allowlist, that owner's `rolbypassrls` is `false`, `provolatile = 's'`, `proleakproof = false`, and `proconfig` carries a `search_path`. Over the class, so the next one added inherits it.
- **`pg_auth_members` exact match**: `finsoft_refresh` has exactly one member, `finsoft_migration`. `pg_has_role('finsoft_app','finsoft_refresh','USAGE')` and `('MEMBER')` are false; likewise `readonly_support`. **A list that can grow is not a control** — one `GRANT finsoft_refresh TO finsoft_app` would otherwise let the API role `SET ROLE` and read every tenant's tokens.
- For every non-superuser role, memberships asserted against an exact allowlist. Role membership is a privilege-escalation surface this repository does not currently test at all.
- `finsoft_refresh` is `NOLOGIN` and holds no `CONNECT` on the database.
- `finsoft_refresh` holds no `INSERT`, `UPDATE` or `DELETE` on any table — exact match, not the absence of a `GRANT`.
- `has_database_privilege('finsoft_app', current_database(), 'TEMPORARY')` is false.
- `public.users` and `public.refresh_tokens` are `relkind = 'r'`. **A view without `security_invoker = true` executes as the view owner** — `finsoft_migration`, with `BYPASSRLS` — and `database/tests/catalog.ts` filters `relkind = 'r'` in every query, so a view over a tenant-owned table is currently invisible to the RLS, schema and roles suites alike. That gap predates this ADR; this ADR makes it a login-path gap.

**`PRE_TENANT_POLICY_ALLOWLIST` in `database/tests/rls.spec.ts`.** A `FOR SELECT … USING (true)` policy breaks three of its assertions: that every policy has a non-null `WITH CHECK`, that both clauses are the same `current_setting` comparison *"and nothing else"*, and that every policy applies to `ALL`. **The tempting fix — relaxing those assertions — would let any future `USING (true)` policy on any tenant-owned table pass CI silently.** That is ADR-0021's own complaint about a LEVEL 1 rule whose carve-out lives in a LEVEL 3 artefact, repeated on the policy gate instead of the index gate.

So: an exact-match allowlist modelled on `GLOBALLY_UNIQUE_INDEX_ALLOWLIST`, carrying per entry the table, policy, role, command, **exact column set**, ADR and reason — with assertions that the policy is `FOR SELECT` only, `polroles` is exactly the one named role, that role is not `BYPASSRLS`, its column-level `SELECT` privileges are an **exact set match**, and the entry names a policy that exists so a stale exemption fails rather than lingers. **Every policy not in the allowlist keeps all three assertions at full strength.** The exact-column assertion is the one that pays for itself: without it, one plausible-looking `GRANT SELECT ON refresh_tokens TO finsoft_refresh` silently widens the cross-tenant read to every column a future migration adds.

**Behavioural tests:**

- **D-W1-004's re-proof obligation.** `cannot spend another tenant's token by presenting its hash` currently derives its entire guarantee from RLS being in force on the by-hash lookup — which is exactly what this ADR removes. It must be re-proved **through this mechanism**, or it silently stops testing anything at the moment it starts to matter.
- Identical response bytes across: unknown tenant code, unknown email, wrong password, `INVITED`, `SUSPENDED`, `DISABLED`, suspended tenant, throttled.
- Exactly one argon2id invocation per login request on each of those paths — asserted by counting invocations, not by timing.
- A login or refresh request carrying `tenantId` / `tenant_id` / `X-Tenant-Id` in body, query, header or a second cookie produces a byte-identical response and an identical `tenant_id` claim. **ADR-0009:184's existing version of this test runs against *guarded* endpoints; these two have no guard, and they are where the claim is minted.**
- The JWT payload's `tenant_id` is assigned from the resolver's or the global-`tenants` read's return value at exactly one site.
- The limiter fails closed: with Redis unreachable, both endpoints return 503.

**Other required assertions:** `auth_lookup` is added to `database/tests/catalog.ts`'s queries, or asserted to contain zero relations of any relkind; `roles.spec.ts`'s hardcoded grantee lists are derived from `pg_roles` so the next role is covered by construction; `log_parameter_max_length = 0` on staging and production, asserted beside the existing `statement_timeout` assertions.

## Open — requires a decision outside this record

- **`docs/INFRASTRUCTURE.md` §5 enumerates four database roles.** Adding `finsoft_refresh` to the production inventory is a LEVEL 2 change needing Product Owner approval. This ADR must not leave the production role inventory and the runbook disagreeing.
- **The cookie prefix.** `__Host-` forbids `Domain` and forces `Path=/`, contradicting ADR-0009:52's scoped path; `__Secure-` is compatible with it. Recommended: `__Secure-` plus the scoped path, because limiting which requests carry the credential is the larger win — **unless** the app shares a registrable domain with anything else, where `__Host-`'s anti-subdomain-shadowing property wins. Left unstated, an implementer picks one and is wrong half the time.
- **The pre-MFA token.** A login that passes the password but not MFA must not mint a refresh token, but the MFA secret is on a tenant-owned table. Recommended: a ≤2-minute, single-purpose, signed pre-authentication token carrying the resolved `tenant_id` and a distinct `typ`/`aud`, accepted at `/auth/mfa` and **rejected by the global guard everywhere else including `/auth/refresh`**, carrying no `session_id` and no permission claims. Without this, an implementer either re-runs a pre-tenant read at the MFA step or issues a full session before MFA.
- **A login page does not exist** in `docs/design-system/pages/`, and the PRD does not scope multi-tenant users. The tenant-code field is a product requirement, recorded by the Product Owner rather than decided by implication here.

## Related

- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — :77, the rule this record carves the one exception to
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — :48 login resolves the tenant, :86 multi-tenant users, :151 the per-request `tenant_id` this must not become; **superseded in part on lockout**
- [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) — why `rt_token_hash_key` is globally unique, and the production-minter gate this record inherits
- [ADR-0022](ADR-0022-no-grace-window-on-refresh-rotation.md) — the atomic spend that decides *whether*, after this record decides *where*
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md), [ADR-0016](ADR-0016-structured-logging-and-observability-package.md) — tenancy, and what may never be logged
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 7 (tenant on every row), rule 8 (no cross-tenant write), rule 9 (audit)
- [../TECH_DEBT.md](../TECH_DEBT.md) — TD-005, `users` table-level `UPDATE`, which login's `last_login_at` write makes live

## Signatures

| | |
|---|---|
| **Security Guardian** | ☐ not recorded — threat-modelled the draft design; findings incorporated above |
| **Database Guardian** | ☐ not recorded |
| **Architecture Guardian** | ☐ not recorded |
| **Product Owner** | ☐ not recorded — decided §1's tenant field and §5's throttle/lockout split, 2026-09-25 |

Migration 006 and `packages/auth` do not merge before all four.
