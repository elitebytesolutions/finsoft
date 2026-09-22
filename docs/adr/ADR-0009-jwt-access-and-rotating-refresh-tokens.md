# ADR-0009: Short-lived JWT access tokens with rotating refresh tokens

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

The session mechanism determines two things that the rest of the system depends on absolutely: *who* is acting, and *which tenant* they are acting in. The second is the input to [ADR-0004](ADR-0004-postgresql-row-level-security.md) — `app.tenant_id` is set from the session, and every RLS policy in the database compares against it. If the session's tenant can be influenced by an attacker, RLS enforces the wrong tenant perfectly and the entire isolation model collapses in silence.

The system is used by cashiers and storekeepers who stay logged in through a shift, by accountants on shared office machines, and by an owner who can approve credit-limit overrides. Sessions must be long-lived in experience and short-lived in credential, and an administrator must be able to end one immediately when a device is lost or a user is removed.

Rule 8 states that tenant ID is never accepted from a request body, query string or header — it comes from the authenticated session only. Rule 18 requires every permission to be checked server-side.

## Decision

### Token pair

```
Access token    JWT, ~15 minutes, held in memory by the client
                signed, verified on every request, never stored server-side

Refresh token   opaque random 256-bit value, ~14 days, HttpOnly + Secure +
                SameSite=Strict cookie, hashed at rest, rotated on every use
```

The access token is a bearer credential with a short blast radius. The refresh token is a long-lived credential that exists only to mint access tokens and is never sent to a business endpoint — its cookie path is scoped to the refresh endpoint alone.

Access token claims:

```
sub          user id
tenant_id    the tenant this session acts in          ← signed, authoritative
session_id   server-side session record id            ← revocation handle
roles/perms  permission set snapshot (or a version hash, see below)
mfa          whether this session completed MFA
iat, exp, jti, iss, aud
```

Signed with RS256 (asymmetric, so the worker and future services verify without holding the signing key). Key rotation via a published JWKS with overlapping validity.

### `tenant_id` is a signed claim, and only a signed claim

This is the rule that the database's isolation guarantee rests on:

```
login  →  server resolves the user's tenant from the database
       →  server puts tenant_id in the JWT payload
       →  server signs the JWT
                     ↓
request →  guard verifies the signature
       →  guard reads tenant_id from the verified payload
       →  TenantContext (AsyncLocalStorage)
       →  set_config('app.tenant_id', …, true)   per transaction
       →  RLS policies compare against it                (ADR-0004)
```

- A signature makes the claim **server-asserted**. The client carries the value but cannot change it: any modification invalidates the signature and the request is rejected before a guard runs.
- **`tenant_id` is never read from a request body, query string, path parameter, custom header or cookie other than the session.** Not as a convenience for admin tooling, not as an override for support, not "just for this one import endpoint". A DTO containing a `tenantId` input field is a build failure.
- The reason is structural, not stylistic: every defence below the guard — the repository filter, the RLS policy — takes the tenant as *input*. They verify that rows match the current tenant; they cannot verify that the current tenant is the right one. If the tenant is attacker-controlled, all four layers faithfully enforce the attacker's choice. Signing is what makes the input trustworthy, so it is the one place where no flexibility is permitted.
- A user belonging to more than one tenant does not pass a tenant per request. They hold one session per tenant, and switching tenant is a re-authentication against the refresh endpoint that issues a new token pair with the new claim, recorded in the audit log.
- Background work carries its tenant on its own persisted row — the `outbox` row, the import job record — and the worker establishes context from that, verified against the row's `tenant_id`, never from a queue payload field (ADR-0010).

### Rotating refresh tokens with reuse detection

Every refresh consumes the presented token and issues a new one. The old value is invalid from that moment.

