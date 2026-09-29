import { assertIssuedTenantTx, type TenantTx } from '../transaction.ts'
import { calendarDate } from './calendar-date.ts'
import type { ControlKind } from './coa-standard-v1.ts'

/*
 * The journal: journal_entries and journal_lines.
 * docs/posting-rules/README.md, journal-voucher.md, reversal.md.
 * migration 012_create_journal.sql, ADR-0026.
 *
 * READS ONLY. Nothing in this package writes journal_entries or
 * journal_lines: ADR-0005 Compliance confines those writes to
 * packages/accounting-kernel (src/queries/journal-writes.ts), and
 * eslint.config.mjs fails the build on a write anywhere else — including
 * here, since every module may import packages/database. The row types
 * below stay here because both sides share them.
 *
 * NOTHING in this package writes `parties` either. ADR-0026 statement 5: the
 * register is written only by packages/accounting-kernel (registerParty),
 * because packages/database is importable by every module's infrastructure layer and
 * a parties INSERT here would let a module bypass the kernel.
 */

export interface JournalEntryRow {
  readonly id: string
  readonly tenantId: string
  readonly entryNumber: string
  readonly postingRule: string
  readonly event: string
  readonly occurredAt: string
  readonly fiscalPeriodId: string
  readonly status: 'POSTED' | 'REVERSED'
  readonly narration: string
  readonly reference: string | null
  readonly sourceType: string
  readonly sourceId: string
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly reversalOf: string | null
  readonly reversalReason: string | null
  readonly reversedBy: string | null
  readonly reversedAt: string | null
  readonly version: number
}

export interface JournalLineRow {
  readonly id: string
  readonly entryId: string
  readonly lineNumber: number
  readonly accountId: string
  /** ADR-0026: the account's control_kind at posting time. */
  readonly accountControl: ControlKind
  /** Fixed-scale decimal strings — never coerced to number (ADR-0011). */
  readonly debit: string
  readonly credit: string
  readonly partyType: 'CUSTOMER' | 'VENDOR' | null
  readonly partyId: string | null
  readonly memo: string | null
}

export interface NewJournalEntry {
  readonly entryNumber: string
  readonly postingRule: string
  readonly event: string
  /** ISO date (YYYY-MM-DD), the business date. */
  readonly occurredAt: string
  readonly fiscalPeriodId: string
  readonly narration: string
  readonly reference: string | null
  readonly sourceType: string
  readonly sourceId: string
  readonly idempotencyKey: string
  /** sha256 hex, 64 chars. */
  readonly requestFingerprint: string
  readonly reversalOf: string | null
  readonly reversalReason: string | null
  readonly actorUserId: string
}

export interface NewJournalLine {
  readonly lineNumber: number
  readonly accountId: string
  /**
   * ADR-0026 statement 3: the line's account's `control_kind`, as the kernel
   * resolved it. Pinned by the composite FK to accounts(tenant_id, id,
   * control_kind) — a value that disagrees with the account is a 23503 — and
   * tied to the party by journal_lines_party_matches_control: AR requires a
   * CUSTOMER party, AP a VENDOR party, NONE/INVENTORY no party (23514).
   */
  readonly accountControl: ControlKind
  readonly debit: string
  readonly credit: string
  readonly partyType: 'CUSTOMER' | 'VENDOR' | null
  readonly partyId: string | null
  readonly memo: string | null
}

function mapEntry(row: {
  id: string
  tenant_id: string
  entry_number: string
  posting_rule: string
  event: string
  occurred_at: unknown
  fiscal_period_id: string
  status: string
  narration: string
  reference: string | null
  source_type: string
  source_id: string
  idempotency_key: string
  request_fingerprint: string
  reversal_of: string | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: unknown
  version: number
}): JournalEntryRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entryNumber: row.entry_number,
    postingRule: row.posting_rule,
    event: row.event,
    occurredAt: calendarDate(row.occurred_at),
    fiscalPeriodId: row.fiscal_period_id,
    status: row.status as 'POSTED' | 'REVERSED',
    narration: row.narration,
    reference: row.reference,
    sourceType: row.source_type,
    sourceId: row.source_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    reversalOf: row.reversal_of,
    reversalReason: row.reversal_reason,
    reversedBy: row.reversed_by,
    reversedAt: row.reversed_at === null ? null : String(row.reversed_at),
    version: row.version,
  }
}

function mapLine(row: {
  id: string
  entry_id: string
  line_number: number
  account_id: string
  account_control: string
  debit: string
  credit: string
  party_type: string | null
  party_id: string | null
  memo: string | null
}): JournalLineRow {
  return {
    id: row.id,
    entryId: row.entry_id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    accountControl: row.account_control as ControlKind,
    debit: row.debit,
    credit: row.credit,
    partyType: row.party_type as 'CUSTOMER' | 'VENDOR' | null,
    partyId: row.party_id,
    memo: row.memo,
  }
}

/** PostgreSQL's unique_violation SQLSTATE. */
export const UNIQUE_VIOLATION = '23505'

export function sqlstate(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const name = (error as { constraint?: unknown }).constraint
    return typeof name === 'string' ? name : undefined
  }
  return undefined
}

export async function findEntryByIdempotencyKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
): Promise<JournalEntryRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('journal_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst()
  return row ? mapEntry(row) : null
}

export async function findEntryBySource(
  tx: TenantTx,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<JournalEntryRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('journal_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source_type', '=', sourceType)
    .where('source_id', '=', sourceId)
    .executeTakeFirst()
  return row ? mapEntry(row) : null
}

export async function findEntryById(
  tx: TenantTx,
  tenantId: string,
  entryId: string,
): Promise<JournalEntryRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('journal_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entryId)
    .executeTakeFirst()
  return row ? mapEntry(row) : null
}

export async function findLinesByEntryId(
  tx: TenantTx,
  tenantId: string,
  entryId: string,
): Promise<readonly JournalLineRow[]> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .selectFrom('journal_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('entry_id', '=', entryId)
    .orderBy('line_number')
    .execute()
  return rows.map(mapLine)
}

/**
 * Mark `entryId` REVERSED. Row-locked (`FOR UPDATE`) — the entry's
 * immutability trigger (migration 012) is the backstop; this lock is what
 * makes two concurrent reversal attempts of the same entry serialise instead
 * of both reading `status = POSTED`.
 */
export async function lockEntryForReversal(
  tx: TenantTx,
  tenantId: string,
  entryId: string,
): Promise<JournalEntryRow | null> {
  assertIssuedTenantTx(tx)
  const row = await tx
    .selectFrom('journal_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entryId)
    .forUpdate()
    .executeTakeFirst()
  return row ? mapEntry(row) : null
}
