import {
  assertIssuedTenantTx,
  findAccountById,
  hasJournalLines,
  insertUserCreatedAccount,
  isProtectedAccount,
  journalConstraintName,
  journalSqlstate,
  listCodesInBlock,
  lockAccountForUpdate,
  updateAccountRow,
  recordAudit,
  ACCOUNTS_CODE_CONSTRAINT,
  ACCOUNTS_NAME_CONSTRAINT,
  UNIQUE_VIOLATION,
  type AccountRow,
  type TenantTx,
} from '@finsoft/database'
import { KernelInvariantError, PostingError } from './errors.ts'
import { requirePostingActor } from './posting-engine.ts'
import { requireKnownKeys, requireRecord } from './rules/shared.ts'

/*
 * COA/maintenance@1 — create and edit a chart-of-accounts account.
 * docs/posting-rules/coa-standard.md §8, M2-C.
 *
 * NOT a posting: no journal entry, no period, no idempotency key
 * (coa-standard.md §8.7 "Idempotency" — a duplicate create fails the second
 * time on ACCOUNT_CODE_TAKEN, a duplicate edit on ACCOUNT_VERSION_CONFLICT).
 * `chartOfAccounts.create` / `.update` / `.suggestCode` follow the same
 * `periodEngine` shape (periods.ts): `assertIssuedTenantTx`, then
 * `requirePostingActor` for the acting user (rule 9/18/22 — every write here
 * needs a real, authenticated actor, exactly like a period transition).
 *
 * §8.9 evaluation order (permission is the API layer's job —
 * `@RequirePermission('account.manage')` — everything from here on is this
 * file's job, in this order):
 *
 *   payload shape -> [edit: account found, not protected, version] ->
 *   parent -> code format -> code range -> [edit: has-postings] ->
 *   code/name uniqueness
 */

export const CODE_FORMAT = /^[1-9][0-9]{3}$/
const NAME_MAX = 200

/** coa-standard.md §8.1: ASSET/EXPENSE -> DEBIT, LIABILITY/EQUITY/INCOME -> CREDIT. Pure — unit-tested directly. */
export function deriveNormalBalance(type: string): 'DEBIT' | 'CREDIT' {
  return type === 'LIABILITY' || type === 'EQUITY' || type === 'INCOME' ? 'CREDIT' : 'DEBIT'
}

/** coa-standard.md §8.1: block = the parent header's own first digit; the header's own code is excluded. */
export function assertCodeInBlock(code: string, parentCode: string): void {
  if (!CODE_FORMAT.test(code)) {
    throw new PostingError(
      'ACCOUNT_CODE_FORMAT',
      `code must be 4 digits, ^[1-9][0-9]{3}$: "${code}".`,
      {
        field: 'code',
        code,
      },
    )
  }
  if (code[0] !== parentCode[0] || code === parentCode) {
    throw new PostingError(
      'ACCOUNT_CODE_OUT_OF_RANGE',
      `code ${code} is not in parent ${parentCode}'s block (${parentCode[0]}001-${parentCode[0]}999).`,
      { field: 'code', code, parentCode },
    )
  }
}

export function assertNameValid(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new PostingError(
      'ACCOUNT_NAME_INVALID',
      `name must be 1-${NAME_MAX} characters after trimming.`,
      { field: 'name' },
    )
  }
  return trimmed
}

async function loadHeaderParent(
  tx: TenantTx,
  tenantId: string,
  parentId: unknown,
): Promise<AccountRow> {
  if (typeof parentId !== 'string' || parentId.length === 0) {
    throw new PostingError('PAYLOAD_INVALID', 'parentId is required and must be a string.', {
      field: 'parentId',
    })
  }
  const parent = await findAccountById(tx, tenantId, parentId)
  if (!parent) {
    // Same answer whether unknown or another tenant's (RLS) — never 403.
    throw new PostingError('ACCOUNT_PARENT_NOT_FOUND', `Account ${parentId} was not found.`, {
      parentId,
    })
  }
  if (parent.kind !== 'HEADER') {
    throw new PostingError('ACCOUNT_PARENT_NOT_HEADER', `Account ${parent.code} is not a header.`, {
      parentId,
      parentCode: parent.code,
    })
  }
  return parent
}

