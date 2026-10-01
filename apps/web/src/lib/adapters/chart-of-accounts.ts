/*
 * Maps the real API (`GET /api/accounts` + `GET /api/reports/trial-balance`) into exactly the
 * shape `apps/web/src/screens/chart-of-accounts.tsx` (restored from 8c5c283) expects — the same
 * `Master`-shaped record the mock's `data.masters` used to hand it, so the screen's own
 * tree-walking, filtering and rendering code is untouched.
 *
 * What is NOT here, on purpose: no balance arithmetic. `AdaptedAccount.balance` /
 * `.side` come straight from a `TrialBalanceLineDto` the server already computed — this
 * file only reshapes and looks values up by id. A header account's rolled-up total is the
 * one exception, and even that never re-derives a leaf's own balance: it adds already-server-
 * computed child totals together with `Money`, the same decimal library the rest of the app
 * uses for display arithmetic (never `+` on parsed floats).
 */
import { Money } from '@finsoft/validation'
import { moneyFromString } from '@finsoft/ui'
import type { AccountDto, TrialBalanceLine } from '@/lib/api/accounting-types'
import { buildAccountTree, flattenAccountTree } from '@/lib/accounting/account-tree'

export type AdaptedKind = 'Header' | 'Group' | 'Postable'
export type AdaptedBalanceSide = 'Dr' | 'Cr'

/** The shape `chart-of-accounts.tsx`'s restored markup consumes — deliberately close to the
 * retired mock's `Master` type (same field names) so the screen's own code did not need to
 * change shape, only its data source. */
export interface AdaptedAccount {
  id: string
  code: string
  name: string
  /** Human label for the account's ledger type, e.g. "Asset" — Title Case, matching the
   * original screen's own `descriptions`/tone lookups which key off names like "Assets". */
  type: string
  balanceType: 'Debit' | 'Credit'
  status: 'Active' | 'Inactive'
  /** Never modeled by the real chart — always '—'. Kept as a field (not deleted) so the
   * screen's own "city" affordance still has somewhere to read from; see coa-standard.md. */
  city: string
  contact: string
  /** Depth in the parentId tree, 1-based. The real chart is not guaranteed to be exactly
   * four levels deep the way the demo data was — this is real, computed depth, not a fake
   * level number. */
  level: number
  /** Parent account's CODE (not id) — the restored screen indexes accounts by code
   * everywhere, matching the mock's own convention. */
  parent: string | null
  kind: AdaptedKind
  /** The account's own net balance from the trial balance, formatted for display
   * (`moneyFromString`) — or `null` when the account has no activity as of the report date
   * (an em dash on screen, never "Rs 0.00" invented for a row the server didn't report). */
  balance: string | null
  side: AdaptedBalanceSide | null
}

export interface ChartOfAccountsData {
  accounts: AdaptedAccount[]
  /** Rolled-up balance for a HEADER/Group code — sums already-computed descendant trial-balance
   * totals with `Money`, never re-derives a leaf's balance from journals. `null` when nothing
   * under that code has any activity. */
  rollup: (code: string) => { amount: string; side: AdaptedBalanceSide } | null
}

function kindOf(account: AccountDto, depth: number): AdaptedKind {
  if (account.kind === 'POSTABLE') return 'Postable'
  return depth === 1 ? 'Header' : 'Group'
}

/** Title Case for the tone/description lookups the restored screen still keys off account
 * type, e.g. ASSET -> "Asset". Presentation only — the wire value (`account.type`) is what is
 * actually sent to and trusted from the server; this never changes what is stored or compared. */
function titleCase(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase()
}

export function adaptChartOfAccounts(
  accounts: readonly AccountDto[],
  trialBalanceLines: readonly TrialBalanceLine[],
): ChartOfAccountsData {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const balanceById = new Map(trialBalanceLines.map((l) => [l.accountId, l]))
  const tree = buildAccountTree(accounts)
  const flat = flattenAccountTree(tree)
  const depthById = new Map(flat.map((n) => [n.account.id, n.depth]))

  const netOf = (
    line: TrialBalanceLine | undefined,
  ): { amount: string; side: AdaptedBalanceSide } | null => {
    if (!line) return null
    if (!Money.isZero(Money.from(line.debit))) return { amount: line.debit, side: 'Dr' }
    if (!Money.isZero(Money.from(line.credit))) return { amount: line.credit, side: 'Cr' }
    return null
  }

  const adapted: AdaptedAccount[] = accounts.map((a) => {
    const depth = depthById.get(a.id) ?? 1
    const parentCode = a.parentId ? (byId.get(a.parentId)?.code ?? null) : null
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      type: titleCase(a.type),
      balanceType: a.normalBalance === 'DEBIT' ? 'Debit' : 'Credit',
      status: a.isActive ? 'Active' : 'Inactive',
      city: '—',
      contact: '—',
      level: depth,
      parent: parentCode,
      kind: kindOf(a, depth),
      balance: null,
      side: null,
    }
  })

  // Memoised rollup: sums each code's OWN trial-balance net (never re-derived) across every
  // descendant, signed debit-positive, via Money — not JS `+`.
  const childrenByParentCode = new Map<string | null, AdaptedAccount[]>()
  for (const a of adapted) {
    const list = childrenByParentCode.get(a.parent) ?? []
    list.push(a)
    childrenByParentCode.set(a.parent, list)
  }
  const byCode = new Map(adapted.map((a) => [a.code, a]))
  const cache = new Map<string, { amount: string; side: AdaptedBalanceSide } | null>()

  const signedOf = (net: { amount: string; side: AdaptedBalanceSide } | null) => {
    if (!net) return Money.zero()
    const magnitude = Money.from(net.amount)
    return net.side === 'Dr' ? magnitude : Money.negate(magnitude)
  }
  const fromSigned = (
    signed: ReturnType<typeof Money.from>,
  ): { amount: string; side: AdaptedBalanceSide } | null => {
    if (Money.isZero(signed)) return null
    return {
      amount: Money.serialize(Money.abs(signed), 4),
      side: Money.isNegative(signed) ? 'Cr' : 'Dr',
    }
  }

  const rollup = (code: string): { amount: string; side: AdaptedBalanceSide } | null => {
    if (cache.has(code)) return cache.get(code)!
    const account = byCode.get(code)
    const kids = childrenByParentCode.get(code) ?? []
    let result: { amount: string; side: AdaptedBalanceSide } | null
    if (kids.length === 0) {
      result = account ? netOf(balanceById.get(account.id)) : null
    } else {
      const signed = kids
        .map((k) => signedOf(rollup(k.code)))
        .reduce((acc, s) => Money.add(acc, s), Money.zero())
      result = fromSigned(signed)
    }
    cache.set(code, result)
    return result
  }

  return { accounts: adapted, rollup }
}

/** Formats a rollup/net result for display, or an em dash for "no activity" — never "Rs 0.00"
 * invented for a code the server reported nothing against. */
export function formatBalance(net: { amount: string; side: AdaptedBalanceSide } | null): string {
  if (!net) return '—'
  return `${moneyFromString(net.amount)} ${net.side}`
}