```
POST /auth/refresh  with R1
  ├─ R1 valid and unused   → issue access token + R2; mark R1 USED, R2 active
  │                          (R1 and R2 belong to the same token family)
  │
  └─ R1 valid but ALREADY USED   → REUSE DETECTED
                                 → revoke the ENTIRE token family
                                 → all sessions from that family end immediately
                                 → audit record + security alert
                                 → user must re-authenticate
```

Reuse detection is the point of rotation. A stolen refresh token is indistinguishable from the legitimate one — until both are used. Whichever party refreshes second presents a consumed token, and the family dies. The theft becomes a detected, alerted, self-limiting event instead of an indefinite silent foothold.

A short grace window (a few seconds) tolerates a genuine network retry replaying the same refresh, returning the already-issued pair rather than killing the family. Beyond the window, reuse is reuse.

Refresh tokens are stored hashed (SHA-256) so a database read does not yield usable credentials, and are bound to the session record, the user, the tenant and a device fingerprint.

### Server-side session revocation

The access token is stateless, but the session is not:

```
sessions
  id, tenant_id, user_id, created_at, last_seen_at,
  ip, user_agent, device_id, mfa_at, status, revoked_at, revoked_reason,
  permission_version
```

- Every access token carries `session_id`. The guard checks the session is `ACTIVE` — a cached lookup (Redis, ADR-0002) with a short TTL, falling back to PostgreSQL, which remains the source of truth.
- Revocation is immediate for the refresh path and bounded by the access token's remaining lifetime plus the cache TTL for the access path. Fifteen minutes is the deliberate ceiling on that window, which is why access tokens are short.
- Revocation triggers: explicit logout, admin termination, password change, MFA reset, role or permission change, user deactivation, refresh reuse detection, and inactivity timeout.
- Admins can list a user's active sessions with device and IP, and end any of them. Every revocation writes an audit record (rule 9).
- `permission_version` handles the staleness of the permission snapshot in the token: changing a user's roles bumps the version, and a token whose version is behind is refused at the guard, forcing a refresh. A privilege *reduction* therefore takes effect on the next request, not in fifteen minutes.

Permissions themselves are always evaluated server-side against the catalogue in `packages/permissions` (rule 18). The token's claims are an optimisation, never the authority; the frontend hiding a button is a UX affordance, not a control.

### MFA for privileged roles

MFA (TOTP, with hashed single-use recovery codes) is **mandatory** for any role holding a privileged permission:

```
period.close   period.reopen            admin.user_manage   admin.role_manage
voucher.reverse                         customer.credit_override
sale.discount_override                  price.override
inventory.adjust  inventory.negative_allow
report.export  audit.view
```

- A user granted such a role must enrol before the role becomes effective; the grant is pending until enrolment.
- The session records `mfa_at`. Step-up re-authentication is required for the highest-privilege actions — reopening a period, changing roles, break-glass access — even within an active session.
- Recovery codes are single-use, hashed, and their consumption is audited.
- Failed attempts feed the same lockout and alerting path as password failures, and `LOGIN_FAILED` is a logged business event ([ARCHITECTURE.md §10](../ARCHITECTURE.md)).

Supporting controls: password policy with breach-list checking, Argon2id hashing, account lockout with progressive backoff, and rate limiting on login and refresh. Tokens, session IDs and passwords are never logged in plaintext.

## Consequences

### Positive

- A leaked access token expires in minutes without any revocation action; a leaked refresh token is detected the moment either party uses it twice, and the whole family dies — a foothold that would otherwise be silent and open-ended.
- Isolation rests on a signature rather than on every endpoint remembering to ignore a client-supplied tenant.
- Revocation is genuinely available, with a stated and bounded worst case, which stateless-JWT-only designs cannot offer. Privilege changes take effect on the next request via `permission_version`.
- Asymmetric signing lets the worker and any later extracted service verify tokens without the signing key.

### Negative / accepted costs