/**
 * `AccountRow.version` is typed optional on `packages/database` only for
 * backward compatibility with fixtures built before M2-C (see that file's
 * own comment) — every row this kernel reads or writes carries the real,
 * NOT NULL `version` column (migration 010). `undefined` here is a kernel
 * defect (a query that forgot to select it), never a user condition.
 */
function requireVersion(account: AccountRow): number {
  if (account.version === undefined) {
    throw new KernelInvariantError(
      `accounts ${account.id}: version was not returned by the query that loaded this row.`,
    )
  }
  return account.version
}

function mapUniqueViolation(error: unknown): never {
  if (journalSqlstate(error) === UNIQUE_VIOLATION) {
    const constraint = journalConstraintName(error)
    if (constraint === ACCOUNTS_CODE_CONSTRAINT) {
      throw new PostingError('ACCOUNT_CODE_TAKEN', 'That code is already in use.', {
        field: 'code',
      })
    }
    if (constraint === ACCOUNTS_NAME_CONSTRAINT) {
      throw new PostingError('ACCOUNT_NAME_TAKEN', 'That name is already in use.', {
        field: 'name',
      })
    }
  }
  throw error
}

/* ------------------------------------------------------------------ *
 * create
 * ------------------------------------------------------------------ */

export interface CreateAccountCommand {
  readonly parentId: string
  readonly name: string
  readonly code: string
}

const CREATE_KEYS = ['parentId', 'name', 'code'] as const

export function validateCreatePayload(payload: unknown): {
  parentId: unknown
  name: unknown
  code: unknown
} {
  const record = requireRecord(payload, 'payload')
  requireKnownKeys(record, CREATE_KEYS, 'payload')
  return { parentId: record.parentId, name: record.name, code: record.code }
}

function accountCreatedAudit(account: AccountRow, actorUserId: string, parent: AccountRow) {
  return {
    actorUserId,
    action: 'ACCOUNT_CREATED',
    entityType: 'accounts',
    entityId: account.id,
    beforeJson: null,
    afterJson: {
      id: account.id,
      code: account.code,
      name: account.name,
      parentId: parent.id,
      parentCode: parent.code,
      type: account.type,
      normalBalance: account.normalBalance,
      kind: account.kind,
      controlKind: account.controlKind,
      role: account.role,
      restricted: String(account.restricted),
      isActive: String(account.isActive),
      version: String(requireVersion(account)),
    },
  }
}

async function create(cmd: unknown, tx: TenantTx): Promise<AccountRow> {
  assertIssuedTenantTx(tx)
  const { tenantId, actorUserId } = requirePostingActor(tx)

  const record = validateCreatePayload(cmd)
  const parent = await loadHeaderParent(tx, tenantId, record.parentId)

  if (typeof record.code !== 'string' || record.code.length === 0) {
    throw new PostingError('PAYLOAD_INVALID', 'code is required and must be a string.', {
      field: 'code',
    })
  }
  assertCodeInBlock(record.code, parent.code)

  if (typeof record.name !== 'string') {
    throw new PostingError('PAYLOAD_INVALID', 'name is required and must be a string.', {
      field: 'name',
    })
  }
  const name = assertNameValid(record.name)

  const normalBalance = deriveNormalBalance(parent.type)

  let account: AccountRow
  try {
    account = await insertUserCreatedAccount(
      tx,
      tenantId,
      { code: record.code, name, type: parent.type, normalBalance, parentId: parent.id },
      actorUserId,
    )
  } catch (error) {
    mapUniqueViolation(error)
  }

  await recordAudit(tx, accountCreatedAudit(account, actorUserId, parent))
  return account
}

/* ------------------------------------------------------------------ *
 * suggestCode
 * ------------------------------------------------------------------ */

/**
 * coa-standard.md §8.1: smallest free multiple of 100 in the parent's
 * block; else smallest free multiple of 10; else any free code. Advisory
 * only — reserves nothing, re-validated at submit like any typed code.
 * `null` if the block (all 999 codes) is exhausted.
 */
