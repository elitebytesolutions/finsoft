# M2-B — Accounting HTTP API contract

**Lane:** M2-B · **Branch:** `feature/M2-B-accounting-api` · **Consumes:** `packages/accounting-kernel`,
`packages/reporting`, read-only additions to `packages/database/src/accounting/**`

This is the contract the M2-S screens lane builds against. It is pushed before any endpoint code, per
the M2-B brief. Later changes land as separate, clearly named commits on top of this one.

---

## 0. Status summary — read this first

| Outcome (from the brief) | Status |
|---|---|
| Post a journal voucher and reverse it | **Built** — §2 |
| See an account's ledger with a running balance | **Built** — §3 |
| Run a balanced trial balance | **Built** — §4 |
| View and add accounts in the chart of accounts | **Partially blocked** — §5. Viewing is specified below but not yet wired (no permission code — see §6). Adding an account is **not built**: it conflicts with an APPROVED posting rule and has no permission code. |
| See the fiscal periods, close/reopen where permitted | **Blocked** — §6. No permission code exists for any of the three actions. |

§6 is a **STOP AND ASK**, raised to the coordinator rather than guessed at, per this lane's own brief
("If a needed code is missing … STOP and ask me: the permission model is Council-owned. Do not invent
one") and per CLAUDE.md ("an invariant appears violated by existing code … two docs contradict each
other"). Endpoints 1 and 5 below are specified in full so the M2-S screens lane has the shape to build
against once the blocker clears, but **no route exists for them yet** — calling them 404s.

---

## 1. Conventions

- **Base path:** every route below is mounted under `/api` (`app.setGlobalPrefix('api')`).
- **Auth:** `Authorization: Bearer <access token>`, verified by `TenantGuard`. The tenant is the
  token's `tenantId` — never a header, body field or query string (rule 8). A request with no or
  invalid credentials gets `401`.
- **Permission:** every route below declares exactly one `@RequirePermission(code)` from
  `packages/permissions`' MVP catalogue. A caller lacking it gets `403`.
- **Validation:** every request body and query string is parsed by a `zod` schema via
  `ZodValidationPipe`, which **strips** any key the schema does not declare and rejects an unknown key
  in the schemas below that are `.strict()` with `400 validation_failed`. Money-shaped fields inside a
  posting payload (`lines[].debit`/`credit`) are left to the kernel's own validator rather than
  double-validated here, so the kernel's exact `PostingErrorCode` (not a generic zod message) is what
  a caller sees for a business-rule rejection — see §7.
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

## 5. Chart of accounts — SPECIFIED, NOT BUILT (see §6)

### `GET /api/accounts`

Would return the full tree (headers and postable accounts), ordered by code — `listAllAccounts` already
exists in `packages/database/src/accounting/accounts.ts` and needs no new query. Shape:

```json
{
  "accounts": [
    { "id": "uuid", "code": "1000", "name": "Assets", "type": "ASSET", "kind": "HEADER", "parentId": null, "isActive": true },
    { "id": "uuid", "code": "1110", "name": "Cash in Hand", "type": "ASSET", "kind": "POSTABLE", "controlKind": "NONE", "role": "CASH_DEFAULT", "restricted": false, "parentId": "uuid-of-1000", "isActive": true }
  ]
}
```

Not wired to a route — no permission code covers it (§6).

### `POST /api/accounts` — NOT SPECIFIED FURTHER, NOT BUILT

The brief asks for "create a postable leaf under a group." This is not just missing a permission code;
it conflicts with an APPROVED posting rule and has no backing capability at any layer:

- `coa-standard.md` §5: *"The MVP ships the chart **read-only** to users; create, rename and
  deactivate are Wave 2 remainder work, each audited."*
- Migration 010's own grants: `REVOKE INSERT, UPDATE ON accounts FROM finsoft_app` followed by a
  **column-scoped INSERT grant used only by tenant provisioning** (`seedChartOfAccounts`, which seeds
  the whole template atomically at tenant creation) — there is no UPDATE grant at all, and no code path
  for inserting one arbitrary account with business-rule validation (unique code/name, parent-header
  type match, role assignment rules).
- `packages/accounting-kernel`'s index does not export an account-creation function; its own header
  lists what is deliberately not exported and account creation is not present anywhere in the kernel.

Building this would mean inventing account-creation domain logic outside kernel/database boundaries
that this lane is not authorised to add. **Raised in BLOCKED, §6.**

---

## 6. Fiscal periods — BLOCKED, no route built

### `GET /api/periods`, `POST /api/periods/:id/close`, `POST /api/periods/:id/reopen`

Fully specified by `docs/posting-rules/periods.md` §4/§4.1 and implemented in the kernel
(`periodEngine.close/reopen/lock`, `packages/accounting-kernel/src/periods.ts`) — the capability
exists. **No route is built because no permission code exists for any of the three actions**, and this
lane is explicitly forbidden from changing `packages/permissions`' catalogue (Council-owned):

```
packages/permissions/src/catalog.ts:
  export const PERMISSION_CODES = [
    'customer.view', 'customer.create', 'invoice.create', 'invoice.post', 'payment.receive',
    'voucher.view', 'voucher.post', 'voucher.reverse', 'report.financial',
    'audit.view', 'admin.user_manage',
  ]
```

The file's own header comment confirms this is deliberate scoping, not an oversight: *"MVP SUBSET, NOT
THE FULL FUTURE CATALOGUE … lists a larger set (voucher.approve, bank.*, cheque.*, **period.***, …)."*
Chart-of-accounts viewing is absent from the same comment's MVP slice
(`login -> tenant membership -> permission check -> customer -> service invoice -> payment -> journal
entry -> customer ledger -> trial balance -> reversal -> audit trail`), which is further evidence this
was scoped out deliberately rather than missed.

**What would unblock this lane**, decided by the Council/PO, not guessed at here:

1. Add `period.view`, `period.close`, `period.reopen` (and `account.view`, if `GET /api/accounts` is
   wanted now rather than with account create/rename/deactivate in Wave 2) to
   `packages/permissions/src/catalog.ts`, decide which system role(s) hold them
   (`packages/permissions/src/system-roles.ts`), and decide whether they are `PRIVILEGED_PERMISSIONS`
   under ADR-0009 (`period.close`/`period.reopen` plausibly are, given MFA is named for both in
   `periods.md` §8 — currently deferred to GAP-003 regardless).
2. A ruling on `POST /api/accounts` specifically: either it stays Wave 2 remainder work as
   `coa-standard.md` §5 already says (recommended — nothing here argues for moving it earlier), or the
   Accounting seat amends `coa-standard.md` to bring it into M2 with its own validation rules written
   down, in which case it is new kernel/database scope, not an `apps/api` task.

Once (1) lands, `GET /api/periods` / `POST /api/periods/:id/{close,reopen}` are a same-shape, low-risk
addition: thin controllers over the already-built, already-tested `periodEngine`, no kernel change
needed. Deferred to a follow-up commit on this branch or a new lane, per direction.

---

## 7. `PostingErrorCode` → HTTP

Every code below is quoted verbatim from `packages/accounting-kernel/src/errors.ts`. Only the codes
reachable through this lane's endpoints (journal voucher posting, reversal) are exercised by tests; the
rest are mapped for completeness/forward-compatibility since the mapper is generic over the whole type
and the next lane to call `postingEngine.post` for a different event needs no new mapping code.

| HTTP | Codes |
|---|---|
| **400** | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING`, `AMOUNT_SCALE`, `AMOUNT_NEGATIVE`, `AMOUNT_NON_POSITIVE`, `AMOUNT_OUT_OF_RANGE`, `NARRATION_REQUIRED`, `NARRATION_TOO_LONG`, `JV_TOO_FEW_LINES`, `JV_TOO_MANY_LINES`, `JV_LINE_BOTH_SIDES`, `JV_LINE_NO_SIDE`, `JV_ZERO_LINE`, `JV_SAME_ACCOUNT_BOTH_SIDES`, `JV_UNBALANCED`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_INACTIVE`, `ACCOUNT_CONTROL_MANUAL_FORBIDDEN`, `ACCOUNT_RESTRICTED`, `ACCOUNT_ROLE_UNMAPPED`, `ACCOUNT_ROLE_MISCONFIGURED`, `PARTY_NOT_FOUND`, `PARTY_TYPE_MISMATCH`, `DATE_IN_FUTURE`, `PERIOD_NOT_FOUND`, `REVERSAL_REASON_REQUIRED`, `RULE_NOT_ENABLED`, plus every `SALE_*`/`CUSTOMER_*`/`RECEIPT_*`/`ALLOCATION_*`/`INVOICE_*` code (not reachable via this lane's routes) |
| **403** | `FORBIDDEN` (defensive only — `PermissionGuard` already rejects an unauthorised caller before the kernel runs; this is the kernel's own "no service account posts" backstop, rule 22) |
| **404** | `ENTRY_NOT_FOUND` (route: `GET/POST /journals/:id...`); `ACCOUNT_NOT_FOUND` is **400** when it names a line inside a posting body, but the ledger endpoint's own account-existence check (done in the controller against `findAccountsByIds`, not via `PostingError`) is **404**, because there the account *is* the route's addressed resource |
| **409** | `PERIOD_CLOSED`, `PERIOD_LOCKED`, `IDEMPOTENCY_KEY_REUSED`, `SOURCE_ALREADY_POSTED`, `ALREADY_REVERSED`, `REVERSAL_OF_REVERSAL`, `REVERSAL_VIA_SOURCE_REQUIRED` |

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

---

## 9. Open items for the Council / PO (§6 restated as an action list)

1. Approve `period.view`, `period.close`, `period.reopen` (and, if wanted now, `account.view`) into
   `packages/permissions/src/catalog.ts`, with role assignment and privileged-permission status decided.
2. Rule on whether `POST /api/accounts` moves into M2 scope (requires amending `coa-standard.md` §5,
   Accounting-seat-owned) or stays Wave 2 remainder work as already written.
3. Once (1) is decided, this lane (or a follow-up) adds `GET /api/periods`,
   `POST /api/periods/:id/close`, `POST /api/periods/:id/reopen` as thin controllers over the existing,
   tested `periodEngine` — no kernel change needed, small addition.
