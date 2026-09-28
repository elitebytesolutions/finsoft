# ADR-0023: Reading before a tenant is known — authentication's one exception

**Status:** Accepted — 2026-09-27
**Date:** 2026-09-26
**Deciders:** Architecture seat, Database/Security seat ([ADR-0024](ADR-0024-operating-model.md)). *As drafted: Product Owner, Architecture Guardian, Database Guardian, Security Guardian — the Product Owner slot was withdrawn by ADR-0024 §8 on 2026-09-27; the Product Owner's 2026-09-25 decisions recorded below stand as decisions.*
**Authority:** LEVEL 1 — reversing this requires a superseding ADR
**Supersedes:** [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) in respect of **account lockout only**, at two sites: the clause at ADR-0009:121 (*"Failed attempts feed the same lockout and alerting path as password failures"*) and the words *"account lockout with progressive backoff"* in the supporting-controls sentence at ADR-0009:123. Everything else in ADR-0009 remains in force. Line numbers are **as-accepted**, per the convention in ADR-0009's own head notice; those two are currently at :145 and :147 under the +24 offset.
**Also amends:** [../ARCHITECTURE.md](../ARCHITECTURE.md) §6 (line 279), which reads *"`app.tenant_id` is set per transaction by the connection wrapper from the tenant context — **never from user-supplied input**."* §1 sets it from a tenant code in the login request body, so that sentence is contradicted word for word. Both guardians judged §1 correct and this record's boundary argument sound — but it argued against ADR-0004:77 and ADR-0009:151 and **never named the sentence it actually contradicts.** CLAUDE.md tells every agent to stop when two documents contradict, so the next implementer would have stopped here, correctly. §6 gains the carve-out and a pointer back.
**Carves out of:** [ADR-0004](ADR-0004-postgresql-row-level-security.md) binding rule 2 (:75, *"The value comes from the authenticated session only — the `tenant_id` claim in the verified JWT"*) at **both** claim-minting endpoints, where the value comes from a resolver instead; and binding rule 4 (:77, *"it operates only on global tables"*) at **`/auth/refresh` only**, through `auth_lookup.resolve_refresh`. Login does not carve out of :77 — its pre-tenant phase reads only `tenants` — which is what §1 says. Nothing else in ADR-0004 changes; rules 1, 3 and 5 hold on both paths, and rule 3 is what §3 builds on. *Added by the Architecture seat at signature, 2026-09-27: the same defect class as the §6 finding above — the record argued against :77 and never named :75, the sentence both paths actually contradict. No decision or mechanism in §1–§6 changes.*
**Blocks:** `packages/auth`, the `/auth/login` and `/auth/refresh` endpoints, and migrations 006 and 007 — **until accepted; accepted 2026-09-27.** The Compliance assertions still ship in the same PR as the DDL they guard, and the Architecture seat's conditions under Signatures bind the merge.

---

> ## ⛔ Conflict notice — one sentence of §3 (:191) is to be superseded by ADR-0025, pending
>
> **This ADR is in force.** Its `Status:` stays `Accepted`. This notice records status only. The decision, rationale and consequences below are untouched and stay exactly as accepted, per [the ADR README](README.md) §4.
>
> [ADR-0025](ADR-0025-login-read-and-write-transactions.md) is **Proposed, 2026-09-27**. The Architecture seat has approved it, and the Database/Security seat is pending. It would supersede **one sentence of §3 and nothing else in this record**. It also clarifies one §5 cell without changing that cell:
>
> | Provision | Under ADR-0025 |
> |---|---|
> | Line 191: "Sharing the helper also means the credential verification and the `last_login_at` write share one transaction with the tenant established once, which §1's claim about RLS being in force during verification requires and does not otherwise get." | **Would be superseded.** The resolve+read transaction and the write transaction are separate. Both enter via `withResolvedTenant`. The write re-asserts user status, the verified `password_hash`, tenant identity and tenant status atomically. No transaction is open during credential verification. §1's RLS claim is met by the read |
> | Line 235: layer 4, "alert and global slowdown, never a hard block" | **Unchanged, but clarified.** The slowdown is the capped argon2id semaphore. The `login:global` counter is alert-only, and its alert is deduplicated to once a minute |
>
> Everything else in §3 stays in force, including :187 and requirements 1–4 at :201–:204. Each of the two transactions meets them separately.
>
> **Blocked meanwhile:** the M1-A login split (`feature/M1-A-auth`) cannot merge until ADR-0025 is Accepted. When it is, this notice is replaced in place, at the same line count, by the permanent supersession scope notice.
>
> **Line numbers.** Every `ADR-0023:NN` citation in the repository was written against the **as-accepted** text. This notice adds 21 lines at the head, so an as-accepted line NN is now at NN+21: :191 → 212, :235 → 256. Citations are not rewritten. The offset is fixed at +21, and any later edit here must preserve its line count.

---

## Context

[ADR-0004](ADR-0004-postgresql-row-level-security.md):77 is unambiguous: a caller with no tenant *"operates only on global tables."* Every tenant-owned table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy comparing `tenant_id` to `current_setting('app.tenant_id')` **with no `missing_ok`** — so an unset tenant does not return zero rows, it **raises**. That loud failure is deliberate, and `withGlobal` is typed so a tenant-owned table cannot even be named inside it.

Authentication is the one place where that rule and the system's requirements meet head-on, because two reads need a tenant-owned table *before* any tenant is known — establishing the tenant is what the read is **for**.

**Login.** ADR-0009:48: *"login → server resolves the user's tenant from the database."* `users` is tenant-owned.

**Refresh.** A refresh token arrives as a bare opaque 256-bit value in a cookie, stored SHA-256-hashed in `refresh_tokens` (tenant-owned). The lookup is `WHERE token_hash = $1` with nothing to scope by. [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) made that index globally unique for precisely this reason: under `(tenant_id, token_hash)` the same hash could legitimately exist in two tenants, so the lookup would have to tolerate several rows and pick one **in response to an unauthenticated request** — spending the wrong tenant's token or revoking the wrong tenant's family, a cross-tenant write and a rule 8 violation.

Migration 005 deliberately did not resolve this. It recorded the problem as debt D-W1-004 and both guardians confirmed deferring was correct, because the table's shape is invariant under every candidate mechanism: all of them look up by hash alone.

### Why this record exists in the shape it does

A first draft proposed one mechanism for both paths: a `SECURITY DEFINER` resolver owned by a `NOBYPASSRLS` role, crossing the tenant boundary through a named policy rather than a role attribute, for `users` **and** `refresh_tokens`.

**The security review killed the login half before this ADR was written**, which is why this is a design rather than a design with findings appended. Three things it established:

**`users_tenant_email_key` is `UNIQUE (tenant_id, lower(email))`.** Email is unique **per tenant**, not globally, and ADR-0009:62 explicitly contemplates a user belonging to several. So a resolver keyed on email alone returns **N rows**, and every disposal of N > 1 is a distinct vulnerability:

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
- **Exactly one candidate row**, so exactly one argon2id verification, so §4's constant-time rule is achievable rather than aspirational. **The predicate is `lower(email) = $2`, not `email = $2`** — `users_tenant_email_key` is `UNIQUE (tenant_id, lower(email))`, an expression index, so the plain form neither uses it nor respects the case-insensitive uniqueness this bullet depends on. Measured with `lower()`: `Index Scan using users_tenant_email_key`.
- The `tenant_id` that issues the claim is the one **under which the credential verified, with RLS in force during the verification read** — not asserted afterwards over a read taken with the policy disabled.