async function suggestCode(parentId: string, tx: TenantTx): Promise<string | null> {
  assertIssuedTenantTx(tx)
  const { tenantId } = requirePostingActor(tx)

  const parent = await loadHeaderParent(tx, tenantId, parentId)
  const prefix = parent.code[0] as string
  const used = await listCodesInBlock(tx, tenantId, prefix)

  const candidate = (suffix: number) => prefix + String(suffix).padStart(3, '0')

  for (let hundred = 1; hundred <= 9; hundred++) {
    const code = candidate(hundred * 100)
    if (!used.has(code)) return code
  }
  for (let ten = 1; ten <= 99; ten++) {
    if (ten % 10 === 0) continue // already tried as a multiple of 100
    const code = candidate(ten * 10)
    if (!used.has(code)) return code
  }
  for (let suffix = 1; suffix <= 999; suffix++) {
    const code = candidate(suffix)
    if (!used.has(code)) return code
  }
  return null
}

/* ------------------------------------------------------------------ *
 * update
 * ------------------------------------------------------------------ */

/** `accountId` comes from the route, never the body — kept separate from the user-suppliable payload. */
export interface UpdateAccountCommand {
  readonly accountId: string
  readonly payload: unknown
}

const UPDATE_KEYS = ['name', 'code', 'parentId', 'expectedVersion'] as const

export function validateUpdatePayload(payload: unknown): {
  name: unknown
  code: unknown
  parentId: unknown
  expectedVersion: unknown
} {
  const record = requireRecord(payload, 'payload')
  requireKnownKeys(record, UPDATE_KEYS, 'payload')
  if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) < 0) {
    throw new PostingError(
      'PAYLOAD_INVALID',
      'expectedVersion is required and must be a non-negative integer.',
      {
        field: 'expectedVersion',
      },
    )
  }
  return record as {
    name: unknown
    code: unknown
    parentId: unknown
    expectedVersion: unknown
  }
}

function accountUpdatedAudit(
  before: AccountRow,
  after: AccountRow,
  actorUserId: string,
  changed: Record<string, { before: string | null; after: string | null }>,
) {
  return {
    actorUserId,
    action: 'ACCOUNT_UPDATED',
    entityType: 'accounts',
    entityId: after.id,
    beforeJson: { version: String(requireVersion(before)) },
    afterJson: {
      version: String(requireVersion(after)),
      ...Object.fromEntries(
        Object.entries(changed).flatMap(([field, { before: b, after: a }]) => [
          [`${field}Before`, b],
          [`${field}After`, a],
        ]),
      ),
    },
  }
}

