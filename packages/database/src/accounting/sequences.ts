import { sql } from 'kysely'
import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'

/*
 * Server-side document numbering. NON_NEGOTIABLES rule 12, migration
 * 013_create_document_sequences.sql, PO decision K7, docs/LOCK_REGISTRY.md
 * position 5c.
 *
 * Two scopes (013's header):
 *   FISCAL_YEAR  SERIES-FY-NNNNNN   JV-2027-000001   reset each fiscal year
 *   TENANT       SERIES-NNNNNN      CUST-000001      one series for life (K7)
 *
 * Each scope is ONE atomic UPSERT against that scope's own partial unique
 * index, named as the ON CONFLICT arbiter by its column list AND its WHERE
 * predicate (PostgreSQL infers a partial index only when the predicate is
 * given). Two partial indexes cannot both arbitrate one statement, so the
 * scope decides which statement runs — never a read-then-write in
 * application code. Concurrent callers for the same counter serialise on the
 * conflicting row: the first-ever pair races to INSERT, the loser waits on
 * the winner's index entry and then takes the UPDATE path against the
 * committed row. Duplicates are impossible. The counter is a row, not a
 * SEQUENCE, so its increment is transactional: a caller that rolls back (its
 * transaction or an enclosing savepoint) returns its number, and a rejected
 * or rolled-back posting consumes none (README §4). A gap arises only if a
 * caller COMMITS an assignment without committing the numbered document —
 * which is why these functions are lint-fenced to the kernel (eslint
 * finsoft/kernel-only-numbering).
 */

const SERIES_PATTERN = /^[A-Z]{2,10}$/

/** Zero-padded to six digits; a seventh digit appears only past 999999, never a wrap. */
const NUMBER_WIDTH = 6

function assertSeries(series: string): void {
  if (!SERIES_PATTERN.test(series)) {
    throw new Error(`document numbering: "${series}" is not a valid series (A-Z, 2-10 chars).`)
  }
}

function formatNumber(assigned: string | undefined, label: string): string {
  if (assigned === undefined) {
    throw new Error(`document numbering: UPSERT returned no row for ${label}.`)
  }
  return assigned.padStart(NUMBER_WIDTH, '0')
}

/**
 * Assign the next number of a FISCAL_YEAR-scoped series, formatted
 * `{SERIES}-{FY}-{NNNNNN}` (e.g. `JV-2027-000001`).
 */
export async function assignDocumentNumber(
  tx: TenantTx,
  tenantId: string,
  series: string,
  fiscalYear: number,
  actorUserId: string,
): Promise<string> {
  assertIssuedTenantTx(tx)
  assertSeries(series)
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 9999) {
    throw new Error(`assignDocumentNumber: fiscal year ${fiscalYear} is out of range.`)
  }

  const result = await sql<{ assigned: string }>`
    INSERT INTO document_sequences (tenant_id, series, scope, fiscal_year, created_by, updated_by)
    VALUES (${tenantId}, ${series}, 'FISCAL_YEAR', ${fiscalYear}, ${actorUserId}, ${actorUserId})
    ON CONFLICT (tenant_id, series, fiscal_year) WHERE fiscal_year IS NOT NULL
    DO UPDATE SET
      last_number = document_sequences.last_number + 1,
      updated_by  = EXCLUDED.updated_by,
      version     = document_sequences.version + 1
    RETURNING last_number AS assigned
  `.execute(tx)

  const padded = formatNumber(result.rows[0]?.assigned, `${series}/${fiscalYear}`)
  return `${series}-${fiscalYear}-${padded}`
}

/**
 * Assign the next number of a TENANT-scoped (life-of-tenant) series,
 * formatted `{SERIES}-{NNNNNN}` (e.g. `CUST-000001`). K7.
 */
export async function assignTenantDocumentNumber(
  tx: TenantTx,
  tenantId: string,
  series: string,
  actorUserId: string,
): Promise<string> {
  assertIssuedTenantTx(tx)
  assertSeries(series)

  const result = await sql<{ assigned: string }>`
    INSERT INTO document_sequences (tenant_id, series, scope, fiscal_year, created_by, updated_by)
    VALUES (${tenantId}, ${series}, 'TENANT', NULL, ${actorUserId}, ${actorUserId})
    ON CONFLICT (tenant_id, series) WHERE fiscal_year IS NULL
    DO UPDATE SET
      last_number = document_sequences.last_number + 1,
      updated_by  = EXCLUDED.updated_by,
      version     = document_sequences.version + 1
    RETURNING last_number AS assigned
  `.execute(tx)

  return `${series}-${formatNumber(result.rows[0]?.assigned, series)}`
}
