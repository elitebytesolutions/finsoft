# M2-B — Accounting HTTP API contract

**Lane:** M2-B · **Branch:** `feature/M2-B-accounting-api` · **Consumes:** `packages/accounting-kernel`,
`packages/reporting` (carry-forward balance logic added by the Council ruling below),
`packages/permissions` (`account.view`/`period.view`/`period.close`/`period.reopen`, added by the same
ruling), `packages/shared-types` (response DTOs), read-only additions to
`packages/database/src/accounting/**`, and one migration (`014`, permission backfill).

This is the contract the M2-S screens lane builds against. It is pushed before any endpoint code, per
the M2-B brief. Later changes land as separate, clearly named commits on top of this one.

---

## 0. Status summary — read this first

| Outcome (from the brief) | Status |
|---|---|
| Post a journal voucher and reverse it | **Built** — §2 |
| See an account's ledger with a running balance | **Built** — §3 |
| Run a balanced trial balance | **Built** — §4 |
| View accounts in the chart of accounts | **Built** — §5 (`GET /api/accounts`, `account.view`) |
| Add / edit an account | **Built (M2-C, 2026-09-29)** — §5 (`POST /api/accounts`, `PATCH /api/accounts/:id`, `account.manage`). Superseded ruling below. |
| See the fiscal periods, close/reopen where permitted | **Built** — §6 (`period.view`/`period.close`/`period.reopen`). There is no lock route in M2 (Council ruling). |

**Update, 2026-09-29 — Council ruling closes the permission blocker.** All three Council seats
(Accounting: changes required · Security: approved with conditions · Architecture: rejected, narrowly)
reviewed the first version of this API at commit `3daed22`. The posting paths were sound; the review's
binding fix list is implemented in the commit(s) that follow `3daed22` on this branch. Two changes of
note for anyone who read the first version of this document:

1. **The ledger cursor no longer carries a financial number.** §3 describes the corrected shape —
   `packages/reporting` now recomputes a resumed page's carry-forward balance from the cursor's
   *position*, server-side, every time. The earlier shape (an opaque `closingBalance` round-tripped
   through the cursor) is gone.
2. **`account.view`, `period.view`, `period.close`, `period.reopen` are now real, catalogued
   permissions** (`packages/permissions/src/catalog.ts`), backfilled into every existing tenant's
   system roles by `database/migrations/014_add_account_and_period_permissions.sql`. §5/§6 below
   describe the endpoints those codes unblocked. `POST /api/accounts` is the one item that stays
   not-built — that was a scope ruling, not a permission gap, and the ruling did not change it.

**`3daed22` merged into `develop` before this fix list landed** (PR #35, `develop` is now past that
commit). Anyone reading `develop` directly between `3daed22` and this branch's own merge is reading the
UNFIXED ledger cursor described in point 1 above — a cursor whose `closingBalance` a client could forge
to make a resumed page report a wrong running balance. This branch's merge into `develop` is what
closes that window.

---

## 1. Conventions

- **Base path:** every route below is mounted under `/api` (`app.setGlobalPrefix('api')`).
- **Auth:** `Authorization: Bearer <access token>`, verified by `TenantGuard`. The tenant is the
  token's `tenantId` — never a header, body field or query string (rule 8). A request with no or
  invalid credentials gets `401`.
- **Permission:** every route below declares exactly one `@RequirePermission(code)` from
  `packages/permissions`' MVP catalogue. A caller lacking it gets `403`.
- **Validation:** every request body and query string is parsed by a `zod` schema via
  `ZodValidationPipe`. Every schema below is `.strict()`: an unrecognised key **fails validation**
  (`400 validation_failed`) rather than being silently dropped. (`ZodValidationPipe`'s own strip
  behaviour applies only to a *non*-strict schema — nothing on this API uses one, so "strips" does not
  describe what actually happens here; corrected per the Council review, 2026-09-29, which also found
  and removed a false ADR-0004 citation for this same behaviour — see
  `post-journal-voucher.dto.ts`'s header.) Money-shaped fields inside a posting payload
  (`lines[].debit`/`credit`) are left to the kernel's own validator rather than double-validated here,
  so the kernel's exact `PostingErrorCode` (not a generic zod message) is what a caller sees for a
  business-rule rejection — see §7.
- **Money:** every amount crosses the wire as a decimal string at the posting-rule's scale (4 dp for
  journal amounts), never a JSON number (ADR-0011/0014). A JSON number in a money field is rejected.