async function update(cmd: UpdateAccountCommand, tx: TenantTx): Promise<AccountRow> {
  assertIssuedTenantTx(tx)
  const { tenantId, actorUserId } = requirePostingActor(tx)
  const id = cmd.accountId

  const record = validateUpdatePayload(cmd.payload)

  // LOCK_REGISTRY: the account row FOR UPDATE, one row only (§8.7 R8).
  const current = await lockAccountForUpdate(tx, tenantId, id)
  if (!current) {
    throw new PostingError('ACCOUNT_NOT_FOUND', `Account ${id} was not found.`, { accountId: id })
  }
  if (isProtectedAccount(current)) {
    throw new PostingError(
      'ACCOUNT_PROTECTED',
      `Account ${current.code} is a header, role-holding, control or restricted account and cannot be edited.`,
      { accountId: id, code: current.code },
    )
  }
  const currentVersion = requireVersion(current)
  if (record.expectedVersion !== currentVersion) {
    throw new PostingError(
      'ACCOUNT_VERSION_CONFLICT',
      `Account ${current.code}: expected version ${String(record.expectedVersion)}, found ${currentVersion}.`,
      {
        accountId: id,
        expectedVersion: String(record.expectedVersion),
        actualVersion: String(currentVersion),
      },
    )
  }

  const changingParent = record.parentId !== undefined && record.parentId !== current.parentId
  const changingCode = record.code !== undefined && record.code !== current.code
  const changingName = record.name !== undefined && (record.name as string).trim() !== current.name

  let newParent: AccountRow | null = null
  if (changingParent) {
    if (typeof record.parentId !== 'string') {
      throw new PostingError('PAYLOAD_INVALID', 'parentId must be a string.', { field: 'parentId' })
    }
    newParent = await loadHeaderParent(tx, tenantId, record.parentId)
    if (newParent.type !== current.type) {
      throw new PostingError(
        'ACCOUNT_PARENT_TYPE_MISMATCH',
        `Account ${current.code} is ${current.type}; header ${newParent.code} is ${newParent.type}.`,
        { accountId: id, accountType: current.type, parentType: newParent.type },
      )
    }
  }

  let newCode: string | null = null
  if (changingCode) {
    if (typeof record.code !== 'string' || record.code.length === 0) {
      throw new PostingError('PAYLOAD_INVALID', 'code must be a string.', { field: 'code' })
    }
    const blockParentCode =
      newParent?.code ?? (await requireCurrentParentCode(tx, tenantId, current))
    assertCodeInBlock(record.code, blockParentCode)
    newCode = record.code
  }

  if (changingCode || changingParent) {
    // Fresh read, under the lock taken above — race-free (accounts.ts's own comment).
    if (await hasJournalLines(tx, tenantId, id)) {
      throw new PostingError(
        'ACCOUNT_HAS_POSTINGS',
        `Account ${current.code} has at least one journal line; its code and parent are frozen.`,
        { accountId: id, code: current.code },
      )
    }
  }

  let newName: string | null = null
  if (changingName) {
    if (typeof record.name !== 'string') {
      throw new PostingError('PAYLOAD_INVALID', 'name must be a string.', { field: 'name' })
    }
    newName = assertNameValid(record.name)
  }

  if (!changingParent && newCode === null && newName === null) {
    // §8.2: an edit that changes nothing writes nothing.
    return current
  }

  let updated: AccountRow | null
  try {
    updated = await updateAccountRow(
      tx,
      tenantId,
      id,
      currentVersion,
      {
        ...(newName !== null ? { name: newName } : {}),
        ...(newCode !== null ? { code: newCode } : {}),
        ...(changingParent && newParent ? { parentId: newParent.id } : {}),
      },
      actorUserId,
    )
  } catch (error) {
    mapUniqueViolation(error)
  }
  if (!updated) {
    throw new KernelInvariantError(
      `accounts ${id}: version ${String(currentVersion)} changed between the FOR UPDATE lock and the UPDATE ` +
        'statement — impossible while the lock is held.',
    )
  }

  const changed: Record<string, { before: string | null; after: string | null }> = {}
  if (newName !== null) changed.name = { before: current.name, after: newName }
  if (newCode !== null) changed.code = { before: current.code, after: newCode }
  if (changingParent && newParent) {
    changed.parentId = { before: current.parentId, after: newParent.id }
  }

  await recordAudit(tx, accountUpdatedAudit(current, updated, actorUserId, changed))
  return updated
}

async function requireCurrentParentCode(
  tx: TenantTx,
  tenantId: string,
  account: AccountRow,
): Promise<string> {
  if (account.parentId === null) {
    // accounts_postable_has_parent (migration 010): a POSTABLE account
    // (which every editable account is — headers are always protected)
    // always has a parent. A null here is a kernel defect, not user input.
    throw new KernelInvariantError(`accounts ${account.id}: a POSTABLE account with no parent_id.`)
  }
  const parent = await findAccountById(tx, tenantId, account.parentId)
  if (!parent) {
    throw new KernelInvariantError(
      `accounts ${account.id}: parent ${account.parentId} does not resolve — accounts_parent_fkey should have prevented this.`,
    )
  }
  return parent.code
}

export interface ChartOfAccounts {
  create(cmd: unknown, tx: TenantTx): Promise<AccountRow>
  update(cmd: UpdateAccountCommand, tx: TenantTx): Promise<AccountRow>
  suggestCode(parentId: string, tx: TenantTx): Promise<string | null>
}

export const chartOfAccounts: ChartOfAccounts = { create, update, suggestCode }
