import type { AccountRow, ControlKind } from '@finsoft/database'
import { PostingError } from '../errors.ts'

/*
 * Role resolution. README §2.1: a rule names accounts by ROLE; the kernel
 * resolves each role to exactly one active, postable account of the posting
 * tenant, and a role that does not resolve is a loud configuration error —
 * never a guessed substitute. Uniqueness per tenant among active accounts is
 * migration 010's accounts_tenant_active_role_key.
 *
 * The expected type and control kind are part of the rule, not of the chart:
 * a tenant that maps AR_CONTROL to an expense account, or BANK_DEFAULT to a
 * control account, is misconfigured, and posting through it would put a
 * customer balance where no subledger can see it.
 */
export function requireResolvedRole(
  accounts: ReadonlyMap<string, AccountRow>,
  role: string,
  expected: { readonly type: string; readonly controlKind: ControlKind },
): AccountRow {
  const account = accounts.get(role)
  if (!account) {
    throw new PostingError('ACCOUNT_ROLE_UNMAPPED', `No active account holds the ${role} role.`, {
      role,
    })
  }
  if (
    account.kind !== 'POSTABLE' ||
    account.type !== expected.type ||
    account.controlKind !== expected.controlKind
  ) {
    throw new PostingError(
      'ACCOUNT_ROLE_MISCONFIGURED',
      `${role} resolves to account ${account.code} (${account.kind}, ${account.type}, control ${account.controlKind}); ` +
        `the rule requires a POSTABLE ${expected.type} account with control ${expected.controlKind}.`,
      { role, accountId: account.id, account: account.code },
    )
  }
  return account
}