- **Dates:** `YYYY-MM-DD` calendar dates, tenant-timezone business dates — never a timestamp, never
  interpreted by the client's clock. The server resolves the fiscal period; the client only proposes a
  date.
- **Idempotency (ADR-0027):** every posting endpoint (`POST /journals`, `POST /journals/:id/reverse`)
  requires an `Idempotency-Key` header, `1–128` chars of `[A-Za-z0-9._:-]`, client-generated (one key
  per form submission). Three identical requests produce one posting; the same key with different
  content is `409 IDEMPOTENCY_KEY_REUSED`. A missing header is `400 idempotency_key_required`, checked
  before the kernel is reached.
- **Pagination:** list endpoints are keyset-paginated. The response carries `nextCursor: string | null`;
  pass it back unchanged as `?cursor=` for the next page. `null` means the list is exhausted. A
  malformed or forged cursor is `400`, never a 500 and never silently ignored.
- **Tenant isolation:** every read is scoped to the caller's tenant by an explicit `tenant_id = ...`
  predicate in the query **and** PostgreSQL RLS underneath it. A path parameter naming another
  tenant's row (an account id, a journal entry id) is **`404`, never `403`** — existence outside the
  caller's tenant is never disclosed (this is also what `journal-voucher.md` §3 row 7 and
  `reversal.md` §3 row 1 require of the kernel itself: "the same error whether the id is unknown or
  belongs to another tenant").
- **Errors:** one JSON shape for the whole API (`AllExceptionsFilter`):
  ```json
  { "statusCode": 400, "error": "jv_unbalanced", "message": "…", "path": "/api/journals", "timestamp": "…", "details": { "...": "..." } }
  ```
  `details` carries the kernel's `PostingError.details` verbatim where one exists (§7) — the facts a
  user needs, e.g. `{ "totalDebit": "55000.0000", "totalCredit": "54000.0000" }` for `JV_UNBALANCED`.

---

## 2. Journals

### `GET /api/journals` — the register

**Permission:** `voucher.view`

Query (all optional except pagination defaults):

| Param | Type | Notes |
|---|---|---|
| `status` | `POSTED \| REVERSED` | |
| `from`, `to` | `YYYY-MM-DD` | inclusive, filters `occurred_at` |
| `limit` | integer, 1–200, default 50 | hard-capped server-side at 200 |
| `cursor` | opaque string | from a previous page's `nextCursor` |

Order: `occurred_at` DESC, `created_at` DESC, `id` DESC (newest first, matching the register screen's
default "Newest first" sort — `docs/design-system/pages/voucher-register/README.md` §2).

```json
{
  "items": [
    {
      "id": "uuid",
      "entryNumber": "JV-2027-000001",
      "postingRule": "JOURNAL_VOUCHER_POSTED@1",
      "event": "JOURNAL_VOUCHER_POSTED",
      "occurredAt": "2026-09-27",
      "status": "POSTED",
      "narration": "…",
      "reference": "…",
      "sourceType": "journal_voucher",
      "sourceId": "uuid",
      "reversalOf": null,
      "reversedBy": null,
      "reversalReason": null
    }
  ],
  "nextCursor": "opaque-string-or-null"
}
```

Line detail is not included in the list (matches the register screen: lines appear in the inspector,
i.e. `GET /api/journals/:id`).

### `GET /api/journals/:id`

**Permission:** `voucher.view`

Full entry with lines.

```json
{
  "id": "uuid",
  "entryNumber": "JV-2027-000001",
  "postingRule": "JOURNAL_VOUCHER_POSTED@1",
  "event": "JOURNAL_VOUCHER_POSTED",
  "occurredAt": "2026-09-27",
  "status": "POSTED",
  "narration": "September rent and utilities paid from bank",
  "reference": "Landlord receipt 0912",
  "sourceType": "journal_voucher",
  "sourceId": "uuid",
  "reversalOf": null,
  "reversedBy": null,
  "reversalReason": null,
  "lines": [
    { "lineNumber": 1, "accountId": "uuid", "debit": "45000.0000", "credit": "0.0000", "partyId": null, "memo": "September rent" },
    { "lineNumber": 2, "accountId": "uuid", "debit": "0.0000", "credit": "45000.0000", "partyId": null, "memo": null }
  ]
}
```

