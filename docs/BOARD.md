# Board

**Rules:** [OPERATING_MODEL.md](OPERATING_MODEL.md) §6. Updated by the orchestrator whenever a card moves.

- **WIP limit:** the current MVP increment plus one platform task in **Now**. Nothing else starts.
- **Blocked 2 working days** → it becomes a Council decision, or a Product Owner decision if it changes scope, cost, compliance exposure or date.
- **Decisions needed** name the decider and the date asked; each closes within 2 working days.
- **Demo ready** holds only workflows running against the real API on staging. Mock screens never go here.

*Last updated: 2026-09-27 (M1-000, Council unblock; follow-ups closed the same day).*

---

## Now — M1, minimum platform

| Lane | Worktree | Items | Tier | Seat |
|---|---|---|---|---|
| **M1-A Auth** | `m1-auth` | Migration **006** refresh resolver ([ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) §2) · migration **007** `users` regrant + transition trigger (TD-005) **and** the `tenants` column-grant narrowing excluding `code` and `status` (ADR-0023 §1 — `/auth/login` does not ship before 007) · `packages/auth` · `/api/auth/*` endpoints · real `TenantGuard` | T2 | Database/Security + Architecture (ADR-0023 conditions A1–A3, A1 as widened by the addendum) |
| **M1-R RBAC** | `m1-rbac` | Migration **008** · `packages/permissions` (MVP catalogue) · `PermissionGuard` | T2 | Database/Security + Architecture |
| **M1-W Web + infra** | `m1-web` | Login page (tenant code · email · password) · API client · prototype banner on mock screens · staging HTTPS on `31-220-74-159.sslip.io` | T1 / T2 | Architecture · `devops-guardian` · `design-system` |
| **M1-D Audit** | — | Migration **009** `audit_log` + chain verifier per ADR-0020. **Starts after** the PR for `feature/W1-000-adr-0020-audit-canonicalisation` is merged | T2 (T3 for the financial-mutation hook) | Database/Security + Accounting |

**Query placement, M1-A and M1-R (ADR-0023 A1, widened 2026-09-27).** Every query body lives in `packages/database` as a named export with no business rule in it. For auth: the `tenants`-by-code resolver, the `users` read, the refresh spend, the `sessions` insert and `last_login_at`. For RBAC: permission resolution, plus system-role seeding with the catalogue passed in. `packages/auth` and `packages/permissions` call those exports and build no query. **Merge condition on the first code PR in each lane:** extend ESLint's `appsQuerySyntax` rule (`tx.selectFrom(…)` and friends) from `apps/**` to that lane's package, with a case in `tests/security/lint-boundaries.spec.ts`. Today nothing stops a `TenantTx` received by `packages/auth` from building a query.

**Migration merge order: 006 → 007 → 008 → 009.** Numbers are fixed (Product Owner, 2026-09-26, [WAVE_1_REGISTER](WAVE_1_REGISTER.md) "Migration numbering"). A lane whose migration is ready before its predecessor has merged waits; it does not renumber. `CHECKSUMS` pins identity, so a renumber after review is a re-review.

## Next

| ID | Item | Tier | Seat |
|---|---|---|---|
| **M1-X Exit** | W1-006 exit suite — authorised access succeeds, cross-tenant fails, at API and SQL · seed for the demo tenants `BHATTI1` / `BHATTI2` · **demo 1** (login into each tenant on staging) | T2 | Database/Security |

Then **M2** accounting core · **M3** customers, service invoice, receipts · **M4** API-backed journey + Product Owner demo ([IMPLEMENTATION.md](IMPLEMENTATION.md) §13).

## Blocked

| Item | Blocked on | Deadline |
|---|---|---|
| ~~W1-002 / W1-003 merge~~ | ~~ADR-0023 Architecture seat signature~~ — **resolved 2026-09-27**: approved with conditions, ADR-0023 Accepted | — |
| M1-D (W1-005) | `feature/W1-000-adr-0020-audit-canonicalisation` — **awaiting Product Owner merge of its PR.** Merges cleanly into `develop` at `afd4a6d` (checked 2026-09-27) | 2026-09-29 |
| M1-D — writing migration 009 | ADR-0020 on that branch still says **"migration 007"** for `audit_log` (its `Blocks:` line, §5, and "Three conditions carried to migration 007") — stale against the 2026-09-26 numbering, which makes it **009**. The register says ADR-0020 is amended rather than ADR-0023 bent around it; that amendment has not landed. Architecture seat corrects the references after the branch merges, before 009 is written | 2026-09-29 |
| ~~M1-A / M1-R — query construction in `packages/auth` / `packages/permissions`~~ | ~~ADR-0013 allowlist (ADR-0023 A4)~~ — **withdrawn 2026-09-27**: A1 keeps all query construction in `packages/database`, which ADR-0013 already permits. No ADR-0025 | — |
| ~~M1-A — `packages/auth` merge~~ | ~~Head notices on ADR-0009 and ADR-0004 (ADR-0023 A5)~~ — **delivered 2026-09-27** (ADR-0009 kept at +24; ADR-0004 now +19) | — |
| M1-A — `/auth/login` emitting `Set-Cookie` | Cookie-prefix decision (ADR-0023 *Open*, a stated gate) — see Decisions needed | 2026-09-29 |

