import { resolveAccountsByRole, type AccountRow, type TenantTx } from '@finsoft/database'
import { accountLedger, type AccountLedgerOptions, type AccountLedgerResult } from './ledger.ts'

/*
 * K5 — the party-filtered ledger read. ADR-0028 C12; docs/design/M3/README.md
 * §4 K5: "account ledger of a role for one party over [from, to]".
 *
 * `accountLedger` (ledger.ts) already accepts a `partyId` filter — that half
 * of K5 is M2-A's. What was still missing is the ROLE half: a caller of K5
 * names AR_CONTROL/AP_CONTROL, not an accountId, because a module has no
 * business resolving a chart-of-accounts role itself (that is exactly the
 * "role -> account" policy `packages/accounting-kernel/src/rules/roles.ts`
 * exists to keep out of callers). This file is the one place that
 * translates a control kind into the tenant's resolved account and then
 * delegates to `accountLedger` — so `modules/customers` (and, later,
 * `modules/vendors`) calls ONE function and never touches
 * `resolveAccountsByRole` itself.
 *
 * Lives in packages/reporting, not packages/accounting-kernel: this is a
 * READ, not a posting-truth write, and ADR-0028 statement 5 lists
 * `@finsoft/reporting` (read-only ledger queries) as a module's allowed
 * dependency precisely so reads do not have to go through the kernel index.
 * `resolveAccountsByRole` is itself exported from `@finsoft/database`'s
 * root, which module infrastructure may already import — this file adds no
 * new privilege, it only keeps the role-resolution policy in one place
 * instead of every caller duplicating requireResolvedRole-shaped logic.
 */

export type ControlKind = 'AR' | 'AP'

const ROLE_OF: Readonly<Record<ControlKind, string>> = {
  AR: 'AR_CONTROL',
  AP: 'AP_CONTROL',
}

/** Same shape/spirit as the kernel's ACCOUNT_ROLE_UNMAPPED — a tenant configuration fault. */
export class ControlAccountUnmappedError extends Error {
  readonly code = 'ACCOUNT_ROLE_UNMAPPED'
  readonly role: string
  constructor(role: string) {
    super(`No active account holds the ${role} role.`)
    this.name = 'ControlAccountUnmappedError'
    this.role = role
  }
}

/** Same shape/spirit as the kernel's ACCOUNT_ROLE_MISCONFIGURED. */
export class ControlAccountMisconfiguredError extends Error {
  readonly code = 'ACCOUNT_ROLE_MISCONFIGURED'
  readonly role: string
  constructor(role: string, account: AccountRow) {
    super(
      `${role} resolves to account ${account.code} (${account.kind}, control ` +
        `${account.controlKind}); a party ledger requires a POSTABLE account with that control kind.`,
    )
    this.name = 'ControlAccountMisconfiguredError'
    this.role = role
  }
}

/**
 * The AR_CONTROL (or, from Wave 6, AP_CONTROL) ledger of the tenant, filtered
 * to one party. Resolves the role exactly once per call — it is not cached,
 * matching every other role resolution in the system, which reads the
 * tenant's current mapping on every posting too.
 */
export async function controlAccountLedger(
  tx: TenantTx,
  tenantId: string,
  controlKind: ControlKind,
  partyId: string,
  options: Omit<AccountLedgerOptions, 'partyId'>,
): Promise<AccountLedgerResult> {
  const role = ROLE_OF[controlKind]
  const accounts = await resolveAccountsByRole(tx, tenantId, [role])
  const account = accounts.get(role)
  if (!account) throw new ControlAccountUnmappedError(role)
  if (account.kind !== 'POSTABLE' || account.controlKind !== controlKind) {
    throw new ControlAccountMisconfiguredError(role, account)
  }
  return accountLedger(tx, tenantId, account.id, { ...options, partyId })
}