**THE BOUNDARY, IN THESE WORDS, because "ADR-0023 allowed a tenant input" is exactly how a per-request `tenantId` comes back:** a tenant hint **at the login form** is not what ADR-0009:151 rejected. ADR-0009 rejected `tenant_id` *supplied per request on authenticated endpoints and validated against memberships*, because correctness then depends on every handler performing the check, forever, and one omission is a cross-tenant write. A login-form selector **cannot grant access to a tenant the credential does not open**: a wrong code yields a miss, which yields the same 401 as a wrong password. It is an input to a single unauthenticated endpoint that mints a claim, never an input to an endpoint that consumes one.

**A form field, not a subdomain.** A per-tenant subdomain gives better UX and a natural cookie scope, but publishes every tenant code through DNS, TLS SNI and Certificate Transparency logs — permanently and publicly. A form field does not.

**The tenant code is part of the rate-limit key (§5), and that CUTS BOTH WAYS.** An earlier draft claimed it meant the code *"cannot be used to multiply attempts against one address."* **That is backwards.** Including the code **partitions** the budget by code: it helps against a targeted victim, and against enumeration it is the vulnerability — an attacker guessing codes for a known email gets a **fresh layer-1 budget per guess**. §5 therefore carries a **code-independent, email-only layer**, and tenant enumeration is bounded by §4's identical response and by layers 2 and 4, **not** by the code's presence in the key.

**`tenants` IS NOW AN AUTHENTICATION TABLE, and it has no RLS.** The narrowing made `tenants.code` and `tenants.status` login inputs. `001_create_tenants.sql:99` grants `SELECT, INSERT, UPDATE ON tenants TO finsoft_app`, and the table is global — **no RLS by design, so there is no fourth-layer backstop on it at all.**

Any endpoint that ever updates a tenant row with an omitted or wrong predicate writes another tenant's row and nothing below the repository catches it. Set another tenant's `status` to a non-`ACTIVE` value and every user of that tenant fails login at §4's status check, with §4's identical 401 giving them no diagnostic. Rewrite another tenant's `code` and its users can no longer name their tenant at the form. **Denial of authentication for an entire business, from a single missing `WHERE`.**

So migration 007 narrows `finsoft_app`'s grant on `tenants` to a column list **excluding `code` and `status`**, in the style migration 005 already uses. If tenant rename or suspension is a product requirement it is a separately permissioned, separately audited high-privilege action that also revokes every session in the affected tenant — a LEVEL 2 item, routed rather than assumed. Narrowing now is one line; narrowing after a handler exists is an audit.

### 2. Refresh keeps one resolver, and it is narrow by construction

A `SECURITY DEFINER` function that maps a token hash to a tenant, and nothing else.

**The role is created in `00-bootstrap.sh`, NOT in a migration.** Measured: `finsoft_migration` has `rolcreaterole = false`, so `CREATE ROLE` raises *"permission denied to create role"*, and it holds no `ADMIN OPTION`, so it cannot even grant the role to itself. Both statements belong in the bootstrap and in the production provisioning path:

```sql
-- 00-bootstrap.sh, as the bootstrap superuser
CREATE ROLE finsoft_refresh NOLOGIN NOBYPASSRLS;
GRANT finsoft_refresh TO finsoft_migration WITH INHERIT FALSE, SET TRUE;
```

`SET TRUE` permits the `SET ROLE`; `INHERIT FALSE` means `finsoft_migration` never holds the privilege passively. Measured: `inherit_option = f, set_option = t, admin_option = f`, and `pg_has_role('finsoft_migration','finsoft_refresh','USAGE')` is false while `MEMBER` and `SET` are true. **`INHERIT FALSE` is also the direct cause of the worst bug an earlier draft shipped** — see the note after the migration.

**Consequence that must be placed rather than discovered:** `00-bootstrap.sh` runs only on an empty data directory, so every existing cluster — local dev, local test, CI cache, staging — needs the role out of band or a `down -v`. Migration 006 therefore **opens with a guard that raises a readable message if the role is absent**, rather than failing at a `GRANT`. And the role's attributes then live in an un-checksummed shell script: this record's "protected by migration immutability" claim is true of the **function body** and **not** of `NOLOGIN`/`NOBYPASSRLS`. The catalogue assertion is the only control there.

```sql
-- 006_pre_tenant_refresh_lookup.sql
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finsoft_refresh') THEN
    RAISE EXCEPTION 'finsoft_refresh is missing. It is created by 00-bootstrap.sh, '
      'not by a migration (finsoft_migration has no CREATEROLE). Provision it, or '
      'recreate the cluster with docker compose down -v.';
  END IF;
END $g$;

GRANT SELECT (tenant_id, id, token_hash) ON refresh_tokens TO finsoft_refresh;
CREATE POLICY refresh_lookup ON refresh_tokens FOR SELECT TO finsoft_refresh USING (true);

CREATE SCHEMA auth_lookup;
REVOKE ALL   ON SCHEMA auth_lookup FROM PUBLIC;
GRANT  USAGE ON SCHEMA auth_lookup TO finsoft_app;
GRANT  USAGE ON SCHEMA public      TO finsoft_refresh;

-- TRANSIENT. The owner needs CREATE to create its own function; it is revoked
-- below, so the end state is an owner that owns nothing and can create nothing.
GRANT USAGE, CREATE ON SCHEMA auth_lookup TO finsoft_refresh;

SET ROLE finsoft_refresh;                        -- OWNERSHIP. Not AUTHORIZATION.

  CREATE FUNCTION auth_lookup.resolve_refresh(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, token_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER ROWS 1
  SET search_path = pg_catalog, pg_temp AS $fn$
    SELECT t.tenant_id, t.id FROM public.refresh_tokens t WHERE t.token_hash = p_token_hash
  $fn$;

  -- INSIDE the SET ROLE block. Outside it these two statements are NO-OPS that
  -- report success — see the note below.
  REVOKE EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) FROM PUBLIC;
  GRANT  EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_app;

  -- Schema-less and FOR ROLE the creating role. The IN SCHEMA form records
  -- nothing here; see the note below.
  ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_refresh REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

RESET ROLE;

REVOKE CREATE ON SCHEMA auth_lookup FROM finsoft_refresh;   -- the transient grant, withdrawn
```

Every line above is normative, and **five statements in an earlier draft of it were wrong — four of which did not raise.** That is a worse shape than an error that aborts, because `ON_ERROR_STOP=1` sails past a `WARNING` and the migration commits green. All five are measured, and two of them shipped a working cross-tenant read path:

**`REVOKE`/`GRANT EXECUTE` must be INSIDE the `SET ROLE` block.** Outside it, issued as `finsoft_migration`, they are no-ops that report success — because the function is owned by `finsoft_refresh` and `INHERIT FALSE` deliberately withholds the owner's grant option. Measured verbatim:

```
WARNING:  no privileges could be revoked for "resolve_refresh"
WARNING:  no privileges were granted for "resolve_refresh"
proacl = {=X/finsoft_refresh,finsoft_refresh=X/finsoft_refresh}
```

`=X` is **EXECUTE to PUBLIC**. Every role in the cluster, including `readonly_support` — a **login** role whose whole premise (ADR-0004:61) is that it reaches a tenant only by having one set — holds EXECUTE on the cross-tenant resolver. The only thing then stopping it is that it lacks `USAGE` on `auth_lookup`, so one plausible future `GRANT USAGE ON SCHEMA auth_lookup` completes the path. **So the correct design in the bootstrap is what broke these two lines**, and this record's own Consequences claim of "readable across tenants by one role" was false as drafted: it was readable by every role.