`404 entry_not_found` for an unknown id, a malformed id, or another tenant's real id — identical in
every case (reversal.md §3 row 1).

### `POST /api/journals` — post a journal voucher

**Permission:** `voucher.post` · **Header:** `Idempotency-Key` (required)

```json
{
  "occurredAt": "2026-09-27",
  "narration": "September rent and utilities paid from bank",
  "reference": "Landlord receipt 0912",
  "lines": [
    { "accountId": "uuid", "debit": "45000.0000", "memo": "September rent" },
    { "accountId": "uuid", "credit": "45000.0000" }
  ]
}
```

Body schema (`.strict()`): `occurredAt` (string, `YYYY-MM-DD` shape), `narration` (string), `reference`
(string ≤ 100 or `null`, optional), `lines` (non-empty array). The API layer checks only the envelope
shape; line-level content (exactly one side per line, scale, sign, balance, account eligibility — see
`docs/posting-rules/journal-voucher.md` §3) is validated by the kernel and surfaces as the matching
`PostingErrorCode` in §7, not a generic zod message. **An unknown top-level key is `400
validation_failed`.**

`referenceType`/`referenceId` are never accepted from the client: the controller sets
`referenceType: 'journal_voucher'` and generates `referenceId` server-side (a fresh uuid) before
calling `postingEngine.post`, exactly as `journal-voucher.md` §2 specifies.

Response `200` (both outcomes — see Decisions below):

```json
{
  "outcome": "POSTED",
  "id": "uuid",
  "entryNumber": "JV-2027-000001",
  "postingRule": "JOURNAL_VOUCHER_POSTED@1",
  "event": "JOURNAL_VOUCHER_POSTED",
  "occurredAt": "2026-09-27",
  "status": "POSTED",
  "narration": "…",
  "reference": "…",
  "sourceType": "journal_voucher",
  "sourceId": "uuid",
  "reversalOf": null,
  "reversedBy": null,
  "reversalReason": null,
  "lines": [ "...same shape as GET /api/journals/:id" ]
}
```

`outcome` is `"POSTED"` the first time and `"REPLAYED"` on an idempotent retry — same body otherwise,
so a client that only reads `entryNumber`/`lines` cannot tell the difference, and a client that cares
can branch on `outcome`.

### `POST /api/journals/:id/reverse`

**Permission:** `voucher.reverse` · **Header:** `Idempotency-Key` (required)

```json
{ "reason": "Posted to the wrong bank account" }
```

Body schema (`.strict()`): `reason` (non-empty string after trim, ≤ 500 chars — the kernel re-checks
and owns the authoritative rejection, `REVERSAL_REASON_REQUIRED`).

Response `200`, the reversal entry `R` in the same shape as `POST /api/journals`, plus:

```json
{
  "...": "as above, for R",
  "disclosure": {
    "originalPeriod": "2026-08",
    "originalPeriodStatus": "CLOSED"
  }
}
```

`disclosure` is `null` when `R` took `E`'s own date (`E`'s period was still open — reversal.md §4);
present when `R` was dated today because `E`'s period had closed.

`404 entry_not_found` for an unknown/foreign id (never a 403 — existence is not disclosed).
`409 REVERSAL_VIA_SOURCE_REQUIRED` if `id` names a document-sourced entry — not reachable in M2 (no
document module posts yet) but specified because the kernel error exists and the mapping is generic.

---

## 3. Ledger

### `GET /api/ledgers/:accountId`

**Permission:** `report.financial`

Query: `from`, `to` (`YYYY-MM-DD`, both required, inclusive), `limit` (1–500, default 500 —
`LEDGER_PAGE_MAX`), `cursor` (opaque, from `nextCursor`). `partyId` is accepted but inert in M2: no
posting rule that carries a party is `IMPLEMENTED` yet (AR/AP lines cannot exist until M3), so passing
it filters to zero rows rather than erroring — documented so the M2-S lane does not have to special-case
it away.

