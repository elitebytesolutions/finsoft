import { assertIssuedTenantTx, type TenantTx } from '@finsoft/database'
import { requirePostingActor } from './actor.ts'
import { PostingError } from './errors.ts'
import { findPartyTypes, insertParty, type PartyTypeName } from './queries/parties.ts'
import { isUuid } from './rules/shared.ts'

/*
 * The party register. ADR-0026.
 *
 * A module that introduces a customer (M3) or vendor (Wave 6) first calls
 * `registerParty(tx, 'CUSTOMER')`, in the same transaction, and uses the
 * returned id AS its own row's primary key (statement 4: module tables
 * reference parties 1:1 by shared id). The kernel never learns anything else
 * about the party — no name, no status (statement 1).
 *
 * No audit record is written here: the module's own "customer created" audit
 * record, written last in the same transaction, covers the registration.
 * Writing one here would take LOCK_REGISTRY position 6 (the terminal audit
 * lock) in the MIDDLE of the module's transaction, and nothing may lock after
 * position 6.
 */

export const PartyType = {
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
} as const satisfies Record<PartyTypeName, PartyTypeName>

export type { PartyTypeName }

export async function registerParty(tx: TenantTx, partyType: PartyTypeName): Promise<string> {
  // ADR-0005 Compliance: no overload without tx, and a hand-built handle throws.
  assertIssuedTenantTx(tx)
  if (partyType !== 'CUSTOMER' && partyType !== 'VENDOR') {
    throw new PostingError('PAYLOAD_INVALID', `partyType must be CUSTOMER or VENDOR.`, {
      partyType: String(partyType),
    })
  }
  const { tenantId, actorUserId } = requirePostingActor(tx)
  return insertParty(tx, tenantId, partyType, actorUserId)
}

/**
 * ADR-0026 statement 6: every party a line names is pre-checked before any
 * write, so a bad reference is a typed rejection rather than a commit-time
 * 23503 from the composite FK (which remains the backstop).
 *
 * PARTY_NOT_FOUND is the same whether the id is unknown or belongs to another
 * tenant — RLS hides the other tenant's row, and existence elsewhere is never
 * revealed (the ACCOUNT_NOT_FOUND convention, journal-voucher.md §3 row 7).
 */
export async function assertPartiesRegistered(
  tx: TenantTx,
  tenantId: string,
  refs: readonly { readonly partyId: string; readonly partyType: PartyTypeName }[],
): Promise<void> {
  if (refs.length === 0) return
  for (const ref of refs) {
    if (!isUuid(ref.partyId)) {
      throw new PostingError('PARTY_NOT_FOUND', `Party ${ref.partyId} was not found.`, {
        partyId: ref.partyId,
      })
    }
  }
  const found = await findPartyTypes(tx, tenantId, [...new Set(refs.map((ref) => ref.partyId))])
  for (const ref of refs) {
    const actual = found.get(ref.partyId)
    if (actual === undefined) {
      throw new PostingError('PARTY_NOT_FOUND', `Party ${ref.partyId} was not found.`, {
        partyId: ref.partyId,
      })
    }
    if (actual !== ref.partyType) {
      throw new PostingError(
        'PARTY_TYPE_MISMATCH',
        `Party ${ref.partyId} is a ${actual}, not a ${ref.partyType}.`,
        { partyId: ref.partyId, expected: ref.partyType, actual },
      )
    }
  }
}
