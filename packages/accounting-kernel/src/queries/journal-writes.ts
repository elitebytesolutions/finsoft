import { sql } from 'kysely'
import {
  assertIssuedTenantTx,
  type NewJournalEntry,
  type NewJournalLine,
  type TenantTx,
} from '@finsoft/database'

/*
 * The ONLY writes to journal_entries and journal_lines in the system.
 * ADR-0005 Compliance: "INSERT INTO journal_entries / journal_lines, and any
 * repository method writing those tables, may appear only inside
 * packages/accounting-kernel." eslint.config.mjs fails the build on any such
 * write elsewhere (tests/security/lint-boundaries.spec.ts proves it fires),
 * and inside the kernel confines query construction to this directory, so
 * the posting pipeline itself contains no SQL.
 *
 * Reads stay in packages/database/src/accounting (findEntryBy*, find*Lines):
 * reading the journal is not a posting.
 */

/**
 * Open the savepoint (fixed name; the pipeline opens at most one, never
 * nested) that brackets document numbering + the entry INSERT.
 *
 * Why it exists (and why no exception is involved): journal_entries IS the
 * idempotency record — there is no separate key table — so the conflicting
 * INSERT can only happen after a number has been taken from the counter
 * (pipeline step 8 precedes step 9). A concurrent duplicate of an in-flight
 * request therefore reaches its INSERT holding a freshly consumed number.
 * `INSERT ... ON CONFLICT DO NOTHING` returns no row, and rolling back to
 * this savepoint returns that number to the counter, so a double-click
 * replay commits no gap in the series (README §4: no number consumed except
 * by a posted entry). The savepoint is released on the normal path.
 */
export async function openNumberingSavepoint(tx: TenantTx): Promise<void> {
  assertIssuedTenantTx(tx)
  await sql`SAVEPOINT finsoft_posting_number`.execute(tx)
}

export async function releaseNumberingSavepoint(tx: TenantTx): Promise<void> {
  assertIssuedTenantTx(tx)
  await sql`RELEASE SAVEPOINT finsoft_posting_number`.execute(tx)
}

export async function rollbackNumberingSavepoint(tx: TenantTx): Promise<void> {
  assertIssuedTenantTx(tx)
  await sql`ROLLBACK TO SAVEPOINT finsoft_posting_number`.execute(tx)
  await sql`RELEASE SAVEPOINT finsoft_posting_number`.execute(tx)
}

/**
 * INSERT the entry unless it collides with an existing one on ANY unique
 * constraint — `(tenant_id, idempotency_key)`, `(tenant_id, source_type,
 * source_id)`, `(tenant_id, entry_number)`, `(tenant_id, reversal_of)`.
 *
 * Returns the new id, or `null` when a conflicting row exists (committed, or
 * committed by a concurrent transaction this statement waited on). No
 * exception is thrown for a conflict and the transaction stays usable: the
 * caller reads WHICH row conflicts with a plain SELECT. Every other failure
 * (the period trigger, a CHECK) still raises — those are not conflicts.
 */
export async function insertJournalEntryIfAbsent(
  tx: TenantTx,
  tenantId: string,
  entry: NewJournalEntry,
): Promise<string | null> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .insertInto('journal_entries')
    .values({
      tenant_id: tenantId,
      entry_number: entry.entryNumber,
      posting_rule: entry.postingRule,
      event: entry.event,
      occurred_at: entry.occurredAt,
      fiscal_period_id: entry.fiscalPeriodId,
      narration: entry.narration,
      reference: entry.reference,
      source_type: entry.sourceType,
      source_id: entry.sourceId,
      idempotency_key: entry.idempotencyKey,
      request_fingerprint: entry.requestFingerprint,
      reversal_of: entry.reversalOf,
      reversal_reason: entry.reversalReason,
      created_by: entry.actorUserId,
      updated_by: entry.actorUserId,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .execute()
  return rows[0]?.id ?? null
}

/**
 * All of an entry's lines in ONE multi-row INSERT, in the entry's own
 * transaction (migration 012's line gate rejects any later one). The balance
 * and line-count checks are DEFERRED constraint triggers that fire at commit —
 * the database's backstop behind the pipeline's own step-7 assertion.
 */
export async function insertJournalLines(
  tx: TenantTx,
  tenantId: string,
  entryId: string,
  actorUserId: string,
  lines: readonly NewJournalLine[],
): Promise<void> {
  assertIssuedTenantTx(tx)
  await tx
    .insertInto('journal_lines')
    .values(
      lines.map((line) => ({
        tenant_id: tenantId,
        entry_id: entryId,
        line_number: line.lineNumber,
        account_id: line.accountId,
        account_control: line.accountControl,
        debit: line.debit,
        credit: line.credit,
        party_type: line.partyType,
        party_id: line.partyId,
        memo: line.memo,
        created_by: actorUserId,
        updated_by: actorUserId,
      })),
    )
    .execute()
}

/**
 * ADR-0006 / reversal.md §8: the ONLY update ever applied to a posted entry —
 * POSTED -> REVERSED, naming the reversing entry. Optimistic-locked on
 * `version`; the row is already held FOR UPDATE by the reversal path
 * (LOCK_REGISTRY 5a), and migration 012's immutability trigger rejects any
 * other change for every role.
 */
export async function markJournalEntryReversed(
  tx: TenantTx,
  tenantId: string,
  entryId: string,
  reversedByEntryId: string,
  expectedVersion: number,
  actorUserId: string,
): Promise<void> {
  assertIssuedTenantTx(tx)
  const rows = await tx
    .updateTable('journal_entries')
    .set({
      status: 'REVERSED',
      reversed_by: reversedByEntryId,
      reversed_at: sql`now()`,
      updated_by: actorUserId,
      version: expectedVersion + 1,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entryId)
    .where('status', '=', 'POSTED')
    .where('version', '=', expectedVersion)
    .returning('id')
    .execute()
  if (rows.length !== 1) {
    throw new Error(
      `markJournalEntryReversed: entry ${entryId} was not POSTED at version ${expectedVersion}. ` +
        'It is row-locked by the reversal path, so this is a defect, not a race.',
    )
  }
}
