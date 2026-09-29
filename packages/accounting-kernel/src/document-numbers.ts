import { assertIssuedTenantTx, assignTenantDocumentNumber, type TenantTx } from '@finsoft/database'
import { requirePostingActor } from './actor.ts'

/*
 * K7 — the kernel's TENANT-scope (life-of-tenant) document numbering
 * facility. ADR-0028 statement 7, C12; docs/design/M3/README.md §4 K7;
 * docs/design/M3/modules.md §10.
 *
 * ADR-0028 statement 7: "A module gets a document or master-code number
 * (INV, RCT, CUST) only from a kernel index export (K3, K7). It never calls
 * assignDocumentNumber or assignTenantDocumentNumber." Those two functions
 * are lint-fenced to packages/accounting-kernel and the database test suites
 * (eslint.config.mjs kernelOnlyCallSyntax) precisely so a module cannot reach
 * around this file — this is the one legitimate caller for the TENANT scope.
 *
 * Deliberately narrow: only the series this PR actually needs (CUST, M3-Q2)
 * is accepted. A future TENANT-scope series is a one-line addition here, not
 * a general escape hatch — the same discipline posting-engine.ts's RULES
 * table applies to FISCAL_YEAR series.
 */

const TENANT_SCOPE_SERIES = ['CUST'] as const
export type TenantScopeSeries = (typeof TENANT_SCOPE_SERIES)[number]

export interface DocumentNumbers {
  /**
   * Assign the next number of a TENANT-scope series, `{SERIES}-{NNNNNN}`
   * (e.g. `CUST-000001`). Row-locked (LOCK_REGISTRY 5a); a rolled-back
   * caller consumes no number (rule 12).
   */
  next(tx: TenantTx, options: { readonly series: TenantScopeSeries }): Promise<string>
}

async function next(
  tx: TenantTx,
  options: { readonly series: TenantScopeSeries },
): Promise<string> {
  // ADR-0028 statement 6 / ADR-0005 Compliance: no overload without tx, and a
  // hand-built handle throws.
  assertIssuedTenantTx(tx)
  if (!TENANT_SCOPE_SERIES.includes(options.series)) {
    throw new Error(
      `documentNumbers.next: "${String(options.series)}" is not a recognised TENANT-scope ` +
        `series (K7). Recognised: ${TENANT_SCOPE_SERIES.join(', ')}.`,
    )
  }
  const { tenantId, actorUserId } = requirePostingActor(tx)
  return assignTenantDocumentNumber(tx, tenantId, options.series, actorUserId)
}

export const documentNumbers: DocumentNumbers = { next }