**`ALTER DEFAULT PRIVILEGES` must be schema-less and `FOR ROLE finsoft_refresh`, inside the block.** The `IN SCHEMA auth_lookup` form records **zero rows** in `pg_default_acl` and the next function created still arrives with `proacl = NULL`, i.e. PUBLIC EXECUTE. The `IN SCHEMA` default is *added to* the built-in default; it cannot subtract the implicit PUBLIC grant. It was also issued as the wrong role — `FOR ROLE` defaults to the issuer, while every function here is created by `finsoft_refresh` under `SET ROLE`, so it covered only the case that never occurs. Measured working in the form above: `defaclacl = {finsoft_refresh=X/finsoft_refresh}`, and the next function arrives with PUBLIC absent. Schema-less scope is acceptable **because** the transient `CREATE` is revoked, so this role can create in no schema at all.

**The transient `GRANT USAGE, CREATE ON SCHEMA auth_lookup`.** Without it `CREATE FUNCTION` raises `permission denied for schema auth_lookup`: `CREATE SCHEMA` without `AUTHORIZATION` owns the schema to `finsoft_migration` and grants the new role nothing. An earlier draft's `REVOKE CREATE … FROM finsoft_refresh` was a no-op on a privilege never held — it read as a control and was decoration. `USAGE` is kept permanently, because without it the owner cannot name its own function in a later `GRANT`.

**THE TWO FORBIDDEN REPAIRS, named because the next person to hit that error will not read this record.** Faced with `permission denied for schema auth_lookup` on a block labelled normative, there are two tempting fixes and both are the failure this ADR exists to prevent:

1. **Drop `SET ROLE`** — the function is then owned by `finsoft_migration`, which has `BYPASSRLS`, and every statement in the body runs with unrestricted cross-tenant reach. This is the rejected design, reached silently.
2. **Add `AUTHORIZATION finsoft_refresh` to `CREATE SCHEMA`** — the definer's owner then holds permanent `CREATE` on the schema, contradicting the least-privilege end state.

The correct repair is the transient grant above. `ALTER FUNCTION … OWNER TO` is not a third way: it requires the new owner to hold `CREATE` on the schema too.

**`search_path = pg_catalog, pg_temp`**, with `public` **dropped** and every relation schema-qualified. Verified nothing breaks: the body resolves `public.refresh_tokens`, `text = text`, `uuid`, and `tenant_isolation`'s own `current_setting`/`::uuid` from `pg_catalog`. `pg_temp` is implicitly searched first for relations when unnamed, so naming it last is the only way to put it last.

**The column grant `(tenant_id, id, token_hash)` is minimal and all three are load-bearing.** `token_hash` is required *precisely because the function filters on it* — revoke it and the body raises `42501`; `id` is required because it is in the select list. Note the message reads *"permission denied for **table**"*, so a test matching on the word "column" will not fire.

**`STABLE`** is not a planning hint. Measured: `ERROR: 0A000: UPDATE is not allowed in a non-volatile function` — a mechanically enforced *"this resolver cannot write."* It is **not** what prevents inlining, and an earlier draft implied it was: PostgreSQL refuses to inline a `SECURITY DEFINER` SQL function regardless of volatility. Measured `EXPLAIN`: `Function Scan on auth_lookup.resolve_refresh`.

**`ROWS 1`**, because the default set-returning estimate is 1000 and the function returns at most one row by a unique index. Harmless standalone; wrong the first time anyone joins against it.

**`LEAKPROOF` must stay false**, so the body can never be pushed below an RLS qual. Superuser-only to change: a tripwire, not a likely accident.

**`USING (true)` IS LOAD-BEARING AS A CONSTANT, not merely as "permissive".** `tenant_isolation` on `refresh_tokens` has `polroles = {-}` — PUBLIC — so it applies to `finsoft_refresh` too, and its qual calls `current_setting('app.tenant_id')` with no `missing_ok` at a moment when the tenant is by definition unset. The mechanism works only because the two PERMISSIVE policies are OR'd and the constant `true` lets the planner fold the disjunction away entirely:

```
Index Scan using rt_token_hash_key on public.refresh_tokens t
  Index Cond: (t.token_hash = '…'::text)          -- no RLS qual at all
```

A narrower qual — even `USING (token_hash IS NOT NULL)` — was measured to work only by runtime OR short-circuit ordering, which is cost-based and not guaranteed. **Any future narrowing of that policy turns `/auth/refresh` into an intermittent `42704` in production.** The clean fix — scoping `tenant_isolation` `TO finsoft_app, readonly_support` — is unavailable, because migration 005 is released. So the allowlist asserts `polqual = 'true'` exactly.

**The resolver returns `(tenant_id, token_id)` and no state.** Not `used_at`, not `expires_at`, not the family's `revoked_at`.

> **The resolver decides *where*. The spend decides *whether*.**

There is a TOCTOU gap between resolving and spending, and it is **harmless because the spend re-evaluates everything atomically** — [ADR-0022](ADR-0022-no-grace-window-on-refresh-rotation.md)'s `UPDATE … WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, under the tenant context, under RLS, under the row lock, under the transition triggers. Stating the gap is what stops someone closing it by trusting the resolver's read, which is how it would become real.

**The spend statement additionally carries `AND tenant_id = $resolved AND id = $resolved_token_id`.** That is the repository layer of ADR-0009's four, and it converts a resolver bug from a wrong-row write into zero rows.

**The resolver touches one table and writes nothing.** If the spend were moved inside it, the role would need grants on `refresh_token_families` and `sessions`, and migration 005's whole trigger chain — the `FOR SHARE` reads, the revocation cascade, every finding from that review — would execute under a role whose policy set nobody has reasoned about.

### 3. One transaction shape, in one place — for BOTH pre-tenant paths

`packages/database` gains a third helper beside `withTenant` and `withGlobal`, because neither pre-tenant path fits the existing two: each must resolve and *then* set the tenant, **inside one transaction**, since `set_config(…, true)` is transaction-scoped and two pool checkouts are two connections.

**LOGIN USES THE SAME HELPER, with the `tenants`-by-code lookup as its resolver.** An earlier draft gave `/auth/refresh` four structural protections and login none — leaving the predictable implementation as `withGlobal` for the `tenants` read then `withTenant(resolvedId)` for the `users` read: two transactions, and a call site in a handler where a request field chooses a tenant. Every lint rule would have passed, and what would be in the codebase is the pattern *"handler reads a tenant from the body and hands it to the tenancy layer"* — on the authentication path, uncontained, which is the exact pattern the boundary paragraph above exists to stop from spreading. The asymmetry sat on the two endpoints that mint claims.

Sharing the helper also means the credential verification and the `last_login_at` write share one transaction with the tenant established once, which §1's claim about RLS being in force during verification requires and does not otherwise get.

**And the resolver's output is a branded `ResolvedTenantId` that `withResolvedTenant` demands.** *(As drafted this read "that `withTenant` demands". `withTenant` takes no tenant argument — it reads `TenantContext` (`packages/database/src/transaction.ts:92`) — and must not gain one; see the Architecture seat's condition A2.)* The lint rule confining `set_config('app.tenant_id'` to `packages/database` already permits `withTenant(anything)`, so a nominal type is what makes the only way to obtain one be a resolver — the global `tenants` read, or `resolve_refresh`. A `string` from a request body will not compile.

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

