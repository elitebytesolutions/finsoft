import {
  assertIssuedTenantTx,
  assignDocumentNumber,
  assignTenantDocumentNumber,
  findPeriodForDate,
  type TenantTx,
} from '@finsoft/database'
import { requirePostingActor } from './actor.ts'
import { isIsoCalendarDate } from './dates.ts'
import { PostingError } from './errors.ts'

/*
 * K7 — the kernel's TENANT-scope (life-of-tenant) document numbering
 * facility — and K3, its FISCAL_YEAR-scope counterpart for a document series
 * raised by a module (`INV`, `RCT`). ADR-0028 statement 7, C12;
 * docs/design/M3/README.md §4 K3/K7; docs/design/M3/modules.md §10.
 *
 * ADR-0028 statement 7: "A module gets a document or master-code number
 * (INV, RCT, CUST) only from a kernel index export (K3, K7). It never calls
 * assignDocumentNumber or assignTenantDocumentNumber." Those two functions
 * are lint-fenced to packages/accounting-kernel and the database test suites
 * (eslint.config.mjs kernelOnlyCallSyntax) precisely so a module cannot reach
 * around this file — this is the one legitimate caller for both scopes.
 *
 * Deliberately narrow: only the series a module actually needs (`INV`, `RCT`
 * — M3-P; `CUST` — M3-C, K7, M3-Q2) are accepted. A future series is a
 * one-line addition here, not a general escape hatch — the same discipline
 * posting-engine.ts's RULES table applies to the kernel's OWN series (`JV`,
 * `JE`, `RV`), which this file never touches.
 *
 * K3 and the kernel's own numbering (assignDocumentNumber inside
 * runPostingPipeline, for the JE/JV/RV series) are TWO DIFFERENT COUNTERS on
 * the same `document_sequences` table, keyed by series. modules.md §4.1/§4.2
 * call K3 for the document's OWN number (`INV-2027-000001`) BEFORE calling
 * `postingEngine.post` for the entry's number (`JE-2027-000001`) in the SAME
 * transaction. If the posting that follows is rejected — most commonly
 * PERIOD_CLOSED, resolved independently inside runPostingPipeline against
 * the SAME occurredAt — the whole `withTenant` unit of work rolls back, and
 * PostgreSQL's transactional counter row (sequences.ts's header) returns the
 * `INV`/`RCT` number it had just issued along with everything else (rule 12:
 * "a rejected or rolled-back posting consumes no number"). K3 therefore does
 * NOT itself re-check the period's status — only that one covers the date,
 * which it needs to resolve the fiscal-year label. A CLOSED or LOCKED period
 * still has a label; the posting engine's own gate is what rejects it, and
 * that rejection unwinds K3's assignment along with the rest of the
 * transaction. This is the "same FY rule as the entry series" README §4
 * names for K3.
 */

const TENANT_SCOPE_SERIES = ['CUST'] as const
export type TenantScopeSeries = (typeof TENANT_SCOPE_SERIES)[number]

const FISCAL_YEAR_SCOPE_SERIES = ['INV', 'RCT'] as const
export type FiscalYearScopeSeries = (typeof FISCAL_YEAR_SCOPE_SERIES)[number]

export interface DocumentNumbers {
  /**
   * Assign the next number of a TENANT-scope series, `{SERIES}-{NNNNNN}`
   * (e.g. `CUST-000001`). Row-locked (LOCK_REGISTRY 5a); a rolled-back
   * caller consumes no number (rule 12).
   */
  next(tx: TenantTx, options: { readonly series: TenantScopeSeries }): Promise<string>

  /**
   * K3. Assign the next number of a FISCAL_YEAR-scope document series,
   * `{SERIES}-{FY}-{NNNNNN}` (e.g. `INV-2027-000001`, `RCT-2027-000001`),
   * for the fiscal year that covers `occurredAt`. Row-locked (LOCK_REGISTRY
   * 5a); a rolled-back caller consumes no number (rule 12). Throws
   * `PERIOD_NOT_FOUND` if no fiscal period covers `occurredAt` — the same
   * code `postingEngine.post` would raise moments later for the entry that
   * follows, surfaced here because K3 needs the period's fiscal-year label
   * to assign a number at all.
   */
  next(
    tx: TenantTx,
    options: { readonly series: FiscalYearScopeSeries; readonly occurredAt: string },
  ): Promise<string>
}

async function next(
  tx: TenantTx,
  options:
    | { readonly series: TenantScopeSeries }
    | { readonly series: FiscalYearScopeSeries; readonly occurredAt: string },
): Promise<string> {
  // ADR-0028 statement 6 / ADR-0005 Compliance: no overload without tx, and a
  // hand-built handle throws.
  assertIssuedTenantTx(tx)
  const { tenantId, actorUserId } = requirePostingActor(tx)

  if ((TENANT_SCOPE_SERIES as readonly string[]).includes(options.series)) {
    return assignTenantDocumentNumber(tx, tenantId, options.series, actorUserId)
  }
  if ((FISCAL_YEAR_SCOPE_SERIES as readonly string[]).includes(options.series)) {
    const { occurredAt } = options as { readonly occurredAt: unknown }
    if (!isIsoCalendarDate(occurredAt)) {
      throw new PostingError('PAYLOAD_INVALID', 'occurredAt must be a calendar date, YYYY-MM-DD.', {
        field: 'occurredAt',
      })
    }
    const period = await findPeriodForDate(tx, tenantId, occurredAt)
    if (!period) {
      throw new PostingError('PERIOD_NOT_FOUND', `No fiscal period covers ${occurredAt}.`, {
        occurredAt,
      })
    }
    return assignDocumentNumber(tx, tenantId, options.series, period.fiscalYear, actorUserId)
  }
  throw new Error(
    `documentNumbers.next: "${String(options.series)}" is not a recognised series. ` +
      `TENANT-scope (K7): ${TENANT_SCOPE_SERIES.join(', ')}. ` +
      `FISCAL_YEAR-scope (K3): ${FISCAL_YEAR_SCOPE_SERIES.join(', ')}.`,
  )
}

export const documentNumbers: DocumentNumbers = { next }
