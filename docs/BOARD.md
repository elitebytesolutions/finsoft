# Board

**Rules:** [OPERATING_MODEL.md](OPERATING_MODEL.md) §6. Updated by the orchestrator whenever a card moves.

- **WIP limit:** the current MVP increment plus one platform task in **Now**. Nothing else starts.
- **Blocked 2 working days** → it becomes a Council decision, or a Product Owner decision if it changes scope, cost, compliance exposure or date.
- **Decisions needed** name the decider and the date asked; each closes within 2 working days.
- **Demo ready** holds only workflows running against the real API on staging. Mock screens never go here.

*Last updated: 2026-09-29 (ADR-0028 module packaging delivered as Proposed, Architecture seat signed, Database/Security seat pending; earlier the same day: ADR-0026 party dimension and ADR-0027 posting idempotency both Accepted; the M3 pack's planned "ADR-0027" is renumbered ADR-0028; condition K1 binds the M2-A merge).*

---

## Now — M1, minimum platform

| Lane | Worktree | Items | Tier | Seat |
|---|---|---|---|---|
| **M1-A Auth** | `m1-auth` | Migration **006** refresh resolver ([ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) §2) · migration **007** `users` regrant + transition trigger (TD-005) **and** the `tenants` column-grant narrowing excluding `code` and `status` (ADR-0023 §1 — `/auth/login` does not ship before 007) · `packages/auth` · `/api/auth/*` endpoints · real `TenantGuard` | T2 | Database/Security + Architecture (ADR-0023 conditions A1–A3, A1 as widened by the addendum) |
| **M1-R RBAC** | `m1-rbac` | Migration **008** · `packages/permissions` (MVP catalogue) · `PermissionGuard` | T2 | Database/Security + Architecture |
| **M1-W Web + infra** | `m1-web` | Login page (tenant code · email · password) · API client · prototype banner on mock screens · staging HTTPS on `31-220-74-159.sslip.io` | T1 / T2 | Architecture · `devops-guardian` · `design-system` |
| **M1-D Audit** | `m1-audit` | Migration **009** `audit_log` + chain verifier per ADR-0020 (its body says 007; the head notice renumbers it). **Started 2026-09-27** | T2 (T3 for the financial-mutation hook) | Database/Security + Accounting |

**Query placement, M1-A and M1-R (ADR-0023 A1, widened 2026-09-27).** Every query body lives in `packages/database` as a named export with no business rule in it. For auth: the `tenants`-by-code resolver, the `users` read, the refresh spend, the `sessions` insert and `last_login_at`. For RBAC: permission resolution, plus system-role seeding with the catalogue passed in. `packages/auth` and `packages/permissions` call those exports and build no query. **Merge condition on the first code PR in each lane:** extend ESLint's `appsQuerySyntax` rule (`tx.selectFrom(…)` and friends) from `apps/**` to that lane's package, with a case in `tests/security/lint-boundaries.spec.ts`. Today nothing stops a `TenantTx` received by `packages/auth` from building a query.

**Migration merge order: 006 → 007 → 008 → 009.** Numbers are fixed (Product Owner, 2026-09-26, [WAVE_1_REGISTER](WAVE_1_REGISTER.md) "Migration numbering"). A lane whose migration is ready before its predecessor has merged waits; it does not renumber. `CHECKSUMS` pins identity, so a renumber after review is a re-review.

## Next

| ID | Item | Tier | Seat |
|---|---|---|---|
| **M3 core lanes** — *next after M2-A* | Design pack: [docs/design/M3/](design/M3/README.md) (M3-000b). **M3-C** customers module + module platform + migration **015** · **M3-P** (T3, one lane) receivables: migrations **016**, **017**, `SALE_POSTED/service@1` and `CUSTOMER_PAYMENT_RECEIVED@1` implemented, invoice + receipt endpoints · **M3-Q** Invariant 9 AR half + golden P04–P06, P08, P09, P10. M3-C ║ M3-P; M3-P merges after M3-C. **Blocked** — see Blocked | T3 | Architecture · Accounting · Database/Security |
| **M2-000 Posting-rules spec** | `docs/posting-rules/` — standard COA (`standard-v1`), JV, reversal, periods, ledger + trial balance, service sale, customer receipt · golden scenarios P01–P10 in `tests/accounting/golden/`. Documents only. **In review** on `feature/M2-000-posting-rules-spec` | T3 | Accounting (author) · Architecture (event surface, hand-offs in `docs/posting-rules/README.md` §5) |
| **M3-000b Posting-rules rewording** | ADR-0026 moved the party FK target from `customers` to the kernel's `parties` registry. Two passages still say otherwise: [service-sale.md](posting-rules/service-sale.md):84 (*"foreign key from the journal line's party to the customer"*) and the migration-012 row of the [posting-rules README](posting-rules/README.md) §5 (*"The party FK target (`customers`) does not exist until M3"*). Both should say the FK runs to `parties`, which 012 creates, and that `customers` FKs to `parties`. Documents only; the Architecture seat does not edit posting rules | T3 | Accounting |
| **M1-X Exit** | W1-006 exit suite — authorised access succeeds, cross-tenant fails, at API and SQL · seed for the demo tenants `BHATTI1` / `BHATTI2` · **Demo 1 = when M1-X + Web are merged and verified on staging** | T2 | Database/Security |

Then **M2** accounting core · **M3** customers, service invoice, receipts · **M4** API-backed journey + Product Owner demo ([IMPLEMENTATION.md](IMPLEMENTATION.md) §13).

**Dated deferral (M2-000, [periods.md](posting-rules/periods.md) §6):** the MVP creates fiscal year FY2027 only. "Create next fiscal year" must ship **before 2027-07-01**, or every posting dated on or after that day is rejected `PERIOD_NOT_FOUND`. Year-end closing entries are due before FY2027 is closed.

## Blocked

| Item | Blocked on | Deadline |
|---|---|---|
| ~~W1-002 / W1-003 merge~~ | ~~ADR-0023 Architecture seat signature~~ — **resolved 2026-09-27**: approved with conditions, ADR-0023 Accepted | — |
| ~~M1-D (W1-005)~~ | ~~`feature/W1-000-adr-0020-audit-canonicalisation` awaiting merge~~ — **resolved 2026-09-27**: PR #11 merged | — |
| ~~M1-A / M1-R — query construction in `packages/auth` / `packages/permissions`~~ | ~~ADR-0013 allowlist (ADR-0023 A4)~~ — **withdrawn 2026-09-27**: A1 keeps all query construction in `packages/database`, which ADR-0013 already permits. No ADR-0025 | — |
| ~~M1-A — `packages/auth` merge~~ | ~~Head notices on ADR-0009 and ADR-0004 (ADR-0023 A5)~~ — **delivered 2026-09-27** (ADR-0009 kept at +24; ADR-0004 now +19) | — |
| ~~M1-A — `/auth/login` emitting `Set-Cookie`~~ | ~~Cookie-prefix decision (ADR-0023 *Open*, a stated gate)~~ — **resolved 2026-09-27**: decided, see Decided | — |
| ~~M1-D — migration 009 merge~~ | ~~README §4 notices on ADR-0020, required by the Database seat's review of 009~~. **Delivered 2026-09-27** (M1-000e): five correction notices at the end of the file, with a pointer on head-notice line 14. The offset stays +12 | — |
| M1-D — **production** use of the audit chain | [GAP-004](COMPLIANCE_GAPS.md#gap-004--audit-chain-head-has-no-external-witness): the chain head has no external witness, so tail deletion or a full rewrite by the owner, a superuser or break-glass is undetectable (Security seat F1). Staging is not blocked | Before the first production release |
| M1-A — auth login split | ~~ADR-0025 signatures~~. **[ADR-0025](adr/ADR-0025-login-read-and-write-transactions.md) Accepted 2026-09-27** (M1-000f), superseding ADR-0023:191 only, with the Database/Security seat signed. Still open: the Architecture seat's merge conditions **C1**, a test that no connection is held while argon2id runs, and **C2**, a lint rule forbidding `tenant-context` imports in `packages/database/src/auth/login.ts` and `refresh.ts`. This is a different ADR-0025 from the one withdrawn with A4 above | C1 and C2 on `feature/M1-A-auth` |
| M3-C / M3-P start | (1) **M2-A merged** with kernel capabilities K1 and K6 ([M3 README](design/M3/README.md) §4); (2) **ADR-0026** party dimension Accepted (Database seat, `feature/M3-000a-party-dimension`); (3) ~~**ADR-0028** module packaging and runtime Accepted (Architecture seat, owed)~~. **Delivered 2026-09-29, pending signatures**: [ADR-0028](adr/ADR-0028-module-packaging-and-runtime.md) is Proposed on `feature/M3-000d-adr-0028`. The Architecture seat approved it. The Database/Security seat's review is outstanding (statements 6, 8, 9; C8, C10). Conditions **C1–C12 bind M3-C's first PR**; (3a) **K7 — migration 013 must support a non-fiscal-year `CUST` series** for system-generated customer codes (M3-Q2), raised with M2-A 2026-09-28; (4) M1-X's global `PermissionGuard` merged before any M3 route merges. Migrations **015–017 reserved for M3** — migration **014** was taken by the M2-B Council ruling's permission backfill (`account.view`/`period.view`/`period.close`/`period.reopen`, docs/design/M2/api-contract.md §6/§9), which moved M3's reservation up by one (was 014–016) | (3) before M3-C opens; (1), (2) set by their lanes |
| **M2-C — coa-standard.md §8.7 R2's database-privilege backstop** ([TD-012](TECH_DEBT.md#td-012--coa-standardmd-87-r2s-database-privilege-backstop-is-not-built--blocked-on-a-new-database-role)) | A `SECURITY DEFINER` seeding function, owned by a `NOLOGIN`/`NOBYPASSRLS` role that "owns nothing else" (Security seat, M2-C delivery brief), needs a new database role. `finsoft_migration` has no `CREATEROLE`; the role can only be added to `infrastructure/docker/postgres/init/00-bootstrap.sh`, outside the M2-C lane's `ALLOWED` paths. Everything else in the M2-C brief (migration 018 R1/R3–R11, migration 019, the kernel, the API, tests) is delivered; R2's database half is the one open item | A Database/DevOps Guardian change to `00-bootstrap.sh` (new role, e.g. `finsoft_coa_seed`), then a follow-up migration |

## Decisions needed

| Decider | Decision | Asked | Council recommendation |
|---|---|---|---|
| **Council — Architecture + Database/Security** | A request that supplies a tenant: ADR-0004 rule 2 (:75) says *"the field is rejected by the DTO schema"*. ADR-0009's Compliance says it *"has no effect on the tenant used"*. ADR-0023's test demands a *"byte-identical response"* on login and refresh. The three do not agree on body and query fields | 2026-09-27 | **Architecture seat: reject by schema.** Every request schema is strict: an unknown body or query key, `tenantId` included, is a 400. A header, cookie or path value is never read as a tenant, so it has no effect. That satisfies ADR-0004 as written and ADR-0009's "no effect on the tenant used", since a 400 uses no tenant. On login it falls outside ADR-0023 §4's envelope (schema validation, 400: no database, no counter). ADR-0023's byte-identical test is then read as "identical to any other unknown key" for body and query, and byte-identical for header and cookie. **Option B**, strip and ignore everywhere, hides client bugs and lets probes pass silently. Needs Database/Security to agree; recorded in ADR-0023's signatures when closed |
| **Product Owner** (acceptance) · **Security seat** (design) | **GAP-004** — before production, either an ADR-0020 amendment adds external `(tenant, seq, head_hash)` checkpoints (WORM, or signed with a key no database role holds), with the verifier asserting head ≥ last checkpoint, or the Product Owner accepts the gap in writing | 2026-09-27 | **Architecture seat: amend.** Unkeyed hashing cannot detect its own truncation. Written acceptance would leave rule 9's "tamper-evident" false against the roles most able to tamper |
| **Council — Architecture (+ Accounting for D4, D6)** | The D1–D9 deferrals and the reconciliation-scope deferral ([RECONCILIATION-2026-09](adr/RECONCILIATION-2026-09.md), [WAVE_0_REGISTER](WAVE_0_REGISTER.md)) — moved from the Product Owner by ADR-0024 | 2026-09-27 | — |
| **Accounting seat** | [service-sale.md](posting-rules/service-sale.md) §11 (an inactive customer "can still be paid") contradicts [customer-receipt.md](posting-rules/customer-receipt.md) §3 row 8 (`CUSTOMER_INACTIVE`). M3 follows row 8 ([open-questions](design/M3/open-questions.md), referred). **Being resolved on `feature/M3-000c-posting-rules`**, with the receipt-draft wording and service-sale.md:84 | 2026-09-28 | Amend §11 |

## Decided

| Date | Decider | Decision |
|---|---|---|
| 2026-09-28 | **Council — Architecture + Accounting** | [ADR-0027](adr/ADR-0027-posting-idempotency-resolved-against-the-journal.md) Accepted. Posting idempotency is resolved against `journal_entries`' `(tenant_id, idempotency_key)` unique index. Step 2 is a lookup, and a replay returns the prior result. Numbering and the entry INSERT run inside one named kernel savepoint, rolled back on a lost race, so no number is consumed. That savepoint is the only transaction control the kernel issues. Supersedes ADR-0005:56 only, and a permanent scope notice at ADR-0005's head (+21) marks it. **Condition K1 binds the M2-A merge:** an ESLint rule rejects transaction-control SQL and transaction or savepoint APIs in `packages/accounting-kernel`, except the three `finsoft_posting_number` statements in `queries/journal-writes.ts`. `lint-boundaries.spec.ts`'s accepted `SAVEPOINT s` case flips to rejected |
| 2026-09-28 | **Orchestrator** | **ADR numbering.** The M3 design pack's planned "ADR-0027" (module controllers in `apps/api`, no module `ui/` layer) becomes **ADR-0028**. ADR-0027 is the posting-idempotency record. References in `docs/design/M3/**` and the M3 BOARD row on `feature/M3-000b-design-pack` still say 0027 and must be corrected on that branch before it merges |
| 2026-09-28 | **Council — Database/Security + Architecture** | [ADR-0026](adr/ADR-0026-journal-line-party-dimension.md) Accepted: **the journal-line party dimension.** Option B: a kernel-owned, insert-only `parties` registry in **012**. `journal_lines.(tenant_id, party_type, party_id)` has a composite FK to it. §4.1 is enforced declaratively through `account_control` and a composite FK to `accounts (tenant_id, id, control_kind)`, and 010 must make `control_kind` `NOT NULL` with `'NONE'`. `customers` (014) shares the party id and FKs *to* `parties`, so no kernel table references a module and nothing ever alters `journal_lines`. Only the kernel writes `parties`, through `registerParty(tx, type)` on its index, with the query body in `packages/accounting-kernel` (moved from `packages/database` by the Architecture seat at signature). Options A (no FK) and C (014 altering a kernel table) are rejected. **Statements 1–3 bind M2-A** |
| 2026-09-27 | **Council — Architecture + `devops-guardian`**, Security seat concurring | **Refresh-cookie prefix; the ADR-0023 *Open* gate is lifted.** Staging: `__Host-finsoft_rt`, `Path=/`, because `sslip.io` is not on the Public Suffix List. Production: `__Secure-finsoft_rt`, `Path=/api/auth`, provided no untrusted host shares its registrable domain (otherwise `__Host-` there too), confirmed by `devops-guardian` when the domain is chosen. Recorded in the [ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) addendum |
| ~~2026-09-27~~ | ~~**Product Owner**~~ | ~~**Weekly demo day: Monday.** The weekly status page (`docs/status/YYYY-Www.md`) is written the day before, Sunday~~ — **superseded 2026-09-28** (see row above) |
| 2026-09-27 | **Council — Architecture** | ADR-0023 addendum: **A1 widened** (every auth and RBAC query body in `packages/database`), **A4 withdrawn** (no ADR-0013 extension), **A5 delivered** (head notices on ADR-0009 and ADR-0004) |
| 2026-09-28 | **Product Owner** | **M3-Q1 — receipts can be saved as drafts.** `DRAFT → POSTED → REVERSED`, `DRAFT → CANCELLED`; a draft posts nothing and takes no number; proposed allocations take effect only at post; `payment.receive` throughout (a separate `payment.post` code is debt). +2 days M3-P, +1 day M4 ([open-questions](design/M3/open-questions.md)) |
| 2026-09-28 | **Product Owner** | **M3-Q2 — customer codes are system-generated**, from a per-tenant `CUST` series in `document_sequences` (not per fiscal year: Architecture seat), `CUST-000001`, immutable; the create API accepts no code. Needs K7 in migration 013 ([open-questions](design/M3/open-questions.md)) |
| 2026-09-27 | **Product Owner** | **Demo tenants: `bhatti1` and `bhatti2`** — tenant codes; staging demo data only. Stored as `BHATTI1` / `BHATTI2`: `tenants.code` is `^[A-Z][A-Z0-9_]{1,15}$` (`001_create_tenants.sql:43`) and the login form upper-cases input (ADR-0023 §5), so users may type either case |
| 2026-09-27 | **Council — Architecture + Database/Security**, Security seat concurring | [ADR-0025](adr/ADR-0025-login-read-and-write-transactions.md) Accepted. Login read and write are separate transactions, both via `withResolvedTenant`, and the write re-asserts user status, the verified `password_hash`, tenant identity and tenant status. Supersedes ADR-0023:191 only. The test-only hooks are booked as [TD-006](TECH_DEBT.md) |
| 2026-09-27 | **Council — Architecture** | [ADR-0023](adr/ADR-0023-pre-tenant-authentication-reads.md) approved with conditions A1–A5; Accepted. Security and Database Guardians signed the same day; Product Owner slot withdrawn by ADR-0024 |
| 2026-09-26 | **Product Owner** | Migration numbering: 006 resolver · 007 `users` regrant + trigger · 008 RBAC · 009 `audit_log` |
| 2026-09-27 | **Product Owner** | **PO-Q1 — cancelling a part-paid invoice: Option A.** Refuse until the receipt is reversed ([service-sale.md](posting-rules/service-sale.md) §8). |
| 2026-09-27 | **Product Owner** | **PO-Q2 — manual JV approval: Option A.** Single step for the MVP; maker–checker after the MVP ([journal-voucher.md](posting-rules/journal-voucher.md) §9). |

## Done

| ID | Item | Merged |
|---|---|---|
| OPS-001 | Operating model — ADR-0024, delivery-brief skill, governing docs, this board | PR #7, 2026-09-27 |
| W1-002 (docs) | ADR-0023 draft, security review, ADR-0016 D8 closed | PR #8, 2026-09-27 |
| OPS-002 | CI by tier — `tools/ci/classify.mjs`, `npm run check` / `check:full`; secrets + FinancialInvariantSuite on every PR | PR #9, 2026-09-27 |
| M3-000c (closes M3-000b) | Posting-rules follow-ups, Accounting seat, 2026-09-28: receipt drafts per the Product Owner decision of 2026-09-28 (`DRAFT → POSTED → REVERSED`, `DRAFT → CANCELLED`, no effect and no number until post; [customer-receipt.md](posting-rules/customer-receipt.md) §1.1, R-1) · invoice drafts likewise cancelled, never deleted (Product Owner 2026-09-28; [service-sale.md](posting-rules/service-sale.md) R-3) · ruling R-2, an inactive customer can be paid but not invoiced (fixes the service-sale §11 / receipt row 8 contradiction) · party FK reworded to `parties` per ADR-0026 · fixture refs are not customer codes · golden **P11**, **P12**. P01–P10 and the `CUSTOMER_PAYMENT_RECEIVED` payload unchanged | `feature/M3-000c-posting-rules`, 2026-09-28 — merge after M3-000a |

## Demo ready

*Nothing yet.* No workflow runs against the real API on staging. The screens in `apps/web` are prototypes.