0. **THE ENVELOPE'S BOUNDARY, first, because both readings of "every path" are wrong.** *Every failure whose outcome depends on the existence, state or credential of an account is inside the envelope and produces the identical 401. Schema-level input validation (400) and limiter unavailability (503) are outside it, must not consult the database, and must not increment any account-keyed counter.* Without the boundary, a Zod DTO mirroring `tenants.code`'s CHECK makes §4 demand a 19 MiB argon2id on **every malformed request** — CPU and memory amplification on the endpoint an unauthenticated attacker paces. Without the last clause, malformed requests carrying a victim's email spend the victim's budget. And it resolves the collision between the identical-401 rule and §5's fail-closed 503.
1. **Exactly one** verification per request, on every path inside the envelope. Zero is an oracle; two or more is an oracle *and* a CPU amplification vector.
2. On a miss, and on any hit where `password_hash IS NULL`, the verification runs against a **decoy hash computed at process start** from a CSPRNG value **using the live parameter object** — the same object the real verifier uses. A decoy baked in with yesterday's parameters becomes an oracle the day the parameters are tuned. **One decoy per process, shared by every endpoint in item 6** — four independently initialised decoys reintroduce the parameter-drift oracle this item closes.
3. **Order: resolve → verify (always) → evaluate `users.status` → evaluate `tenants.status` → issue.** Never skip work on a lifecycle state.
4. **One response for every failure**: identical status, body bytes, error code and headers. Unknown tenant code, unknown email, wrong password, `INVITED`, `SUSPENDED`, `DISABLED`, **every non-`ACTIVE` tenant status including `CLOSED`**, throttled — all identical. *"Your account is locked"* is an enumeration oracle **and** confirms to an attacker that their denial-of-service landed.
5. **Counters increment identically on a miss and a hit**, or the rate limiter is the oracle: probe until throttled, compare against a control.
6. **This binds every account-bearing endpoint**, not only login: invite acceptance, password-reset request, MFA challenge, email-change confirmation. A constant-time login beside a reset endpoint that says *"no such user"* buys nothing.
7. **Accepted and stated rather than engineered away:** a login failure against an unknown tenant code or unknown email **cannot be audited**, only logged, because `audit_log` is tenant-owned and rule 7 forbids a tenantless row. Someone will propose a tenantless audit row to close that gap. The answer is no, recorded here in advance.

### 5. Throttling and lockout are different things

ADR-0009:121 and :123 describe a sticky per-user lockout triggered by an attacker-chosen key. **Anyone who knows an employee's email address can make that employee unable to work** — possibly the only holder of `period.close` on the last day of a month. That is a business-impacting attack with a one-line exploit, and it is superseded here.

**Throttling** is keyed on attacker-controllable input, always time-decaying, always self-recovering, and **never requires administrator action**. All layers are evaluated on every request; the request is rejected if **any** is exhausted.

| Layer | Key | Character |
|---|---|---|
| 0 | **normalised email alone**, code-independent | the only bound on per-email volume. **Escalates to layer 5's proof-of-work, never to rejection** — a hard email-only throttle would re-create the named-user DoS this section removes |
| 1 | normalised email + normalised tenant code | **throttle only, never a sticky lock** — the key is attacker-chosen |
| 2 | IP prefix — **/32 v4, /64 v6** | higher volume, faster window |
| 3 | (IP prefix, email) | tightest and cheapest |
| 4 | global failed-logins per minute for the endpoint | **alert and global slowdown, never a hard block** — a global block is self-DoS and is the attacker's actual goal |
| 5 | escalation on layers **0 and 1** | proof-of-work or CAPTCHA after N failures: **the attacker pays, the victim does not** |

- **`X-Forwarded-For`: take the Nth-from-the-right entry for a configured N.** Never the leftmost, never a framework's `req.ip` default. Leftmost parsing gives an attacker an unbounded key space *and* the ability to spend a victim's budget by spoofing their address — a worse primitive than the bypass.
- **The limiter fails closed.** If Redis is unreachable, `/auth/login` and `/auth/refresh` return 503. A limiter that fails open is one an attacker removes by attacking Redis first.
- **Normalise the email exactly as the lookup does**, or `Victim@x.com` and `victim@x.com` are two budgets for one account. **And normalise the tenant code the same way** — `tenants.code` is uppercase-only by CHECK, so upper-casing the input is both normalisation and validation. Without it, `acme`/`Acme`/`aCme` are 2ⁿ distinct budgets for one `(email, tenant)` pair: a 16× amplification on a four-character code, 65 536× on a sixteen-character one, defeating layers 0, 1 and 3 at once. This is the `Victim@x.com` bug on the field the narrowing added.
- **`/auth/refresh` has no email, so it gets its own keys: the IP prefix and the presented token's hash. That key is never logged** — it is a bare 64-hex digest, and §6 establishes that redaction denies by key *name* and so cannot catch one inside a value like `{ limiterKey: 'rt:ab12…' }`. Covered by the same `log-leak` assertion §6 requires. Keying on the **resolved** tenant is forbidden — it is available only *after* the resolver has run, so the cross-tenant read would be reachable at whatever rate layer 2 permits, and it would let one valid token for a tenant exhaust that tenant's whole refresh budget. **The limiter is evaluated before `withResolvedTenant` invokes the resolver**, so a Redis outage means the resolver is never called. That discharges D-W1-004's third condition, which an earlier draft left to a login-shaped table that has no email to key on.

**Lockout** — a sticky state needing an unlock — may only be keyed on something an attacker cannot choose *on someone else's behalf*. The defensible key is **(user, device/IP)**, never (user): it stops the attacker's source and leaves the victim's own device working.

**Lockout state cannot live in Redis, and this record does not place it.** Having defined lockout as *"a sticky state needing an unlock"*, a store that is flushed is not sticky. Lockout is therefore **out of scope for W1-002**: its table arrives with RBAC, it is tenant-owned, and its unlock writes an audit record under rule 9. Stated here so that an implementer reading the next paragraph does not put lockout in Redis and collapse the distinction this section just drew.

**Throttle state lives in Redis, not on `users`.** On `users` it would need `locked_until` and `failed_attempt_count` in a pre-tenant column grant, widening the read and putting a mutable counter behind a permissive policy. The cost is that throttle state is lost on a Redis flush — accepted, because a throttle is not an audit record and the durable record is the business event written after the tenant is known.

### 6. What a database error may become

- On `/auth/login` and `/auth/refresh`, a driver error is caught at the boundary and rethrown carrying **only a code**. No `detail`, `hint`, `where`, `internalQuery`, `internalPosition`, `schema`, `table` or `constraint` is logged or serialised. **Existing redaction does not cover this**: it denies object *keys* by substring, and a bare 64-hex digest inside a free-text `detail` string matches no rule.
- A `23505` on `rt_token_hash_key` is reachable on the **insert**, never on the presentation `SELECT`. It is a ~2⁻¹²² event or a broken minter. It is **a generic 500 plus a Sev-2 alert with the hash absent from the payload**, and an investigation. **It must never be handled by retrying with a fresh value and succeeding silently** — that converts a broken-minter alarm into normal operation.
- **A test that makes the redaction claim enforceable**, since none existed: a synthetic driver error carrying a 64-hex digest in its `detail` produces no log line containing it. `tests/integration/log-leak.spec.ts`.
- **ADR-0021's production-minter test becomes this record's gate too**, not an inherited one. ADR-0021 says its `rt_token_hash_key` allowlist entry *"is invalid until that test exists"*, and this ADR is what makes the pre-tenant lookup live in front of it.

## Consequences

### Positive

- One cross-tenant read, on one table, holding digests of random values. Not password hashes.
- The tenant that issues a claim is established under RLS on both paths.
- Exactly one candidate row on login makes constant-time behaviour reachable.
- The throttle/lockout split removes a named-user denial of service that ADR-0009 would have required building.

### Negative, and accepted