```json
{
  "accountId": "uuid",
  "code": "1120",
  "name": "Bank — Current Account",
  "type": "ASSET",
  "openingBalance": "500000.0000",
  "closingBalance": "455000.0000",
  "lines": [
    {
      "lineId": "uuid",
      "entryId": "uuid",
      "entryNumber": "JV-2027-000001",
      "entryStatus": "POSTED",
      "occurredAt": "2026-09-01",
      "narration": "…",
      "sourceType": "journal_voucher",
      "sourceId": "uuid",
      "reversalOf": null,
      "reversedBy": null,
      "debit": "0.0000",
      "credit": "45000.0000",
      "runningBalance": "455000.0000"
    }
  ],
  "nextCursor": null
}
```

Running balance is signed, debit-positive (ledger-and-trial-balance.md §2) — a credit balance is a
negative string, e.g. `"-6000.0000"`.

`404 account_not_found` for an unknown or foreign `accountId`.

### The cursor carries no financial number (Council ruling, 2026-09-29)

`nextCursor` is opaque base64url JSON, decoded and validated in full on every use
(`apps/api/src/accounting/cursor.ts`):

```json
{
  "occurredAt": "2026-08-02", "createdAt": "2026-08-02T10:15:00.123456Z",
  "entryNumber": "JV-2027-000004", "lineNumber": 1,
  "issuedFor": { "accountId": "uuid", "from": "2026-08-01", "to": "2026-08-31", "partyId": null }
}
```

- **No `closingBalance` field, ever.** The first version of this endpoint trusted a client-supplied
  `closingBalance` round-tripped through the cursor to seed the next page's running balance — a client
  could forge it, and a resumed page would silently report a wrong balance for every line after the
  first. `packages/reporting`'s `accountLedger` now RECOMPUTES the carry-forward balance from the
  cursor's *position* alone (`accountLedgerBalanceThrough` in `packages/database`), every time. No
  balance travels in either direction except in the response body a caller already has permission to see.
- **Format-validated field by field**: `occurredAt`/`issuedFor.from`/`issuedFor.to` are real calendar
  dates, `createdAt` is a real ISO instant at microsecond precision, `entryNumber` matches the document
  number shape, `lineNumber` is a positive integer, `issuedFor.accountId`/`issuedFor.partyId` are uuid-
  shaped or null. Any failure is `400 invalid_cursor` — never a PostgreSQL type-cast 500.
- **Bound to the request that presented it.** `issuedFor` must equal the current `accountId` (path) and
  `from`/`to`/`partyId` (query) exactly. A cursor issued for a different account, or under a different
  date range or party filter, is `400 invalid_cursor` — the two failure modes (malformed vs.
  mismatched) are deliberately indistinguishable in the response, so a forger learns nothing either way.

The register cursor (`GET /api/journals`'s `nextCursor`) is validated the same way (format only — it
carries no `issuedFor`, since the register has no per-request resource context to bind to): `occurredAt`
a real date, `createdAt` a real ISO instant, `id` a real uuid.

---

## 4. Reports

### `GET /api/reports/trial-balance`

**Permission:** `report.financial`

Query: `asOf` (`YYYY-MM-DD`, required).

```json
{
  "asOf": "2026-09-27",
  "lines": [
    { "accountId": "uuid", "code": "1120", "name": "Bank — Current Account", "type": "ASSET", "debit": "455000.0000", "credit": "0.0000" }
  ],
  "totalDebit": "500000.0000",
  "totalCredit": "500000.0000"
}
```

The column follows the **sign of the balance**, never the account's normal side (ledger-and-trial-
balance.md §3). **Before responding, the controller asserts `totalDebit === totalCredit` (`Money.equals`,
exact, no tolerance).** If they ever disagree, that is Invariant 2 broken — reported as an uncaught
error (`500`, logged with full detail server-side, nothing about the discrepancy echoed to the caller)
and never smoothed into a "difference" field. This is CLAUDE.md's rule verbatim: never add a rounding
tolerance to get to green.

---

## 5. Chart of accounts

### `GET /api/accounts`

**Permission:** `account.view` (Council ruling, 2026-09-29 — `packages/permissions/src/catalog.ts`,
backfilled to every existing tenant by migration 014)

The full tree (headers and postable accounts), ordered by code. Build the tree client-side from
`parentId`.

