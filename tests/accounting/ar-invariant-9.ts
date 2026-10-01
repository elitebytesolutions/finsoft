import { sql } from 'kysely'
import { assertIssuedTenantTx, resolveAccountsByRole, type TenantTx } from '@finsoft/database'
import { Money } from '@finsoft/validation'

/*
 * Invariant 9, AR half. docs/posting-rules/customer-receipt.md §8, verbatim:
 *
 *   GL(C, D)  = Σ (debit − credit) over journal lines on the AR_CONTROL account
 *               with party C and occurred_at ≤ D        — every entry, POSTED or REVERSED
 *
 *   SUB(C, D) = Σ netAmount of C's invoices posted on or before D
 *             − Σ netAmount of C's invoices whose reversal is dated on or before D
 *             − Σ amount of C's receipts posted on or before D
 *             + Σ amount of C's receipts whose reversal is dated on or before D
 *
 *   GL(C, D) = SUB(C, D)                                  exactly, no tolerance
 *   Σ over C of GL(C, D) = AR_CONTROL balance at D        (structural: README §4.1)
 *
 * THIS FILE IS WRITTEN AGAINST A SCHEMA THAT DOES NOT YET EXIST ON THIS BRANCH.
 * `sales_invoices` and `customer_receipts` are M3-P's migrations (016, 017 —
 * docs/design/M3/README.md §2), and SALE_POSTED / CUSTOMER_PAYMENT_RECEIVED
 * are RULE_NOT_ENABLED until M3-P flips packages/accounting-kernel/src/events.ts.
 * Column names and the reversal join below follow
 * docs/design/M3/modules.md §7 exactly, so this is ready to run the moment
 * both land — but it has NEVER RUN AGAINST REAL ROWS, because none exist yet
 * on this branch (M3-P's branch carries no commits beyond develop as of
 * 2026-09-29 — see the M3-Q report). `invariant9Available` is the gate: every
 * caller checks it first, and nothing here is trusted until it returns true
 * AND a real run has been observed (which is what flips invariants.ts and
 * pending-baseline.json, by hand, in a dedicated commit — never automatically).
 *
 * `DRAFT` and `CANCELLED` receipts, and `PROPOSED` allocations, contribute to
 * neither side, by construction: only rows with status IN ('POSTED',
 * 'REVERSED') are summed, and the allocations tables are never read here at
 * all (the formula does not need them — it works from the documents'
 * own netAmount/amount and the kernel's reversal linkage, exactly as §8
 * states).
 */

export interface Invariant9Row {
  readonly customerId: string
  /** GL side: Σ(debit − credit) on AR_CONTROL for this party, signed debit-positive. */
  readonly gl: string
  /** Subledger side, per §8's formula. */
  readonly sub: string
  /** sub − gl. Zero when the invariant holds. */
  readonly difference: string
}

export interface Invariant9Result {
  readonly asOf: string
  /** Every customer with a nonzero GL or SUB balance; empty rows are not reported. */
  readonly rows: readonly Invariant9Row[]
  /** Rows where gl !== sub, exactly. Empty = the invariant holds. */
  readonly breaks: readonly Invariant9Row[]
  /**
   * Σ GL(C, D) — the sum of the SAME per-customer `gl` figures already in
   * `rows`. NOT an independent number: re-summing a partition of a set
   * always equals the sum of that set, whatever the set contains. Useful
   * only as an internal-consistency cross-check against `accountBalance`
   * below (a mismatch between the two means some line reached the
   * AR_CONTROL account without a `party_type = 'CUSTOMER'` line — see that
   * field's own comment). NEVER pass this to
   * `reconcileSubledgerToGeneralLedger` as the GL side — Accounting seat
   * review, 2026-09-29: doing so compares a number with itself and can
   * never fail. Use `accountBalance` for that.
   */
  readonly totalGl: string
  /**
   * The AR_CONTROL account's balance, read DIRECTLY — one query against
   * `journal_lines` by `account_id`, no `party_type`/`party_id` filter of
   * any kind. This is the figure `Σ over C of GL(C, D) = AR_CONTROL
   * balance at D` (customer-receipt.md §8, structural half) is actually
   * checking: an INDEPENDENT read of the account, not a re-derivation of
   * `totalGl`. THIS is what `reconcileSubledgerToGeneralLedger` must
   * receive as the GL side.
   */
  readonly accountBalance: string
}

