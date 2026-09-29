import { describe, expect, it } from 'vitest'
import * as customersIndex from '../../modules/customers/index.ts'
import * as customersPublished from '../../modules/customers/application/published.ts'

/*
 * C11 (ADR-0028): "snapshots the runtime export names of each module's
 * index.ts and published.ts. A change to it is an Architecture seat
 * review." Pinned as an explicit, named list rather than a Vitest snapshot
 * file — this codebase has no snapshot-file convention, and a diffable
 * array literal in the test itself is what every other "the exact set of
 * names" assertion here already does (e.g. schema.spec.ts's
 * MANDATORY_COLUMNS, database/tests/parties.spec.ts's trigger-name list).
 *
 * `Object.keys(namespace)` on an ES module namespace object contains only
 * RUNTIME bindings — `export type`/`export interface` never appear, so this
 * naturally excludes every type-only export the two files also carry.
 */

describe('module surface (C11): modules/customers', () => {
  it('index.ts exports exactly this set of runtime names', () => {
    const runtimeExports = Object.keys(customersIndex).sort()

    expect(runtimeExports).toEqual(
      [
        'CreateCustomerSchema',
        'CustomerError',
        'CustomerLedgerQuerySchema',
        'ListCustomersQuerySchema',
        'UpdateCustomerSchema',
        'VersionOnlySchema',
        'createCustomer',
        'customerDirectory',
        'customerErrorSlug',
        'deactivateCustomer',
        'decodeCustomerCursor',
        'encodeCustomerCursor',
        'getCustomer',
        'getCustomerLedger',
        'listCustomers',
        'reactivateCustomer',
        'statusForCustomerErrorCode',
        'toCustomerDto',
        'toCustomerLedgerDto',
        'toCustomerListItemDto',
        'toCustomerListPageDto',
        'updateCustomer',
      ].sort(),
    )
  })

  it('application/published.ts exports exactly this set of runtime names — the module surface receivables (M3-P) may see', () => {
    const runtimeExports = Object.keys(customersPublished).sort()

    expect(runtimeExports).toEqual(['CustomerDirectoryError'])
  })

  it('index.ts exports no repository and nothing from infrastructure/ (ADR-0028 statement 3)', () => {
    // A repository instance would be an object with methods like
    // `lockForUpdate`/`insert` — the composition root exports only the
    // BOUND use-case functions and the two plain values (customerDirectory,
    // the *Schema zod objects), never the CustomersRepository instance
    // itself.
    const values = Object.values(customersIndex)
    const suspiciousRepositoryShape = values.some(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        'lockForUpdate' in (v as object) &&
        'insert' in (v as object),
    )
    expect(suspiciousRepositoryShape).toBe(false)
  })
})