- **`refresh_tokens` is readable across tenants by one role.** ADR-0004's backstop does not apply on that path; isolation rests on the column grant, the function body and role-membership containment. This is the same shape of admission ADR-0021 made for one index, and it is recorded with the same candour.
- **The role's `NOLOGIN` and `NOBYPASSRLS` are protected by NOTHING but a catalogue assertion.** They live in `00-bootstrap.sh`, an un-checksummed shell script outside the migration chain — so the immutability argument below covers the function body and not the attributes that make the owner safe to be a definer. Stated in the residual register rather than only in §2, because this list should be readable on its own.
- **The function body is protected by migration immutability, not by a mechanism.** Nothing outside a migration can `SET ROLE finsoft_refresh`, but a future *numbered* migration can widen the body or the grant, and only review catches it. A review gate, honestly labelled — the same class as ADR-0021 condition 5.
- **Tenant enumeration through the code field**, bounded by §4's identical response and by layers 2 and 4 — **not** by the code's presence in the rate-limit key, which partitions the budget by code and therefore *helps* enumeration. An earlier version of this bullet said the opposite, and it survived the revision that corrected the same claim in §1: the record contradicted itself in its **residual-risk register**, which is the section a reviewer reads to learn what was accepted and an auditor reads first.
- **A resolver miss cannot be audited**, only logged.
- **`LOGIN_FAILED` log lines carry the normalised email AND the normalised tenant code**, and nothing else from the request body, because those are §5's layer-1 key. Email alone is an address; email plus tenant code **names an identified person at an identified company** and makes per-company failed-login volume readable in a store shared across tenants. That is materially larger than "email appears in logs", and *"decided here rather than discovered in the aggregator"* is only true if this record describes what actually arrives there. Authentication log lines inherit the platform retention policy. A keyed digest was rejected: it preserves the operational use — correlating one account's failures — at the cost of the operator computing it, and on-call legibility during an incident wins.

## Alternatives considered

**One resolver for both paths, keyed on email.** Rejected — see Context. The N > 1 problem has no safe disposal and the policy would sit on the password-hash table.

**A resolver owned by `finsoft_migration`.** Rejected: that role has `BYPASSRLS`, so every statement in the body runs with unrestricted reach and a bug in the body is a full cross-tenant read. This is also what the first draft would have built by accident.

**A global `token_directory(token_hash → tenant_id)` table.** Rejected by the Architecture Guardian at W1-001: it puts a credential-derived value on an unprotected table readable before authentication — a worse blast radius than the index it avoids — and creates a two-table consistency obligation on the authentication path.

**Verifying the password inside the database.** Rejected, and the decisive reason is not the usual one: it requires the **raw password** to cross into the database, where it reaches `log_min_duration_statement` output on any slow login, `log_statement` if it is ever turned up during an incident, and any error log for a failed statement. A plaintext password in a database log is a breach; a hash in the API's heap is a secret. Also: pgcrypto has no argon2; parameters must be rotatable with rehash-on-login, which ADR-0009 puts in the application; and argon2id at 19 MiB per login inside the database process consumes the least horizontally scalable resource in the system, on the one endpoint whose rate an unauthenticated attacker controls.

**A per-tenant subdomain instead of a form field.** Rejected — publishes every tenant code through DNS, TLS SNI and Certificate Transparency.

**Keeping ADR-0009's per-user lockout.** Rejected as a named-user denial of service available to anyone who knows an email address.

## Compliance

**The primary gate, and the single most valuable assertion in this record:**

**The gate is real — measured both arms.** The correct variant raises with the policy dropped; the `finsoft_migration`-owned twin returns rows in both states. That is the discrimination, and nothing else in this record discriminates. But it must be written as a **paired assertion**, because an earlier draft's wording (*"must FAIL … if it still returns rows"*) can pass while proving nothing:

- **Positive arm.** Policy present, `app.tenant_id` **unset**, a **seeded** hash: exactly one row, and its `tenant_id` equals the seeding tenant's. Without the seed the negative arm is satisfiable by a typo — `repeat('a',64)` is a hash in no tenant, and it passes.
- **Negative arm.** Same call, `refresh_lookup` dropped in the same transaction: raises **`42704`** — `unrecognized configuration parameter "app.tenant_id"`. Assert the SQLSTATE, not "throws". **The raise does not come from RLS denial** (that returns zero rows silently); it comes from `tenant_isolation`'s `current_setting` once the permissive policy is gone.
- **`app.tenant_id` MUST BE UNSET, in those words.** Measured: with a tenant set and the policy dropped, the resolver returns **that tenant's row** and the gate passes as a success. A harness that sets a tenant — which every other suite does — silently disarms the single most valuable assertion in this record.
- **The companion arm that survives harness drift.** Tenant A set, policy dropped, resolve **tenant B's** hash → zero rows, while the BYPASSRLS twin returns one. Same discrimination without depending on an unset GUC.
- **Also assert `tenant_isolation` on `refresh_tokens` applies to PUBLIC** (`polroles = {-}`), since that is what converts the gate from silence into a raise.

The shape that actually runs on one connection and still rolls back — `finsoft_migration` cannot `SET ROLE finsoft_app`, and once the grants are correct it cannot execute the function either, which is the right end state:

```sql
BEGIN;
  SET ROLE finsoft_refresh;
  GRANT EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_migration;
  RESET ROLE;
  DROP POLICY refresh_lookup ON refresh_tokens;      -- AccessExclusiveLock; serialises
  SELECT count(*) FROM auth_lookup.resolve_refresh($1);   -- must raise 42704
ROLLBACK;
```

Keep the BYPASSRLS-owned control arm inside the rolled-back transaction, or the per-class `prosecdef` assertion starts failing on the suite's own fixture.

- **Assert the resulting ACLs, never the presence of a statement.** `proacl` exactly `{finsoft_refresh=X/finsoft_refresh,finsoft_app=X/finsoft_refresh}`; `has_function_privilege('public', …, 'EXECUTE')` and `('readonly_support', …)` false for **every** `prosecdef` function. This is the lesson of the two no-op statements above: the statement ran and did nothing. **And `has_function_privilege` alone would have misled in both directions here** — it returned true for `readonly_support` against the broken state while the role could not actually reach the function, because it ignores schema `USAGE`. Assert the catalogue, as an exact set.
- **A defect-injected belt test:** create a throwaway second `SECURITY DEFINER` function in `auth_lookup` and assert PUBLIC holds no `EXECUTE`. If it passes, the default-privileges line works; if it fails, that line is prose. This is how the `IN SCHEMA` form was caught.
- `SET ROLE finsoft_refresh; SELECT expires_at FROM refresh_tokens;` raises `42501`.

**Catalogue assertions, written over the class and not over this one function:**

