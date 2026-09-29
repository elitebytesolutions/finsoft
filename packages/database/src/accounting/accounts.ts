import { sql } from 'kysely'
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
  /**
   * Optimistic concurrency (coa-standard.md §8.2). Optional on the TYPE only
   * — `mapRow` always sets it from the real, NOT NULL `version` column
   * (migration 010) — so that fixtures built before M2-C (e.g.
   * packages/reporting's) that construct an `AccountRow` literal without it
   * keep compiling. A new caller should still always read a real number.
   */
  readonly version?: number
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
  version: number
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
    version: row.version,
  }
}

/** coa-standard.md §8.2: header, holds a role, control kind other than NONE, or restricted. */
export function isProtectedAccount(
  account: Pick<AccountRow, 'kind' | 'role' | 'controlKind' | 'restricted'>,
): boolean {
  return (
    account.kind === 'HEADER' ||
    account.role !== null ||
    account.controlKind !== 'NONE' ||
    account.restricted
  )
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

/*
 * ---------------------------------------------------------------------------
 * Chart maintenance: create and edit. coa-standard.md §8, M2-C, migration 018.
 *
 * The functions below are pure data access — no PostingErrorCode here
 * (dependency direction: packages/database does not import
 * packages/accounting-kernel). The kernel (chart-of-accounts.ts) is what
 * turns "not found", "version mismatch" and a 23505 into a typed
 * PostingError, in the §8.9 order.
 * ---------------------------------------------------------------------------
 */

/**
 * The unique constraints §8.1/§8.7 R9 name — the kernel maps their 23505 by
 * name, using `journalConstraintName`/`UNIQUE_VIOLATION` (already exported
 * from the package root via journal.ts).
 */
export const ACCOUNTS_CODE_CONSTRAINT = 'accounts_tenant_code_key'
export const ACCOUNTS_NAME_CONSTRAINT = 'accounts_tenant_postable_name_key'

/** Unlocked read by id — parent lookups, and any read that does not need to race a posting. */
export async function findAccountById(
  tx: TenantTx,
  tenantId: string,
  id: string,
): Promise<AccountRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

/**
 * §8.7 R8 / LOCK_REGISTRY: the account row `FOR UPDATE`, one row only. The
 * kernel takes this lock before deciding ACCOUNT_HAS_POSTINGS for a code or
 * parent change, so a concurrent first `journal_lines` INSERT for this
 * account (which takes an implicit `FOR KEY SHARE` on this same row via
 * `journal_lines_account_fkey`) either waits behind this transaction or was
 * already committed and is visible to the fresh `hasJournalLines` read that
 * follows, under the same lock.
 */
export async function lockAccountForUpdate(
  tx: TenantTx,
  tenantId: string,
  id: string,
): Promise<AccountRow | null> {
  assertIssuedTenantTx(tx)
  const result = await sql<{
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
    version: number
  }>`
    SELECT id, tenant_id, code, name, type, normal_balance, kind, control_kind, role,
           restricted, is_active, parent_id, version
      FROM accounts
     WHERE tenant_id = ${tenantId} AND id = ${id}
       FOR UPDATE
  `.execute(tx)
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

/**
 * A fresh read, meant to run AFTER `lockAccountForUpdate` has locked the
 * account row — see that function's own comment for why that ordering makes
 * this race-free rather than merely "recent".
 */
export async function hasJournalLines(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ found: number }>`
    SELECT 1 AS found FROM journal_lines
     WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
     LIMIT 1
  `.execute(tx)
  return result.rows.length > 0
}

/**
 * Every code currently used by the tenant that lies in `blockPrefix`'s block
 * (the parent header's first digit) — `suggestCode`'s own candidate universe.
 * standard-v1 codes only (`^[1-9][0-9]{3}$`), coa-standard.md §8.1.
 */
export async function listCodesInBlock(
  tx: TenantTx,
  tenantId: string,
  blockPrefix: string,
): Promise<ReadonlySet<string>> {
  assertIssuedTenantTx(tx)
  const result = await sql<{ code: string }>`
    SELECT code FROM accounts
     WHERE tenant_id = ${tenantId} AND code LIKE ${blockPrefix + '___'} AND code ~ '^[1-9][0-9]{3}$'
  `.execute(tx)
  return new Set(result.rows.map((row) => row.code))
}

export interface NewUserAccount {
  readonly code: string
  readonly name: string
  readonly type: string
  readonly normalBalance: string
  readonly parentId: string
}

/**
 * coa-standard.md §8.1: born `POSTABLE`, `control_kind = 'NONE'`, `role =
 * NULL`, `restricted = false`, `is_active = true`, `version = 0` — hardcoded
 * here, never taken from the caller, so there is no field through which a
 * request could ask for a header, a control kind, a role or a restricted
 * account (§8.7 R2's application-layer half; the database-privilege half is
 * BLOCKED — see this lane's report).
 */
export async function insertUserCreatedAccount(
  tx: TenantTx,
  tenantId: string,
  input: NewUserAccount,
  actorUserId: string,
): Promise<AccountRow> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .insertInto('accounts')
    .values({
      tenant_id: tenantId,
      code: input.code,
      name: input.name,
      type: input.type,
      normal_balance: input.normalBalance,
      kind: 'POSTABLE',
      control_kind: 'NONE',
      role: null,
      restricted: false,
      parent_id: input.parentId,
      created_by: actorUserId,
      updated_by: actorUserId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return mapRow(row)
}

export interface AccountEditChanges {
  readonly name?: string
  readonly code?: string
  readonly parentId?: string
}

/**
 * `UPDATE ... WHERE tenant_id AND id AND version = expectedVersion`. Called
 * only after the kernel has already taken `lockAccountForUpdate`'s lock on
 * this same row in this same transaction, so a `null` return here (zero rows
 * matched) means the version changed between that lock and this statement —
 * impossible while the lock is held, and the kernel treats it as a
 * `KernelInvariantError`, not a user-facing `ACCOUNT_VERSION_CONFLICT` (that
 * code is raised earlier, from the locked read itself).
 */
export async function updateAccountRow(
  tx: TenantTx,
  tenantId: string,
  id: string,
  expectedVersion: number,
  changes: AccountEditChanges,
  actorUserId: string,
): Promise<AccountRow | null> {
  assertIssuedTenantTx(tx)
  const query = tx
    .updateTable('accounts')
    .set({
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.code !== undefined ? { code: changes.code } : {}),
      ...(changes.parentId !== undefined ? { parent_id: changes.parentId } : {}),
      updated_by: actorUserId,
      version: expectedVersion + 1,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('version', '=', expectedVersion)
    .returningAll()

  const row = await query.executeTakeFirst()
  return row ? mapRow(row) : null
}
