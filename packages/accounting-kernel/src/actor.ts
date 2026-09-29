import { postingPrincipalOf, type TenantTx } from '@finsoft/database'
import { PostingError } from './errors.ts'

/*
 * The acting principal — a leaf module on purpose.
 *
 * `requirePostingActor` used to live in posting-engine.ts. `parties.ts`
 * needs it too (Council ruling, M2-A T3 final review, Item 1: `parties.ts`
 * uses this instead of its own duplicated TenantContext check), but
 * posting-engine.ts imports the rule files (`rules/service-sale.ts`,
 * `rules/customer-receipt.ts`, ...) for its `RULES` binding table, and
 * those rule files import `assertPartiesRegistered` FROM `parties.ts` —
 * so `parties.ts` importing `requirePostingActor` from posting-engine.ts
 * would close a cycle (posting-engine -> rules/* -> parties ->
 * posting-engine), which dependency-cruiser's `no-circular` rightly
 * refuses. This file has no dependency on posting-engine.ts, the rule
 * files, or parties.ts, so both can depend on it without one.
 */

/**
 * The acting principal. Throws unless there is an authenticated user (rule
 * 22). Reads it through `postingPrincipalOf(tx)` (packages/database) — the
 * kernel never imports `TenantContext` itself (M1-X T2); `postingPrincipalOf`
 * hands back a frozen copy, not the live ambient store.
 */
export function requirePostingActor(tx: TenantTx): { tenantId: string; actorUserId: string } {
  const { tenantId, userId } = postingPrincipalOf(tx)
  if (userId === null) {
    throw new PostingError(
      'FORBIDDEN',
      'No authenticated user in context. There is no service account that posts (rule 22).',
    )
  }
  return { tenantId, actorUserId: userId }
}