- For **every** `prosecdef = true` function: the owner is in an explicit allowlist, that owner's `rolbypassrls` is `false`, **the owner is `NOLOGIN`**, `provolatile = 's'`, `proleakproof = false`, and `proconfig` carries a `search_path`. Over the class, so the next one added inherits it — and `NOLOGIN` over the class, because otherwise the next definer owner may be a login role.
- **`pg_auth_members` exact match, INCLUDING THE OPTIONS**: `finsoft_refresh` has exactly one member, `finsoft_migration`, with `inherit_option = false`, `set_option = true`, `admin_option = false`. Asserting only the member list leaves §2's security claim about `INHERIT FALSE` untested — and a re-grant with `INHERIT TRUE` would keep the member set identical while handing `finsoft_migration` passive cross-tenant reach **and silently changing what the migration's own `GRANT`s do.**
- **That assertion is evidence only on a cluster initialised by `00-bootstrap.sh` in the same run.** CI initialises a fresh volume; a role's presence in a long-lived developer cluster is **not** evidence that the bootstrap creates it, and once the bootstrap is amended the two causes become indistinguishable forever on any persisted volume. It also runs against `finsoft_test` only, so **dev-cluster drift stays invisible** — accepted explicitly rather than assumed away.
- **The role SET itself is an exact match**: the non-superuser, non-`pg_%` roles are exactly `{finsoft_app, finsoft_migration, readonly_support, finsoft_refresh}`, **so a hand-created role fails CI.** During this review `finsoft_refresh` was found already present in the local test cluster, created by hand during a measurement session and absent from `00-bootstrap.sh` — so every role assertion here would have gone green because someone typed it, not because anything provisioned it. Third instance of the same hygiene failure in this wave.
- **Superusers are excluded from every `pg_has_role` assertion.** `pg_has_role('finsoft_bootstrap','finsoft_refresh','USAGE')` is **true** — superusers hold every role — so the naive form fails on a correct cluster. `roles.spec.ts` documents this trap in its own header. `pg_has_role('finsoft_app','finsoft_refresh','USAGE')` and `('MEMBER')` are false; likewise `readonly_support`. **A list that can grow is not a control** — one `GRANT finsoft_refresh TO finsoft_app` would otherwise let the API role `SET ROLE` and read every tenant's tokens.
- For every non-superuser role, memberships asserted against an exact allowlist. Role membership is a privilege-escalation surface this repository does not currently test at all.
- `finsoft_refresh` is `NOLOGIN` and holds no `CONNECT` on the database.
- `finsoft_refresh` holds no `INSERT`, `UPDATE` or `DELETE` on any table — exact match, not the absence of a `GRANT`.
- `has_database_privilege('finsoft_app', current_database(), 'TEMPORARY')` is false.
- `public.users` and `public.refresh_tokens` are `relkind = 'r'`. **A view without `security_invoker = true` executes as the view owner** — `finsoft_migration`, with `BYPASSRLS` — and `columns()` in `database/tests/catalog.ts` filters `relkind = 'r'` — which is what derives the tenant-owned set — so a view over a tenant-owned table is invisible to the RLS, schema and roles suites alike. (`policies()`, `indexes()` and `constraints()` do not filter on relkind; the substance holds through `columns()`.) That gap predates this ADR; this ADR makes it a login-path gap.

**`PRE_TENANT_POLICY_ALLOWLIST` in `database/tests/rls.spec.ts`.** A `FOR SELECT … USING (true)` policy breaks three of its assertions: that every policy has a non-null `WITH CHECK`, that both clauses are the same `current_setting` comparison *"and nothing else"*, and that every policy applies to `ALL`. **The tempting fix — relaxing those assertions — would let any future `USING (true)` policy on any tenant-owned table pass CI silently.** That is ADR-0021's own complaint about a LEVEL 1 rule whose carve-out lives in a LEVEL 3 artefact, repeated on the policy gate instead of the index gate.

So: an exact-match allowlist modelled on `GLOBALLY_UNIQUE_INDEX_ALLOWLIST`, carrying per entry the table, policy, role, command, **exact column set**, ADR and reason — with assertions that the policy is `FOR SELECT` only, `polroles` is exactly the one named role, that role is not `BYPASSRLS`, its column-level `SELECT` privileges are an **exact set match**, and the entry names a policy that exists so a stale exemption fails rather than lingers. **Every policy not in the allowlist keeps all three assertions at full strength.** The exact-column assertion is the one that pays for itself: without it, one plausible-looking `GRANT SELECT ON refresh_tokens TO finsoft_refresh` silently widens the cross-tenant read to every column a future migration adds.

**Behavioural tests:**

