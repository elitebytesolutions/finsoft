/*
 * AuthContext. ADR-0009, ADR-0023 (M1-A).
 *
 * The verified, server-asserted facts about the caller of an authenticated
 * request — established once, by the guard, from a signature-checked JWT
 * claim (never from a request body, query string, header or cookie other
 * than the session). Everything downstream reads this rather than trusting
 * anything the client sent.
 *
 * Deliberately does NOT carry a permissions array. `packages/permissions`
 * (the RBAC lane) resolves permissions server-side, per request, against
 * `permissionVersion` and the database — the token's claims are an
 * optimisation for revocation staleness, never the authority (ADR-0009:128).
 * Putting permissions here would tempt a caller into trusting a snapshot
 * that is up to fifteen minutes stale for a privilege reduction.
 */
export interface AuthContext {
  readonly userId: string
  readonly tenantId: string
  readonly sessionId: string
  /** ADR-0009:102. Bumped when roles change; a stale token is refused at the guard. */
  readonly permissionVersion: number
  /** Whether this session completed MFA. */
  readonly mfa: boolean
}

// M3-C: modules/customers response types. docs/design/M3/api-contract.md §4.1.
export type {
  Customer,
  CustomerLedger,
  CustomerLedgerLine,
  CustomerListItem,
  CustomerListPage,
  Instant,
  LocalDate,
} from './customer.ts'