```json
{
  "accounts": [
    { "id": "uuid", "code": "1000", "name": "Assets", "type": "ASSET", "normalBalance": "DEBIT", "kind": "HEADER", "controlKind": "NONE", "role": null, "restricted": false, "parentId": null, "isActive": true },
    { "id": "uuid", "code": "1110", "name": "Cash in Hand", "type": "ASSET", "normalBalance": "DEBIT", "kind": "POSTABLE", "controlKind": "NONE", "role": "CASH_DEFAULT", "restricted": false, "parentId": "uuid-of-1000", "isActive": true }
  ]
}
```

### `POST /api/accounts` — create a postable account (M2-C, 2026-09-29)

**Update, 2026-09-29 — Product Owner scope decision, Accounting seat amendment (coa-standard.md §5
amended, §8 added).** The read-only ruling above is superseded for create and edit. `POST /api/accounts`
and `PATCH /api/accounts/:id` are now built, per `coa-standard.md` §8 and this lane's (M2-C) delivery
brief. Deactivate stays Wave 2 remainder work (§8.4) and is still not built — there is no `isActive`
field on either request, and no delete, ever.

**Permission:** `account.manage` (Owner, Accountant — not Viewer; not privileged, no MFA step-up).
Added to the catalogue and backfilled to every existing tenant by migration 019
(`database/migrations/019_add_account_manage_permission.sql`).

**Not a posting — no Idempotency-Key.** coa-standard.md §8.7: a duplicate create fails the second time
on `ACCOUNT_CODE_TAKEN` (the unique code constraint); a duplicate edit fails on
`ACCOUNT_VERSION_CONFLICT`.

```json
// POST /api/accounts
{ "parentId": "uuid-of-6000", "name": "Security Services", "code": "6600" }
```

