import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { TenantContext } from '../tenant-context.ts'
import { recordAudit } from '../audit/writer.ts'
import { auditRequestId, auditVia, type AuditOrigin } from './audit-origin.ts'
import { COA_TEMPLATE_ID, STANDARD_V1, type ControlKind } from './coa-standard-v1.ts'

/*
 * The chart of accounts: seeding and role resolution.
 * docs/posting-rules/coa-standard.md.
 */

export interface AccountRow {
  readonly id: string
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly normalBalance: string
  readonly kind: string
  /** ADR-0026: 'NONE' for a non-control account — never null. */
  readonly controlKind: ControlKind
  readonly role: string | null
  readonly restricted: boolean
  readonly isActive: boolean
  /** Null for a HEADER account. GET /api/accounts' tree is built from this. */
  readonly parentId: string | null
}

function mapRow(row: {
  id: string
  tenant_id: string
  code: string
  name: string
  type: string
  normal_balance: string
  kind: string
  control_kind: string
  role: string | null
  restricted: boolean
  is_active: boolean
  parent_id: string | null
}): AccountRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    kind: row.kind,
    controlKind: row.control_kind as ControlKind,
    role: row.role,
    restricted: row.restricted,
    isActive: row.is_active,
    parentId: row.parent_id,
  }
}

/**
 * Seed `template` into `tenantId`'s chart of accounts.
 *
 * Deliberately not idempotent, matching `insertSeededRoles`'s own precedent:
 * `accounts_tenant_code_key` is UNIQUE per tenant, so a second call raises
 * `23505` rather than silently duplicating. Provisioning calls this exactly
 * once per tenant; a caller wanting idempotence (the backfill CLI, for an
 * EXISTING tenant) checks first with `hasChartOfAccounts`.
 *
 * Writes one audit record naming the template id (coa-standard.md §6). Not a
 * posting: no journal entry, no period involved.
 */
export async function seedChartOfAccounts(
  tx: TenantTx,
  tenantId: string,
  template: readonly (typeof STANDARD_V1)[number][] = STANDARD_V1,
  origin?: AuditOrigin,
): Promise<ReadonlyMap<string, string>> {
  assertIssuedTenantTx(tx)

  const context = TenantContext.require()
  if (context.tenantId !== tenantId) {
    throw new Error(
      `seedChartOfAccounts: tenantId argument (${tenantId}) does not match the transaction's ` +
        `tenant (${context.tenantId}).`,
    )
  }
  const actor = context.userId
  if (actor === null) {
    throw new Error(
      'seedChartOfAccounts: no acting user in context. The chart is seeded under an already-' +
        'created provisioned owner, never with no author (rule 9).',
    )
  }

  // Validated before any write, so a bad origin fails with nothing inserted.
  const auditRequest = auditRequestId(origin)
  const auditLabel = auditVia(origin)

  const idByCode = new Map<string, string>()

  // Headers first: postable rows reference their header's id as parent_id.
  const headers = template.filter((entry) => entry.kind === 'HEADER')
  const postable = template.filter((entry) => entry.kind === 'POSTABLE')

  for (const entry of headers) {
    const row = await tx
      .insertInto('accounts')
      .values({
        tenant_id: tenantId,
        code: entry.code,
        name: entry.name,
        type: entry.type,
        normal_balance: entry.normalBalance,
        kind: entry.kind,
        control_kind: entry.controlKind,
        role: entry.role,
        restricted: entry.restricted,
        parent_id: null,
        created_by: actor,
        updated_by: actor,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    idByCode.set(entry.code, row.id)
  }

  for (const entry of postable) {
    const parentId = entry.parentCode === null ? null : (idByCode.get(entry.parentCode) ?? null)
    if (entry.parentCode !== null && parentId === null) {
      throw new Error(
        `seedChartOfAccounts: template entry ${entry.code} names parent ${entry.parentCode}, ` +
          'which was not inserted as a header. The template is inconsistent.',
      )
    }
    const row = await tx
      .insertInto('accounts')
      .values({
        tenant_id: tenantId,
        code: entry.code,
        name: entry.name,
        type: entry.type,
        normal_balance: entry.normalBalance,
        kind: entry.kind,
        control_kind: entry.controlKind,
        role: entry.role,
        restricted: entry.restricted,
        parent_id: parentId,
        created_by: actor,
        updated_by: actor,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    idByCode.set(entry.code, row.id)
  }

  await recordAudit(tx, {
    actorUserId: actor,
    action: 'CHART_OF_ACCOUNTS_SEEDED',
    entityType: 'accounts',
    entityId: null,
    beforeJson: null,
    afterJson: {
      template: COA_TEMPLATE_ID,
      accountCount: String(template.length),
      ...auditLabel,
    },
    ip: null,
    requestId: auditRequest,
  })

  return idByCode
}

/** Whether `tenantId` already has any chart of accounts. Idempotency guard for the backfill CLI. */
export async function hasChartOfAccounts(tx: TenantTx, tenantId: string): Promise<boolean> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('accounts')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow()
  return Number(row.count) > 0
}

/**
 * Resolve `roles` to their accounts for the caller's tenant.
 *
 * Returns only the roles that DID resolve, each to exactly one row —
 * `accounts_tenant_active_role_key` (migration 010) already guarantees at
 * most one ACTIVE account per role per tenant, so a role present in the
 * result is unambiguous. A role absent from the returned map means either no
 * account holds it or the holder is inactive; the caller (the kernel) is
 * what raises ACCOUNT_ROLE_UNMAPPED, because "unmapped" is a posting-rule
 * concept, not a database one.
 */
export async function resolveAccountsByRole(
  tx: TenantTx,
  tenantId: string,
  roles: readonly string[],
): Promise<ReadonlyMap<string, AccountRow>> {
  assertIssuedTenantTx(tx)
  if (roles.length === 0) return new Map()

  const rows = await tx
    .selectFrom('accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('role', 'in', [...roles])
    .where('is_active', '=', true)
    .execute()

  const result = new Map<string, AccountRow>()
  for (const row of rows) {
    if (row.role !== null) result.set(row.role, mapRow(row))
  }
  return result
}

/** Load accounts by id, for the caller's tenant. Missing ids are simply absent from the result. */
export async function findAccountsByIds(
  tx: TenantTx,
  tenantId: string,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, AccountRow>> {
  assertIssuedTenantTx(tx)
  if (accountIds.length === 0) return new Map()

  const rows = await tx
    .selectFrom('accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', [...accountIds])
    .execute()

  const result = new Map<string, AccountRow>()
  for (const row of rows) result.set(row.id, mapRow(row))
  return result
}

/** All postable accounts for the caller's tenant — the trial balance's universe of rows. */
export async function listPostableAccounts(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly AccountRow[]> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .selectFrom('accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'POSTABLE')
    .orderBy('code')
    .execute()
  return rows.map(mapRow)
}

/** Every account (headers included) for the caller's tenant — the full chart. */
export async function listAllAccounts(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly AccountRow[]> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .selectFrom('accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('code')
    .execute()
  return rows.map(mapRow)
}