- **D-W1-004's re-proof obligation.** `cannot spend another tenant's token by presenting its hash` currently derives its entire guarantee from RLS being in force on the by-hash lookup — which is exactly what this ADR removes. It must be re-proved **through this mechanism**, or it silently stops testing anything at the moment it starts to matter.
- Identical response bytes across: unknown tenant code, unknown email, wrong password, `INVITED`, `SUSPENDED`, `DISABLED`, **every non-`ACTIVE` tenant status including `CLOSED`**, throttled.
- Exactly one argon2id invocation per login request on each of those paths — asserted by counting invocations, not by timing.
- A login or refresh request carrying `tenantId` / `tenant_id` / `X-Tenant-Id` in body, query, header or a second cookie produces a byte-identical response and an identical `tenant_id` claim. **ADR-0009:160's existing version of this test runs against *guarded* endpoints; these two have no guard, and they are where the claim is minted.**
- The JWT payload's `tenant_id` is assigned from the resolver's or the global-`tenants` read's return value at exactly one site.
- The limiter fails closed: with Redis unreachable, both endpoints return 503.

**ADR-0021's production-minter gate, restated rather than cross-referenced.** A pointer in prose is what "inherited" means. ADR-0021 imposes two obligations and both are this record's: a test over the **production** minter for `refresh_tokens.token_hash` — full-length, from a CSPRNG, no truncation, no derivation from caller-influenced input, and **no fixture standing in for the production code path** — and that the `GLOBALLY_UNIQUE_INDEX_ALLOWLIST` entry's own text say it is **invalid until that test exists**. `schema.spec.ts` says no such thing today.

**`finsoft_refresh`'s ENTIRE privilege set is an exact match**, not merely "no `INSERT`/`UPDATE`/`DELETE`". Nothing in the draft forbade it holding `SELECT` on `users`. So: `SELECT` on `refresh_tokens(tenant_id, id, token_hash)` and **no privilege of any kind on any other relation**, no `EXECUTE` on any function, and no schema privilege but the permanent `USAGE` on `public` and `auth_lookup`. It is clean today — the bootstrap's default privileges name only `finsoft_app` and `readonly_support` — and the assertion is what keeps it clean when migration 011 writes a convenient `GRANT`.

**`catalog.ts` needs two additions before any of the allowlist assertions can run:**

- `policies()` does not select `polroles`, so the "exactly one named role" assertion has no data source. `PolicyRow` needs `p.polroles::regrole[]::text[]`.
- **There is no column-privilege query at all**, so the exact-column-set assertion — the one that pays for itself — has nothing to read. And it must not use `information_schema.column_privileges`: `catalog.ts`'s own header forbids `information_schema` because its views are privilege-filtered, and that is exactly such a view. Use `pg_attribute.attacl` via `aclexplode`.
- Assert `polqual = 'true'` exactly (a correctness property, per §2's constant-folding note) and `polwithcheck IS NULL` positively — `FOR SELECT` cannot carry one, so it costs nothing and stops the entry being reused for a `FOR ALL` policy later.
- Assert the **allowlist's own length and contents**. Its own rule — *a list that can grow is not a control* — applies to itself.
- **The non-system schema set is exactly `{public, auth_lookup}`**, `auth_lookup` holds **zero relations of any relkind** and exactly one function. `finsoft_migration` retains `CREATE` on `auth_lookup`, so a later migration could put a tenant-owned table there and it would escape the schema, RLS, roles and numeric suites simultaneously — every query in `catalog.ts` filters `nspname = 'public'`. This record creates that hole, so this record closes it.

**Other required assertions:** `auth_lookup` is added to `database/tests/catalog.ts`'s queries, or asserted to contain zero relations of any relkind; `roles.spec.ts`'s hardcoded grantee lists are derived from `pg_roles` — **with the derivation specified, because the naive form fails on day one**: every role not matching `pg\_%`, excluding superusers **and excluding the table owner `finsoft_migration`**, with that exclusion set itself asserted as an exact match. Measured: `has_table_privilege('finsoft_migration','refresh_tokens','DELETE')` is true, because the owner holds DELETE implicitly, so an unspecified derivation turns the rule-4 assertion red immediately and the implementer relaxes it rather than specifying the exclusion. `finsoft_refresh` measured `DELETE = false`, so it passes on the merits once the loop can see it; `log_parameter_max_length = 0` on staging and production, asserted beside the existing `statement_timeout` assertions.

## Open — requires a decision outside this record, and each one GATES something

**Every item here names an artefact that may not ship until the decision is recorded.** Without a gate, *"requires a decision outside this record"* reads to an implementer at 6pm as *"optional"* — which is exactly how the cookie prefix gets picked by default.

*(`INFRASTRUCTURE` §5 is **no longer Open** — it is a blocking condition. `CREATE ROLE` cannot run in a migration, so the role must exist in every environment **before** migration 006 runs: the production role inventory, the provisioning path and the runbook are amended **before 006 merges**, not after, with LEVEL 2 approval as the gate.)*
- ~~**GATE**~~ **DECIDED 2026-09-27 — gate lifted; see the cookie-prefix addendum under Signatures (staging `__Host-` + `Path=/`, production `__Secure-` + `Path=/api/auth`). Original text as accepted:** **GATE: `/auth/login` emits no `Set-Cookie` until this is recorded.** Decider: Architecture Guardian plus whoever owns the domain layout. **The cookie prefix.** `__Host-` forbids `Domain` and forces `Path=/`, contradicting ADR-0009:28's scoped path (as-accepted); `__Secure-` is compatible with it. Recommended: `__Secure-` plus the scoped path, because limiting which requests carry the credential is the larger win — **unless** the app shares a registrable domain with anything else, where `__Host-`'s anti-subdomain-shadowing property wins. Left unstated, an implementer picks one and is wrong half the time.
- **GATE: `/auth/mfa` does not ship until this is decided** — the default an implementer reaches for, a full session before MFA, is a security failure rather than a style choice. Decider: Security Guardian. **The pre-MFA token.** A login that passes the password but not MFA must not mint a refresh token, but the MFA secret is on a tenant-owned table. Recommended: a ≤2-minute, single-purpose, signed pre-authentication token carrying the resolved `tenant_id` and a distinct `typ`/`aud`, accepted at `/auth/mfa` and **rejected by the global guard everywhere else including `/auth/refresh`**, carrying no `session_id` and no permission claims. Without this, an implementer either re-runs a pre-tenant read at the MFA step or issues a full session before MFA.
- **A login page does not exist** in `docs/design-system/pages/`, and the PRD does not scope multi-tenant users. The tenant-code field is a product requirement, recorded by the Product Owner rather than decided by implication here.

## Related

- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — :77, the rule this record carves the one exception to
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — :48 login resolves the tenant, :62 multi-tenant users, :151 the per-request `tenant_id` this must not become; **superseded in part on lockout**
- [ADR-0021](ADR-0021-globally-unique-indexes-on-tenant-owned-tables.md) — why `rt_token_hash_key` is globally unique, and the production-minter gate this record inherits
- [ADR-0022](ADR-0022-no-grace-window-on-refresh-rotation.md) — the atomic spend that decides *whether*, after this record decides *where*
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md), [ADR-0016](ADR-0016-structured-logging-and-observability-package.md) — tenancy, and what may never be logged
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rule 7 (tenant on every row), rule 8 (no cross-tenant write), rule 9 (audit)
- TD-005, `users` table-level `UPDATE`, which login's `last_login_at` write makes live — recorded in [../WAVE_1_REGISTER.md](../WAVE_1_REGISTER.md), moving to `docs/TECH_DEBT.md` when W1-000 merges, which is the branch that creates it. **Deliberately not linked to that file: it does not exist on this branch, and a LEVEL 1 record must not ship a dead reference to its own evidence.**

## Signatures

| | |
|---|---|
| **Security Guardian** | ✅ **SIGNED, 2026-09-27** — approved with conditions; all six landed |
| **Database Guardian** | ✅ **SIGNED, 2026-09-27** — §2 re-run verbatim from the record's bytes |
| **Architecture Guardian** | ✅ **APPROVED WITH CONDITIONS, 2026-09-27** — Architecture seat, Technical Council (ADR-0024). Conditions A1–A5 below |
| **Product Owner** | ~~☐ not recorded~~ — **slot withdrawn by ADR-0024 (2026-09-27)**. Not a signature. The Product Owner's decisions of 2026-09-25 — §1's tenant field and §5's throttle/lockout split — stand as recorded decisions |

> **Security Guardian — 2026-09-27.** Design and controls verified by measurement on a bootstrapped cluster: §2's block runs, `proacl` exact, PUBLIC and `readonly_support` excluded, the default-privileges belt works **under defect injection**, and the primary gate discriminates even when run from the `BYPASSRLS` connection — the caller's bypass does not propagate into the definer's context, so the arm that would have silently passed does not exist.

> **Database Guardian — 2026-09-27.** §2's two SQL blocks extracted with `awk` rather than retyped, so what ran was the record's bytes. Guard aborts before any DDL when the role is absent; 006 then runs 15 statements at `ON_ERROR_STOP=1` with **exit 0 and zero `WARNING` lines** — which is the whole difference from the draft, where two statements reported success and did nothing. Nine end-state properties verified, and the gate discriminates on all three arms against the `BYPASSRLS` twin.

**What the Database Guardian explicitly did NOT sign**, recorded because the distinction is the point: `catalog.ts`'s two additions, `PRE_TENANT_POLICY_ALLOWLIST`, and every catalogue assertion in Compliance — **none of which exists yet.** This commit changes no schema and no test, *"which is why 102/102 is unsurprising rather than reassuring."* Migrations 006 and 007 are reviewed as code, **with their assertions in the same PR as the DDL they guard, not behind it** — the `proacl` assertion is the one that would have caught the draft's silent no-op.

> **Architecture seat — 2026-09-27.** Reviewed for module boundaries, dependency direction, interface placement and the ADR record — not for the SQL, which the Database/Security seat measured and owns. The decision is sound: one cross-tenant read on one digest table, no cross-tenant policy on `users`, and the tenant that mints a claim established under RLS on both paths. The boundary paragraph in §1 is the right line — a tenant code at the login form is an input to one unauthenticated endpoint that **mints** a claim, never to an endpoint that **consumes** one — and A2–A3 make it mechanical rather than prose. Two record corrections made at signature, neither changing a decision: the **Carves out of** line (ADR-0004:75 was contradicted by both paths and never named), and §3's brand target (`withTenant` takes no tenant argument). Approved on five conditions; A1–A3 bind the `packages/auth` / `packages/database` PRs, A4–A5 are owed by this seat.
>
> - **A1 · Placement.** `withResolvedTenant`, `ResolvedTenantId` and **both resolver bodies** — the `tenants`-by-code read and the call to `auth_lookup.resolve_refresh` — live in `packages/database`, as ARCHITECTURE §6 already says. Its public index exports resolver **factories** (one per path) and `withResolvedTenant`, and never the brand's constructor or symbol. `packages/auth` owns credential verification, token minting, throttling and the tenant-scoped reads that run *inside* the callback's `TenantTx`; it holds no resolver body and never names `auth_lookup` or `set_config`. Direction: `packages/auth → packages/database`, never back (`no-circular`); `apps/web` never reaches `packages/auth` (`web-is-ui-only`, already in force). **Enforced by** a lint rule confining the identifier `auth_lookup` to `packages/database/src/**` and `database/migrations/**`, beside ADR-0004 rule 3's `set_config` rule.
> - **A2 · The brand is unforgeable, and `withTenant` does not change.** `ResolvedTenantId` follows the `TenantTx` pattern (`transaction.ts:18-23`): a module-private symbol **plus a runtime registry** checked by `withResolvedTenant`, because a string intersection is forgeable with `as`. `withTenant` keeps its argument-free signature and keeps reading `TenantContext`; a tenant parameter on the universal helper is exactly the per-request door ADR-0009:151 closed. `withResolvedTenant` is the only caller of `TenantContext.run` outside the global auth guard, tenant provisioning and the job runner (ADR-0004 rule 5), if it needs one at all. **Enforced by** a type test that `withResolvedTenant(() => 'uuid-string', …)` does not compile, and a unit test that a forged brand is refused at runtime.
> - **A3 · `tenantCode` is a login-form field and nothing else.** ADR-0009's Compliance rule (no request DTO may declare `tenantId`) gets **no exemption**. It is extended: `tenantCode` may be declared by the `/auth/login` request schema **only**, and by no other request schema, query schema or queue payload. `/auth/refresh` declares neither. **Enforced by** the same lint/type rule as ADR-0009 :158, with the login schema as its single named allowance and a test that the allowance list has length one.
> - **A4 · The ADR-0013 query-construction allowlist does not include `packages/auth`** (ADR-0013:31, `kysely-is-allowlisted`), and ADR-0013:37 makes calling `selectFrom` on a received `TenantTx` query construction. So the tenant-scoped `users` read, the ADR-0022 spend and the `sessions` insert have no legal home today, and `packages/permissions` (M1-R) has the same gap. **Not a defect in this record** — it predates it — but it blocks the first query in M1-A. This seat's ruling: extend the allowlist to `packages/auth` and `packages/permissions` by a short superseding ADR (both own their tables the way the kernels own the journal), rather than growing `packages/database` into a domain package. Owner: Architecture seat; due 2026-09-29; tracked on [BOARD.md](../BOARD.md). **Until it is Accepted, no `packages/auth` code that constructs a query merges**, and the workaround of moving auth repositories into `packages/database` beyond what A1 names is not permitted.
> - **A5 · The superseded and carved-out records must say so at their heads.** ADR-0009's permanent scope notice names only ADR-0022; it must also name this record's lockout supersession at as-accepted :121 and :123, **preserving its 24-line count** (README §4). ADR-0004 needs a permanent notice naming the :75 / :77 carve-out and its line offset. Owner: Architecture seat; **before `packages/auth` merges**. Not done in this commit: M1-000's brief excludes other Accepted ADR files, and the ADR-0004 notice needs an offset convention decided with care rather than at speed. The [index](README.md) rows for 0004 and 0009 point here meanwhile.
>
> The cookie-prefix gate in *Open* is this seat's jointly with `devops-guardian`, and is recorded on the board rather than decided here — see [BOARD.md](../BOARD.md).

> **Architecture seat — addendum, 2026-09-27 (same day).** The conditions above are kept as signed. This addendum records how two of them closed, and one change to A1.
>
> - **A1 is widened, and A4 is WITHDRAWN.** Every query body for auth and RBAC lives in `packages/database`, as named exports with no business rule in them. For auth that means the `tenants`-by-code resolver, the tenant-scoped `users` read, the ADR-0022 spend, the `sessions` insert and the `last_login_at` write. For RBAC it means permission resolution and system-role seeding. `packages/auth` and `packages/permissions` call those exports and build no query. Their logic stays with them: argon2id, token minting, throttling and permission evaluation. The sentence in A1 giving `packages/auth` *"the tenant-scoped reads that run inside the callback's `TenantTx`"* no longer holds. ADR-0013:31 already permits query construction in `packages/database`, so **no allowlist extension and no ADR-0025 are needed**. ADR-0013:33's objection was to forcing *every* ERP query into one package. That does not apply to the platform tables that `database/migrations/` already creates.
>   - **No business rule in `packages/database`.** Its auth and RBAC exports take parameters and return rows or ids. They do not verify a credential, mint a token, evaluate a permission or decide a lifecycle transition. System-role seeding receives the catalogue as an argument, because the catalogue's single source of truth is `packages/permissions` (ARCHITECTURE §8). `packages/database` imports neither package; `no-circular` already fails that edge.
>   - **The enforcement gap, and who closes it.** `kysely-is-allowlisted` keeps both packages from importing Kysely. A `TenantTx` still arrives through a callback, though, and ADR-0013:37 is enforced only by the `appsQuerySyntax` lint rule scoped to `apps/**`. So `tx.selectFrom(…)` inside `packages/auth` would pass every check today. **The first code PR in M1-A and in M1-R extends that rule's `files` to `packages/auth/**` and `packages/permissions/**`**, with a case in `tests/security/lint-boundaries.spec.ts`. This is a merge condition on those PRs, not a note.
> - **A5 is DELIVERED.** Permanent head notices were added to [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) and [ADR-0004](ADR-0004-postgresql-row-level-security.md) under README §4. ADR-0009's notice now names both supersessions and keeps its 24 lines and its +24 offset. ADR-0004's notice is new and states its own offset.

> **Architecture seat — addendum, 2026-09-27: the cookie prefix is DECIDED, and the *Open* gate is lifted.** Deciders: Architecture seat and `devops-guardian` (owner of the domain layout), as *Open* names them; the Security seat concurring. The decision applies this record's own rule in *Open* — `__Secure-` with the scoped path by default, `__Host-` where the app shares a registrable domain with anything else. It changes no decision, rationale or consequence above.
>
> - **Staging: `__Host-finsoft_rt`, `Path=/`.** The host is `31-220-74-159.sslip.io`. `sslip.io` is **not** on the Public Suffix List (verified by the Security seat), so every sslip.io host on the internet shares the registrable domain and can set a `Domain=sslip.io` cookie that shadows ours. That is the exception case, and `__Host-`'s anti-shadowing property wins. **Accepted cost:** the refresh cookie is sent to every same-origin path, not only `/api/auth`. It is bounded by `Secure`, `HttpOnly` and `SameSite=Strict`, and two rules hold with it: `apps/web` never reads or logs the cookie, and Caddy's `log_credentials` stays off.
> - **Production: `__Secure-finsoft_rt`, `Path=/api/auth`** — **provided** no untrusted host shares the production registrable domain. If one does, production uses `__Host-` and `Path=/` as staging does. `devops-guardian` confirms which case holds when the production domain is chosen. That is recorded then; it is not inherited from staging.
> - **Mechanism** (branch `feature/M1-A-auth`): `AUTH_REFRESH_COOKIE_NAME` and `AUTH_REFRESH_COOKIE_PATH` configure the cookie. `apps/api/src/auth/cookie.ts` refuses a `__Host-` name with any path other than `/`, and `assertProductionCookieSecurity()` refuses to boot with `NODE_ENV=production` and a name carrying neither prefix. The staging values are in `infrastructure/staging/compose.yaml`. The code cannot tell which prefix a production domain needs; the `devops-guardian` confirmation above is the control for that.
>
> The note above that this gate is *"recorded on the board rather than decided here"* was true when signed. The decision is now recorded here, and on [BOARD.md](../BOARD.md) under *Decided*.

### The measurement rule, in its operational form

Both guardians and this author produced instances of the same failure in one wave: a privilege or role measured outside the bootstrap, or a statement trusted because it reported success. The Database Guardian supplied the form that prevents both, and owned their own instance of it — the hand-created role found in the test cluster was theirs, from round one, and `CREATE ROLE` is **cluster**-scoped, so it was visible from every database regardless of which clone it was used in:

> **Measure inside a transaction that rolls back.** Role DDL is transactional — measured: `BEGIN; CREATE ROLE probe …; ROLLBACK;` leaves nothing. **Where a rollback is impossible, assert the cluster inventory before AND after.** Asserting only afterwards is how a transient becomes observable to someone else's review.

Together with the two rules in the Wave 1 register — a privilege measured outside the bootstrap is not measured, and a privilege statement's success is not evidence it did anything — that is the whole of what this wave learned about measuring privileges.

---

Migrations 006 **and 007** and `packages/auth` do not merge before all four — *three seats after ADR-0024 withdrew the Product Owner slot; all three guardians signed 2026-09-27, and the Architecture seat's A1–A5 now bind the merge* — and **`/auth/login` does not ship before 007.** An earlier version named only 006, which permitted login to ship reading `tenants.code` and `tenants.status` while `finsoft_app` still held table-level `UPDATE` on both: H-9's exploitation path, live, in a state this record allowed.