const REQUIRED_TABLES = ['sales_invoices', 'customer_receipts'] as const
const REQUIRED_EVENTS = ['SALE_POSTED', 'CUSTOMER_PAYMENT_RECEIVED'] as const

/**
 * Feature-detection gate. True only once BOTH preconditions the AR half of
 * `tests/reconciliation/dormant.spec.ts` re-arms on have fired for real:
 * the document tables exist, and the kernel accepts both events. Checking
 * table existence via `to_regclass` rather than trying the query and
 * catching "relation does not exist" — the intent (never run without
 * looking) should read from the function, not from a caught error.
 */
export async function invariant9Available(tx: TenantTx): Promise<boolean> {
  assertIssuedTenantTx(tx)
  /*
   * A plain bound parameter, not sql.lit/sql.id (ADR-0013): to_regclass()
   * takes its argument as an ordinary text value, exactly like any other
   * function parameter — there is no identifier being substituted into the
   * query's structure here, only a value being compared inside Postgres's
   * own catalog function.
   */
  const rows = await sql<{ regclass: string | null }>`
    SELECT to_regclass(${`public.${REQUIRED_TABLES[0]}`})::text AS regclass
  `.execute(tx)
  const first = rows.rows[0]?.regclass !== null
  if (!first) return false
  const rows2 = await sql<{ regclass: string | null }>`
    SELECT to_regclass(${`public.${REQUIRED_TABLES[1]}`})::text AS regclass
  `.execute(tx)
  if (rows2.rows[0]?.regclass === null) return false

  const { IMPLEMENTED_EVENTS } = await import('@finsoft/accounting-kernel')
  return REQUIRED_EVENTS.every((event) => IMPLEMENTED_EVENTS.has(event as never))
}

/**
 * The GL side, every customer of the tenant, as of `asOf`. Independent of
 * `SUB` below: no join to `sales_invoices` or `customer_receipts` at all —
 * only `journal_lines`/`journal_entries`, matching `partyControlBalance`
 * (packages/database) in shape but swept over every party rather than one.
 */