## Decisions needed

| Decider | Decision | Asked | Council recommendation |
|---|---|---|---|
| **Council — Architecture + `devops-guardian`** | Refresh-cookie prefix: `__Host-` or `__Secure-` (ADR-0023 *Open*; gates `Set-Cookie` on `/auth/login`) | 2026-09-27 | **Architecture seat: `__Host-` on staging.** ADR-0023's own rule — `__Host-` wins where the app shares a registrable domain with anything else. `sslip.io` is **not** on the Public Suffix List (measured 2026-09-27), so `31-220-74-159.sslip.io` shares `sslip.io` with every other sslip host on the internet, any of which can set a `Domain=sslip.io` cookie. Production is decided when its domain is chosen, not inherited from staging. Needs `devops-guardian` |
| **Council — Architecture + Database/Security** | A request that supplies a tenant: ADR-0004 rule 2 (:75) says *"the field is rejected by the DTO schema"*. ADR-0009's Compliance says it *"has no effect on the tenant used"*. ADR-0023's test demands a *"byte-identical response"* on login and refresh. The three do not agree on body and query fields | 2026-09-27 | **Architecture seat: reject by schema.** Every request schema is strict: an unknown body or query key, `tenantId` included, is a 400. A header, cookie or path value is never read as a tenant, so it has no effect. That satisfies ADR-0004 as written and ADR-0009's "no effect on the tenant used", since a 400 uses no tenant. On login it falls outside ADR-0023 §4's envelope (schema validation, 400: no database, no counter). ADR-0023's byte-identical test is then read as "identical to any other unknown key" for body and query, and byte-identical for header and cookie. **Option B**, strip and ignore everywhere, hides client bugs and lets probes pass silently. Needs Database/Security to agree; recorded in ADR-0023's signatures when closed |
| **Council — Accounting + Architecture** | M2 — service sale: a `SALE_POSTED` variant, or a new financial event | 2026-09-27 | **Architecture seat: `SALE_POSTED` variant with non-stock lines — pending the Accounting seat.** One business fact, one event: a sale carries lines of a declared kind, and a non-stock (service) line posts receivable and revenue only and never calls `inventoryKernel.postMovement`. Stock lines later add inventory and COGS inside the same event and the same transaction, so no second posting-rule family and no second reversal path. The accounting-kernel public surface gains a line kind, not an event. **Needed from Accounting:** the posting rule for a service line (accounts, and that the MVP slice is no-tax), and confirmation that reversal of a mixed sale is one reversal of one entry |
| **Council — Architecture (+ Accounting for D4, D6)** | The D1–D9 deferrals and the reconciliation-scope deferral ([RECONCILIATION-2026-09](adr/RECONCILIATION-2026-09.md), [WAVE_0_REGISTER](WAVE_0_REGISTER.md)) — moved from the Product Owner by ADR-0024 | 2026-09-27 | — |

## Decided

| Date | Decider | Decision |
|---|---|---|
| 2026-09-27 | **Product Owner** | **Weekly demo day: Monday.** The weekly status page (`docs/status/YYYY-Www.md`) is written the day before, Sunday |
| 2026-09-27 | **Council — Architecture** | ADR-0023 addendum: **A1 widened** (every auth and RBAC query body in `packages/database`), **A4 withdrawn** (no ADR-0013 extension), **A5 delivered** (head notices on ADR-0009 and ADR-0004) |
| 2026-09-27 | **Product Owner** | **Demo tenants: `bhatti1` and `bhatti2`** — tenant codes; staging demo data only. Stored as `BHATTI1` / `BHATTI2`: `tenants.code` is `^[A-Z][A-Z0-9_]{1,15}$` (`001_create_tenants.sql:43`) and the login form upper-cases input (ADR-0023 §5), so users may type either case |
| 2026-09-27 | **Council — Architecture** | [ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) approved with conditions A1–A5; Accepted. Security and Database Guardians signed the same day; Product Owner slot withdrawn by ADR-0024 |
| 2026-09-26 | **Product Owner** | Migration numbering: 006 resolver · 007 `users` regrant + trigger · 008 RBAC · 009 `audit_log` |

## Done

| ID | Item | Merged |
|---|---|---|
| OPS-001 | Operating model — ADR-0024, delivery-brief skill, governing docs, this board | PR #7, 2026-09-27 |
| W1-002 (docs) | ADR-0023 draft, security review, ADR-0016 D8 closed | PR #8, 2026-09-27 |
| OPS-002 | CI by tier — `tools/ci/classify.mjs`, `npm run check` / `check:full`; secrets + FinancialInvariantSuite on every PR | PR #9, 2026-09-27 |

## Demo ready

*Nothing yet.* No workflow runs against the real API on staging. The screens in `apps/web` are prototypes.