- The guard does a session lookup per request, so the design is not purely stateless. Mitigated by a short-TTL cache; PostgreSQL stays authoritative.
- Up to ~15 minutes of residual access after revocation on the access path. Accepted and documented; shortening it trades against refresh traffic.
- Rotation makes concurrent refreshes from multiple tabs or a flaky connection a real edge case. Handled by the grace window and by serialising refresh per session; it must be tested, not assumed.
- A refresh-token cookie means CSRF must be handled explicitly: `SameSite=Strict`, a scoped path, and an anti-CSRF token on state-changing requests.
- Mandatory MFA for privileged roles adds onboarding friction and a recovery-code process that support must handle. Accepted for roles that can reopen a period or change a credit limit.
- No cross-tenant "super admin" session exists by construction, so platform operations need the separate `readonly_support` / `breakglass` roles and their audited procedure (rule 21).

## Alternatives considered

**Long-lived JWT with no refresh token.** Rejected. No revocation, and a leaked token is valid for its full lifetime — which for a usable shift-long session would be hours.

**Opaque session cookie with server-side state only (no JWT).** A defensible design, with immediate revocation and no claim staleness. Rejected because every request would require a session read before any work, the API is also consumed by the worker and future extracted services that benefit from offline signature verification, and pure-cookie auth complicates non-browser clients. The hybrid keeps immediate revocation on the refresh path and a bounded window on the access path.

**Non-rotating refresh tokens.** Rejected. Without rotation there is no reuse signal, so a stolen refresh token is a silent, renewable foothold for its full lifetime.

**`tenant_id` supplied per request, validated against the user's memberships.** Rejected. It looks safe — the server checks membership — but it makes tenant selection an attacker-influenced input on every endpoint, so correctness depends on every handler performing the check, forever. One missed validation is a cross-tenant write. Signing removes the failure mode instead of testing for it.

**Storing the access token in `localStorage`.** Rejected. XSS-readable. Access tokens live in memory; the refresh token lives in an HttpOnly cookie.

**MFA optional for privileged roles, enabled per tenant.** Rejected. The permissions listed above can move money, change stock valuation, reopen a period or alter authorization. A tenant declining MFA on those roles is not a configuration choice we offer.

## Compliance

- Lint/type rule: no request DTO, query schema or queue payload may declare a `tenantId` input field. Build failure (rule 8). `TenantContext` may be populated only by the global auth guard in `packages/auth`.
- Guard test: a request carrying `tenantId` in body, query, path or header is asserted to have no effect on the tenant used; the JWT claim governs.
- Token test: a JWT with a modified `tenant_id` payload fails signature verification and is rejected before any handler runs. An `alg: none` / algorithm-confusion token is rejected.
- Refresh test: rotation issues a new token and invalidates the old; replaying a consumed refresh token beyond the grace window revokes the whole family, ends its sessions, writes an audit record and raises an alert.
- Revocation test: after admin termination, password change or role change, the refresh path fails immediately and the access path fails within the documented window; `permission_version` mismatch is refused at the guard.
- MFA test: a user granted a privileged role cannot exercise it before enrolment; step-up is required for `period.reopen` and `admin.role_manage`; recovery codes are single-use and audited.
- `tests/security/` — adversarial tenant isolation exercised through the authenticated API (ADR-0003), plus rate-limit and lockout coverage.
- Log test / secret scanning: no token, refresh value, session id or password appears in any log line or error message (rule 20). Every session lifecycle event writes an audit record (rule 9).

## Related

- [ADR-0004](ADR-0004-postgresql-row-level-security.md) — what consumes the signed `tenant_id` claim
- [ADR-0003](ADR-0003-shared-database-multi-tenancy.md) — why that claim is the whole isolation model's input
- [ADR-0002](ADR-0002-postgresql-and-redis.md) — Redis caches session state; PostgreSQL owns it
- [ADR-0010](ADR-0010-transactional-outbox.md) — how background work establishes tenant identity without a session
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 8, 9, 18, 20, 21, 22
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §6 multi-tenancy, §8 permissions, §10 observability
- [../PRD.md](../PRD.md) — §4.1 identity and RBAC, §5 security baseline
