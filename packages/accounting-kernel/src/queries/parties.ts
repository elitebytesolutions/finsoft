import { assertIssuedTenantTx, type TenantTx } from '@finsoft/database'

/*
 * The party register's query bodies. ADR-0026 statement 5: ONLY the kernel
 * writes `parties`, and the INSERT lives here — not in packages/database,
 * which modules/*\/infrastructure may import and would thereby let a module
 * write the register around the kernel. eslint.config.mjs fails the build on
 * insertInto/updateTable/deleteFrom('parties'), or `parties` inside an sql``
 * tag, anywhere outside packages/accounting-kernel/src/** (and the
 * migrations, which ESLint does not read).
 *
 * `finsoft_app` holds INSERT on (tenant_id, party_type, created_by,
 * updated_by) only — the id is always the database's gen_random_uuid(), never
 * caller-chosen — and no UPDATE or DELETE at all (migration 012).
 */

export type PartyTypeName = 'CUSTOMER' | 'VENDOR'

export async function insertParty(
  tx: TenantTx,
  tenantId: string,
  partyType: PartyTypeName,
  actorUserId: string,
): Promise<string> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .insertInto('parties')
    .values({
      tenant_id: tenantId,
      party_type: partyType,
      created_by: actorUserId,
      updated_by: actorUserId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** id -> party_type for the ids that exist in `tenantId`. Absent ids are simply missing. */
export async function findPartyTypes(
  tx: TenantTx,
  tenantId: string,
  partyIds: readonly string[],
): Promise<ReadonlyMap<string, PartyTypeName>> {
  assertIssuedTenantTx(tx)
  if (partyIds.length === 0) return new Map()
  const rows = await tx
    .selectFrom('parties')
    .select(['id', 'party_type'])
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', [...partyIds])
    .execute()
  return new Map(rows.map((row) => [row.id, row.party_type as PartyTypeName]))
}