`type` and `normalBalance` are never request fields — inherited from the parent header, derived from
type. Response: the created `AccountDto` (§5's `GET /api/accounts` shape, now also carrying `version`).

```json
// PATCH /api/accounts/:id
{ "name": "Security and Guard Services", "expectedVersion": 0 }
```

Only `name`, `code`, `parentId`, `expectedVersion` — any other key is `400 payload_invalid` (or the
kernel's own `PAYLOAD_INVALID`, if it reaches the kernel). A protected account (header, role-holding,
control, or restricted) cannot be edited at all (`409 account_protected`). `code`/`parentId` freeze once
the account has a journal line (`409 account_has_postings`). See `coa-standard.md` §8.9 for the full
error list and evaluation order.

### `GET /api/accounts/suggest-code?parentId=`

**Permission:** `account.manage`. Advisory only (coa-standard.md §8.1) — reserves nothing, and the
submitted code is re-validated exactly like any typed code. `{ "code": "6600" }`, or `{ "code": null }`
if the header's block (all 999 codes) is exhausted.

**Where the code lives.** `chartOfAccounts.create` / `.update` / `.suggestCode`
(`packages/accounting-kernel/src/chart-of-accounts.ts`) hold the validation, the §8.9 evaluation order
and the audit write. This controller (`apps/api/src/accounting/accounts.controller.ts`) stays thin: DTO
in, kernel command out, `posting-error.mapper.ts` turns the kernel's typed rejection into HTTP.

**Known gap, reported not silently worked around (coa-standard.md §8.7 R2).** The database-privilege
half of "a crafted request cannot insert a header/control/role/restricted account" is not yet built — it
needs a `SECURITY DEFINER` seeding function owned by a dedicated `NOLOGIN`/`NOBYPASSRLS` database role
that this lane could not provision (`infrastructure/docker/postgres/init/00-bootstrap.sh` is outside its
`ALLOWED` paths). The application-layer half holds today: `chartOfAccounts.create` hardcodes
`kind='POSTABLE'`, `control_kind='NONE'`, `role=NULL`, `restricted=false` — there is no field through
which a request could ask for anything else. See `docs/TECH_DEBT.md` and this lane's report.

---

## 6. Fiscal periods

### `GET /api/periods`

**Permission:** `period.view`

Every fiscal period of the caller's tenant, chronological order.

```json
{
  "periods": [
    { "id": "uuid", "fiscalYear": 2027, "periodIndex": 1, "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "label": "2026-07", "status": "OPEN" }
  ]
}
```

### `POST /api/periods/:id/close`

**Permission:** `period.close`

`:id` is the period's uuid (from `GET /api/periods`); the controller resolves it to the label
`periodEngine.close` takes (`periods.md`'s API is by label) and never accepts a label directly from the
client. No request body. Returns the closed period, same shape as one row of `GET /api/periods`.

Only when every earlier period of the tenant is `CLOSED` or `LOCKED` (periods.md §4.1) —
`409 period_close_out_of_order` otherwise. Produces no journal entry (periods.md §7).

### `POST /api/periods/:id/reopen`

**Permission:** `period.reopen` — **Owner only** (Council ruling's role table, §"Permission ruling"
below). `period.close` does not imply `period.reopen`; Accountant holds the former, not the latter.

```json
{ "reason": "Correcting a close-process error" }
```

Only the tenant's **latest** `CLOSED` period may be reopened (periods.md §4.1) —
`409 period_reopen_out_of_order` for any other `CLOSED` period, `409 PERIOD_LOCKED` for a locked one.
A reason is required (kernel-enforced, `PERIOD_REOPEN_REASON_REQUIRED`, surfaced as `400
validation_failed` at the zod layer for an empty/missing one).

### No lock route

There is no `POST /api/periods/:id/lock` and no `period.lock` permission. The Council ruling that added
`account.view`/`period.view`/`period.close`/`period.reopen` was explicit: *"There is NO `period.lock`,
and NO lock route in M2: build view, close and reopen only."* `periodEngine.lock` exists in the kernel
(tested at the kernel level, `tests/accounting/period-transitions.spec.ts`) but nothing in `apps/api`
calls it.

### Permission ruling — the role grants

| Code | Owner | Accountant | Viewer |
|---|---|---|---|
| `account.view` | ✓ | ✓ | ✓ |
| `period.view` | ✓ | ✓ | ✓ |
| `period.close` | ✓ | ✓ | — |
| `period.reopen` | ✓ | — | — |

`period.close` and `period.reopen` are `PRIVILEGED_PERMISSIONS` (ADR-0012:136 names step-up MFA for
both) — enforcement is the same GAP-003 gap every other privileged permission has today; this only
records that the answer to "is this privileged" is yes.

### Backfill for existing tenants

`database/migrations/014_add_account_and_period_permissions.sql` inserts the four grants above into
every **existing** tenant's `is_system` roles, scoped per tenant by joining `roles` on `(code,
is_system)` within a single INSERT (the migration role holds `BYPASSRLS`, so this join — not RLS — is
what keeps tenant A's grant from reaching tenant B's role). `created_by`/`updated_by` on each new grant
is the owning role's own `created_by`. No `audit_log` row is written from SQL (would break the hash
chain — see the migration's own header). Idempotent by construction
(`role_permissions_active_unique`'s partial unique index is the `ON CONFLICT` target). A tenant
provisioned before or after migration 014 ends up with identical grants —
`tests/integration/accounting-api.spec.ts`'s "Permission backfill" suite proves it by re-running the
migration's own SQL text against a tenant seeded with the pre-ruling code list.

Migration 014 was the next free number; **M3's reservation moved from 014–016 to 015–017**
(`docs/BOARD.md`).

---

## 7. `PostingErrorCode` → HTTP

Every code below is quoted verbatim from `packages/accounting-kernel/src/errors.ts`. Only the codes
reachable through this lane's endpoints (journal voucher posting, reversal) are exercised by tests; the
rest are mapped for completeness/forward-compatibility since the mapper is generic over the whole type
and the next lane to call `postingEngine.post` for a different event needs no new mapping code.

| HTTP | Codes |
|---|---|
| **400** | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING`, `AMOUNT_SCALE`, `AMOUNT_NEGATIVE`, `AMOUNT_NON_POSITIVE`, `AMOUNT_OUT_OF_RANGE`, `NARRATION_REQUIRED`, `NARRATION_TOO_LONG`, `JV_TOO_FEW_LINES`, `JV_TOO_MANY_LINES`, `JV_LINE_BOTH_SIDES`, `JV_LINE_NO_SIDE`, `JV_ZERO_LINE`, `JV_SAME_ACCOUNT_BOTH_SIDES`, `JV_UNBALANCED`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_INACTIVE`, `ACCOUNT_CONTROL_MANUAL_FORBIDDEN`, `ACCOUNT_RESTRICTED`, `ACCOUNT_ROLE_UNMAPPED`, `ACCOUNT_ROLE_MISCONFIGURED`, `PARTY_NOT_FOUND`, `PARTY_TYPE_MISMATCH`, `DATE_IN_FUTURE`, `PERIOD_NOT_FOUND`, `REVERSAL_REASON_REQUIRED`, `PERIOD_REOPEN_REASON_REQUIRED`, `RULE_NOT_ENABLED`, `ACCOUNT_PARENT_NOT_HEADER`, `ACCOUNT_PARENT_TYPE_MISMATCH`, `ACCOUNT_CODE_FORMAT`, `ACCOUNT_CODE_OUT_OF_RANGE`, `ACCOUNT_NAME_INVALID` (M2-C, `POST/PATCH /accounts*`), plus every `SALE_*`/`CUSTOMER_*`/`RECEIPT_*`/`ALLOCATION_*`/`INVOICE_*` code (not reachable via this lane's routes) |
| **403** | `FORBIDDEN` (defensive only — `PermissionGuard` already rejects an unauthorised caller before the kernel runs; this is the kernel's own "no service account posts" backstop, rule 22) |
| **404** | `ENTRY_NOT_FOUND` (route: `GET/POST /journals/:id...`), `ACCOUNT_PARENT_NOT_FOUND` (M2-C — mapped globally in `posting-error.mapper.ts`, since no other rule raises it). `ACCOUNT_NOT_FOUND` is **400** when it names a line inside a posting body (journal-voucher.md), and the ledger endpoint's own account-existence check (against `findAccountsByIds`, not via `PostingError`) is **404**, because there the account *is* the route's addressed resource — BUT on `PATCH /accounts/:id`, the SAME `ACCOUNT_NOT_FOUND` code (the account named by the path parameter does not exist) is mapped to **404 locally, by `accounts.controller.ts`'s own catch block**, not by the shared mapper: `posting-error.mapper.ts` cannot key its map by route, only by code, and widening its global 400 to 404 would change the JV-body behaviour above. `accounts.controller.ts` special-cases `error.code === 'ACCOUNT_NOT_FOUND'` to `NotFoundException` before falling through to `mapPostingError`. Likewise `period_not_found` on `POST /periods/:id/{close,reopen}` is the CONTROLLER's own 404 (a `findPeriodById` miss on the path `:id`), never the kernel's own `PERIOD_NOT_FOUND` — the controller always resolves `:id` to a real label before calling `periodEngine`, so the kernel's `PERIOD_NOT_FOUND` never actually fires from these two routes |
| **409** | `PERIOD_CLOSED`, `PERIOD_LOCKED`, `IDEMPOTENCY_KEY_REUSED`, `SOURCE_ALREADY_POSTED`, `ALREADY_REVERSED`, `REVERSAL_OF_REVERSAL`, `REVERSAL_VIA_SOURCE_REQUIRED`, `PERIOD_CLOSE_OUT_OF_ORDER`, `PERIOD_REOPEN_OUT_OF_ORDER`, `PERIOD_LOCK_OUT_OF_ORDER` (not reachable — no lock route), `PERIOD_NOT_CLOSED`, `ACCOUNT_CODE_TAKEN`, `ACCOUNT_NAME_TAKEN`, `ACCOUNT_PROTECTED`, `ACCOUNT_HAS_POSTINGS`, `ACCOUNT_VERSION_CONFLICT` (M2-C) |

Rationale for the 400/404/409 split: 404 is reserved for "the resource this route addresses does not
exist in your tenant" (an entry id in the path, an account id in the path); everything else about an
invalid **request body** — including a line naming an account that does not exist — is 400, because the
thing that is wrong is the request, not a missing route resource; 409 is reserved for "the request is
individually valid but conflicts with the current state of something it names" (a closed period, an
already-reversed entry, a reused idempotency key with different content).

`error` in the response body is the `PostingErrorCode` lower-cased with underscores kept
(`jv_unbalanced`, `period_closed`, `entry_not_found`) — machine-stable and grep-able across client and
server logs. `details` is `PostingError.details` verbatim (already string-keyed, JSON-safe by
construction — `packages/accounting-kernel` never puts a `Money`/`Dec` object in there).

`KernelInvariantError` (a kernel *defect*, not a user's mistake — e.g. a rule built an unbalanced entry)
is **not** caught by this mapper and is left to fall through to `AllExceptionsFilter`, which turns it
into an opaque `500` and logs the real error server-side. Per `errors.ts`'s own header: *"it is never
caught and never corrected."* Converting it to a 4xx here would be exactly that.

---

## 8. Decisions

1. **`POST /journals` and `POST /journals/:id/reverse` return `200`, not `201`, for both `POSTED` and
   `REPLAYED`.** The operation is idempotent by design (ADR-0027) — a client retrying after a dropped
   response cannot know in advance which outcome it will get, and building retry logic against "200 on
   replay, 201 on first success" forces every caller to treat two response codes as equally successful
   anyway. `outcome` in the body is the one bit that actually varies, and it is explicit.
2. **`GET /journals` returns entry headers, not lines.** Lines are on `GET /journals/:id`, matching the
   register screen's own split (list → inspector). A register screen showing hundreds of entries does
   not need every entry's full line set fetched up front.
3. **`ACCOUNT_NOT_FOUND` is 400 when it comes from a JV line and 404 when it is the ledger route's own
   `:accountId`.** Same code, different HTTP status, because it means two different things depending on
   whether the account is the thing the route addresses or a fact buried in the request body. See §7.
4. **The `IdempotencyGuard`/replay contract does not distinguish "same key, same request, but the
   underlying period closed in between."** Per ADR-0027 and journal-voucher.md §7, a replay returns the
   original result regardless — this endpoint does not special-case it, because the kernel already
   doesn't.
5. **`partyId` is accepted but inert on the ledger endpoint** rather than rejected, so the M2-S screens
   lane can wire the control-account/customer-ledger UI now and have it start working the moment M3
   lands the customer module, with no API contract change. Flagged, not hidden — see §3.
6. **The ledger cursor carries no financial number** (Council ruling, 2026-09-29). `closingBalance` is
   gone from the wire shape entirely; `packages/reporting` recomputes a resumed page's carry-forward
   balance from the cursor's position on every request. See §3.
7. **`:id` on the two period routes is the period's uuid, not its label.** `periodEngine`'s own API
   takes a label (`YYYY-MM`); the controller resolves `:id → label` via `findPeriodById` before calling
   it, so the route stays consistent with `/journals/:id` (always the resource's own uuid) rather than
   asking the client to know the kernel's internal addressing.
8. **`deriveReferenceId`'s TECH_DEBT entry (TD-009)** records that the JV posting-identity fix
   (§2's `POST /journals`) is a kernel-shaped rule currently living in `apps/api` because this lane
   cannot touch `packages/accounting-kernel/src/**` — flagged for the Accounting seat, not hidden.

---

## 9. Council ruling status (was: open items for the Council/PO)

All three Council seats (Accounting: changes required · Security: approved with conditions ·
Architecture: rejected, narrowly) reviewed the branch at `3daed22` and returned a binding fix list,
2026-09-29. Status of each item that document originally raised:

1. **`period.view`, `period.close`, `period.reopen`, `account.view` are now in the catalogue** —
   `packages/permissions/src/catalog.ts`. Role assignment: see §6's table. `period.close`/
   `period.reopen` are `PRIVILEGED_PERMISSIONS`. **Closed.**
2. **`POST /api/accounts` stays Wave 2 remainder work** — the ruling did not amend `coa-standard.md`
   §5, so this item's recommended outcome stands. **Closed, as "stays not built."**
3. **`GET /api/periods`, `POST /api/periods/:id/close`, `POST /api/periods/:id/reopen` are built** —
   thin controllers over the existing, tested `periodEngine`, no kernel change. **Closed.** See §6.

Nothing is open here as of this document's current revision. Any future change to this contract lands
as a separate, clearly named commit, per this document's own opening instruction.

**Deferred to M3-P (Accounting seat, 2026-09-29).** The HTTP test for
`REVERSAL_VIA_SOURCE_REQUIRED` (409) is a **named M3-P acceptance item**. M2
cannot create a document-sourced entry without the lint-fenced raw insert;
M3-P's invoices create real ones. The refusal itself is already covered by
golden scenario P06 and the invariant suite, and the 409 mapping is in place.
