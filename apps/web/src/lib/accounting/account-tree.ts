/*
 * Shared account-tree helpers over `GET /api/accounts`'s flat list
 * (`AccountDto[]`, ordered by code, edges via `parentId`) — used by Chart of
 * Accounts (the tree itself), Account Ledger and New Voucher (both need
 * "postable accounts only, as options"), and Cash Book (resolving the one
 * account it's scoped to).
 */
import type { AccountDto } from '@/lib/api/accounting-types'

export interface AccountTreeNode {
  account: AccountDto
  depth: number
  children: AccountTreeNode[]
}

/** Builds the tree from the flat, code-ordered list `GET /api/accounts` returns. */
export function buildAccountTree(accounts: readonly AccountDto[]): AccountTreeNode[] {
  const childrenOf = new Map<string | null, AccountDto[]>()
  for (const account of accounts) {
    const key = account.parentId
    const list = childrenOf.get(key) ?? []
    list.push(account)
    childrenOf.set(key, list)
  }
  const walk = (parentId: string | null, depth: number): AccountTreeNode[] =>
    (childrenOf.get(parentId) ?? []).map((account) => ({
      account,
      depth,
      children: walk(account.id, depth + 1),
    }))
  return walk(null, 1)
}

/** Flattens a tree back to a depth-annotated list, document order (pre-order). */
export function flattenAccountTree(nodes: readonly AccountTreeNode[]): AccountTreeNode[] {
  const out: AccountTreeNode[] = []
  const visit = (list: readonly AccountTreeNode[]) => {
    for (const node of list) {
      out.push(node)
      visit(node.children)
    }
  }
  visit(nodes)
  return out
}

/** Every `POSTABLE`, active account — the only ones selectable in a picker or a JV line
 * (journal-voucher.md §3 rows 8-10 also exclude control/restricted accounts; that
 * narrower "may a manual JV reach it" filter is `postableJournalAccounts` below). */
export function postableAccounts(accounts: readonly AccountDto[]): AccountDto[] {
  return accounts.filter((a) => a.kind === 'POSTABLE' && a.isActive)
}

/**
 * Accounts a manual Journal Voucher may actually post to: postable, active,
 * not a control account, not restricted (journal-voucher.md §3 rows 8-10;
 * coa-standard.md §3). Filtering the picker to this set is a UX convenience
 * — the server re-validates every line regardless.
 */
export function postableJournalAccounts(accounts: readonly AccountDto[]): AccountDto[] {
  return postableAccounts(accounts).filter(
    (a) => a.controlKind === 'NONE' && !a.restricted,
  )
}

/** Finds the account holding a given role (e.g. `CASH_DEFAULT`) — coa-standard.md §4:
 * "Each role... is held by exactly one active postable account per tenant." Returns
 * `undefined` if unmapped (`ACCOUNT_ROLE_UNMAPPED` territory — not expected in M2's
 * seeded template, but a screen must not crash if it happens). */
export function accountByRole(accounts: readonly AccountDto[], role: string): AccountDto | undefined {
  return accounts.find((a) => a.role === role && a.isActive)
}

export function accountByCode(accounts: readonly AccountDto[], code: string): AccountDto | undefined {
  return accounts.find((a) => a.code === code)
}