async function glByCustomer(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<Map<string, { debit: string; credit: string }>> {
  const result = await sql<{ customer_id: string; debit: string; credit: string }>`
    SELECT jl.party_id::text AS customer_id,
           sum(jl.debit)::text  AS debit,
           sum(jl.credit)::text AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     WHERE jl.tenant_id = ${tenantId}
       AND jl.account_control = 'AR'
       AND jl.party_type = 'CUSTOMER'
       AND je.occurred_at <= ${asOf}::date
     GROUP BY jl.party_id
  `.execute(tx)
  return new Map(
    result.rows.map((row) => [row.customer_id, { debit: row.debit, credit: row.credit }]),
  )
}

/**
 * The subledger side, every customer, as of `asOf` — §8's formula exactly.
 * A document's reversal date is found the way modules.md §7 says it must be
 * (no journal pointer stored on the document): the document's own
 * `(source_type, source_id)` finds the ORIGINAL entry via the kernel's
 * unique index, and the original's `reversed_by` finds the reversal entry,
 * whose `occurred_at` is the date §8 means by "whose reversal is dated".
 * Never `reversed_at` (a timestamp of the reversal ACTION, not necessarily
 * the reversal entry's business date — reversal.md §4: a closed-period
 * original reverses at TODAY, not at the original's date).
 */
async function subByCustomer(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<Map<string, string>> {
  const result = await sql<{ customer_id: string; sub: string }>`
    WITH invoices AS (
      SELECT si.customer_id,
             coalesce(sum(si.net_amount) FILTER (WHERE si.invoice_date <= ${asOf}::date), 0)
               AS posted,
             coalesce(sum(si.net_amount) FILTER (WHERE rev.occurred_at <= ${asOf}::date), 0)
               AS reversed
        FROM sales_invoices si
        LEFT JOIN journal_entries orig
          ON orig.tenant_id = si.tenant_id
         AND orig.source_type = 'sales_invoice'
         AND orig.source_id = si.id
        LEFT JOIN journal_entries rev
          ON rev.tenant_id = si.tenant_id
         AND rev.id = orig.reversed_by
       WHERE si.tenant_id = ${tenantId}
         AND si.status IN ('POSTED', 'REVERSED')
       GROUP BY si.customer_id
    ),
    receipts AS (
      SELECT cr.customer_id,
             coalesce(sum(cr.amount) FILTER (WHERE cr.receipt_date <= ${asOf}::date), 0)
               AS posted,
             coalesce(sum(cr.amount) FILTER (WHERE rev.occurred_at <= ${asOf}::date), 0)
               AS reversed
        FROM customer_receipts cr
        LEFT JOIN journal_entries orig
          ON orig.tenant_id = cr.tenant_id
         AND orig.source_type = 'customer_receipt'
         AND orig.source_id = cr.id
        LEFT JOIN journal_entries rev
          ON rev.tenant_id = cr.tenant_id
         AND rev.id = orig.reversed_by
       WHERE cr.tenant_id = ${tenantId}
         AND cr.status IN ('POSTED', 'REVERSED')
       GROUP BY cr.customer_id
    )
    SELECT customer_id,
           (coalesce(i.posted, 0) - coalesce(i.reversed, 0)
            - coalesce(r.posted, 0) + coalesce(r.reversed, 0))::text AS sub
      FROM (
        SELECT customer_id FROM invoices
        UNION
        SELECT customer_id FROM receipts
      ) all_customers
      LEFT JOIN invoices i USING (customer_id)
      LEFT JOIN receipts r USING (customer_id)
  `.execute(tx)
  return new Map(result.rows.map((row) => [row.customer_id, row.sub]))
}

/**
 * The AR_CONTROL account's balance, read directly — `resolveAccountsByRole`
 * to find the one account (K5's own role-resolution, TD-011 accepted), then
 * a single sum over `journal_lines` by `account_id`, WITH NO PARTY FILTER
 * OF ANY KIND. This is deliberately NOT `glByCustomer`'s query (which
 * filters `party_type = 'CUSTOMER'`, a filter that is redundant only
 * because migration 012's CHECK constraint already ties `account_control =
 * 'AR'` to `party_type = 'CUSTOMER'` — redundant today, but this function
 * exists so the check does not rely on that constraint holding forever, and
 * so it is a genuinely independent read of the account rather than a
 * second way of computing the same party-grouped sum).
 */
export async function arControlAccountBalance(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<string> {
  assertIssuedTenantTx(tx)
  const accounts = await resolveAccountsByRole(tx, tenantId, ['AR_CONTROL'])
  const account = accounts.get('AR_CONTROL')

  /*
   * Accounting seat ruling, 2026-10-01 (rejecting this lane's first
   * attempt): NEVER return zero by default when no account resolves the
   * AR_CONTROL role. Returning zero there is exactly the flaw Invariant 9
   * exists to catch wearing a different hat — it would silently hide a
   * real AR balance sitting on an account whose ROLE mapping is missing
   * or misconfigured while its `control_kind` is still 'AR' (TD-011: a
   * tenant could in principle hold more than one AR-control account, and
   * role resolution finds only one by design). The role lookup above is
   * the FAST, common path; this is the fallback that makes the function
   * independent of role resolution ever having succeeded at all — it sums
   * every journal line on EVERY account whose control_kind is 'AR' for
   * this tenant, by account_control (a denormalised copy of accounts.
   * control_kind onto every line, migration 012), not by account_id.
   */
  const result = account
    ? await sql<{ debit: string; credit: string }>`
        SELECT coalesce(sum(jl.debit), 0)::text  AS debit,
               coalesce(sum(jl.credit), 0)::text AS credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
         WHERE jl.tenant_id = ${tenantId}
           AND jl.account_id = ${account.id}
           AND je.occurred_at <= ${asOf}::date
      `.execute(tx)
    : await sql<{ debit: string; credit: string }>`
        SELECT coalesce(sum(jl.debit), 0)::text  AS debit,
               coalesce(sum(jl.credit), 0)::text AS credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
         WHERE jl.tenant_id = ${tenantId}
           AND jl.account_control = 'AR'
           AND je.occurred_at <= ${asOf}::date
      `.execute(tx)
  const row = result.rows[0] ?? { debit: '0', credit: '0' }
  return Money.serialize(Money.subtract(Money.from(row.debit), Money.from(row.credit)), 4)
}

/*
 * Accounting seat ruling, 2026-10-01: an EXPLICIT, NAMED allowlist of
 * tenants a known test harness creates by posting AR_CONTROL journal
 * lines WITHOUT ever creating the matching document — never "skip any
 * tenant with no subledger activity", which was REJECTED for hiding the
 * exact break Invariant 9 exists to catch (AR in the GL with no document
 * behind it). Identified by tenant CODE PREFIX, not by behaviour:
 * `createTenantFixture` (packages/database/src/testing/harness.ts) builds
 * a tenant's `code` as `T${label}${unique()}`.slice(0, 16)`. A tenant
 * matching one of these prefixes is excluded BY NAME; any other tenant
 * with an AR GL line and no documents still fails the sweep, which is the
 * whole point (see the negative test in financial-invariant-suite.spec.ts
 * proving exactly that).
 *
 * Two sources, each grepped across tests/, database/ and modules/ to
 * confirm no OTHER file uses the same label prefix:
 *
 *   'TKR'       — tests/accounting/kernel-rules.spec.ts (a file this lane
 *                 does not own and must not edit), labels 'KR'/'KR2'.
 *                 Posts a SALE_POSTED entry through the kernel's internal
 *                 pipeline directly (`runPostingPipeline`), by its own
 *                 comment "test-only... not a path any caller has", with
 *                 a synthetic `randomUUID()` source id.
 *
 *   'TM3RUNNER' — tests/accounting/golden-posting-runner-m3.spec.ts (this
 *                 lane's OWN file), label 'M3RUNNER' throughout: its
 *                 hand-built R1-R4/customer-verb/draft-lifecycle scenarios,
 *                 AND its "P12 against the fake port" test, which
 *                 deliberately runs the REAL P12 golden file's steps
 *                 through `createFakeReceivablesPort` — a kernel-only
 *                 stand-in with the SAME property: it posts SALE_POSTED/
 *                 CUSTOMER_PAYMENT_RECEIVED through the kernel directly,
 *                 never writing a `sales_invoices`/`customer_receipts`
 *                 row. That test overrides the golden file's own
 *                 "GOLDEN_A" tenant alias to "M3RUNNER" IN MEMORY ONLY —
 *                 never on disk — specifically so its tenant is
 *                 distinguishable by code from a REAL module run of the
 *                 SAME file, which also uses "GOLDEN_A" and must NOT be
 *                 exempt (reusing the SAME label as R1-R4, rather than a
 *                 distinct "M3RUNNERP12", keeps `createTenantFixture`'s
 *                 16-character code truncation from leaving this one
 *                 fixture with far less random suffix than the others —
 *                 found causing exactly the `tenants_code_key` collision
 *                 this harness is already prone to, worse).
 *
 * In both cases these are fake/kernel-only test doubles proving RUNNER
 * LOGIC, not module or production behaviour — structurally impossible
 * through any real path, where `modules/receivables` always creates the
 * document first.
 *
 * M2-C merge addendum, 2026-10-01: two more, found when this sweep first
 * ran for real against the FULL `npm run test:gate` (`database/tests`
 * shares the same test database with this file within one gate run, and
 * runs first). Both predate M3-P/M3-Q and this lane equally — pre-existing
 * `database/tests` coverage of migration 012's own CHECK/FK shape, posting
 * directly to the `AR_CONTROL` account (code `1200`) by raw SQL with a
 * real, registered `CUSTOMER` party but never a `sales_invoices` row, the
 * same structural pattern as `'TKR'` above:
 *
 *   'TJLP' — database/tests/journal-lines.spec.ts, label 'JLP'
 *            ("journal_lines: party / control pairing (ADR-0026)"). Its
 *            one committed AR line (10.0000 Dr, "accepts the positive
 *            controls") is what this addendum closes; every OTHER posting
 *            attempt in that describe block is rejected (23503/23514) and
 *            so never commits.
 *   'TJLK' — database/tests/journal-lines.spec.ts, label 'JLK'
 *            ("accounts.control_kind is pinned once posted to"). One
 *            committed AR line (25.0000 Dr), `beforeAll`, used only to
 *            give the account a journal line before testing that
 *            `control_kind` cannot then change.
 *   'TSUB' — database/tests/reporting.integration.spec.ts, label 'SUB'
 *            ("customerSubledgerBalance > nets AR-control lines for one
 *            party") — proves `customerSubledgerBalance`'s own query
 *            logic (packages/reporting) against hand-posted AR lines
 *            (800.0000 Dr, 300.0000 Cr), a unit-level test of a query,
 *            not a posting-rule or module behaviour.
 *
 * Grepped the same way as 'TKR'/'TM3RUNNER' above
 * (`accountControl: 'AR'` across tests/, database/, modules/) to confirm
 * no other file shares these label prefixes.
 */
const TEST_ONLY_TENANT_CODE_PREFIXES = ['TKR', 'TM3RUNNER', 'TJLP', 'TJLK', 'TSUB'] as const

export function isTestOnlyKernelPostingTenant(code: string): boolean {
  return TEST_ONLY_TENANT_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
}

/**
 * The pure comparison, extracted so it is unit-testable with synthetic
 * `gl`/`sub` maps and no database at all — see
 * `ar-invariant-9-rows.spec.ts`'s "wrong party" case, which this function
 * makes provable without a live `sales_invoices`/`customer_receipts` table
 * (neither exists on this branch) and without violating migration 012's
 * CHECK constraint (which makes a genuine "AR line with no party" row
 * impossible to construct even as the migration role — see that spec
 * file's own header for why the two negative tests take different forms).
 */
export function computeInvariant9Rows(
  gl: ReadonlyMap<string, { readonly debit: string; readonly credit: string }>,
  sub: ReadonlyMap<string, string>,
): { readonly rows: readonly Invariant9Row[]; readonly totalGl: string } {
  const customerIds = new Set([...gl.keys(), ...sub.keys()])
  const rows: Invariant9Row[] = []
  let totalGl = Money.zero()

  for (const customerId of customerIds) {
    const glEntry = gl.get(customerId)
    const glSigned = glEntry
      ? Money.subtract(Money.from(glEntry.debit), Money.from(glEntry.credit))
      : Money.zero()
    const subSigned = Money.from(sub.get(customerId) ?? '0')
    totalGl = Money.add(totalGl, glSigned)
    rows.push({
      customerId,
      gl: Money.serialize(glSigned, 4),
      sub: Money.serialize(subSigned, 4),
      difference: Money.serialize(Money.subtract(subSigned, glSigned), 4),
    })
  }

  rows.sort((a, b) => a.customerId.localeCompare(b.customerId))
  return { rows, totalGl: Money.serialize(totalGl, 4) }
}

/**
 * Invariant 9, AR half, for one tenant as of `asOf`. Caller must have
 * checked `invariant9Available` first — this throws (a real Postgres
 * "relation does not exist" error) rather than guessing, if it has not.
 */
export async function checkInvariant9(
  tx: TenantTx,
  tenantId: string,
  asOf: string,
): Promise<Invariant9Result> {
  assertIssuedTenantTx(tx)
  const [gl, sub, accountBalance] = await Promise.all([
    glByCustomer(tx, tenantId, asOf),
    subByCustomer(tx, tenantId, asOf),
    arControlAccountBalance(tx, tenantId, asOf),
  ])

  const { rows, totalGl } = computeInvariant9Rows(gl, sub)

  return {
    asOf,
    rows,
    breaks: rows.filter((row) => row.gl !== row.sub),
    totalGl,
    accountBalance,
  }
}
