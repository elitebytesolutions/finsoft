import {
  assertIssuedTenantTx,
  closePeriod as closePeriodRow,
  lockPeriod as lockPeriodRow,
  PeriodAlreadyClosedError,
  PeriodCloseOutOfOrderError,
  PeriodLockedError,
  PeriodLockOutOfOrderError,
  PeriodNotClosedError,
  PeriodNotFoundError,
  PeriodReopenOutOfOrderError,
  reopenPeriod as reopenPeriodRow,
  type FiscalPeriodRow,
  type TenantTx,
} from '@finsoft/database'
import { PostingError, type PostingErrorCode } from './errors.ts'
import { requirePostingActor } from './posting-engine.ts'
import { findPeriodByLabel } from './queries/periods.ts'

/*
 * PERIOD_CLOSED@1 — close, reopen, lock. docs/posting-rules/periods.md §4,
 * §7, ADR-0012.
 *
 * The transitions themselves (calendar lock, order check, UPDATE, audit) are
 * packages/database's closePeriod/reopenPeriod/lockPeriod, with migration
 * 011's trigger as the backstop. This layer adds what makes them a kernel
 * operation: a user is required (rule 22 — no job closes a period), the
 * period is named by its label, and every refusal is a typed PostingError
 * with periods.md §9's code instead of a database-package exception class.
 *
 * The permission check (`period.close`, `period.reopen`, MFA step-up per
 * ADR-0012 / GAP-003) belongs to the calling application layer, as for
 * `voucher.post`.
 */

const REASON_MAX = 500

function translate(error: unknown): never {
  const map: readonly [new (...args: never[]) => Error, PostingErrorCode][] = [
    [PeriodCloseOutOfOrderError, 'PERIOD_CLOSE_OUT_OF_ORDER'],
    [PeriodReopenOutOfOrderError, 'PERIOD_REOPEN_OUT_OF_ORDER'],
    [PeriodLockOutOfOrderError, 'PERIOD_LOCK_OUT_OF_ORDER'],
    [PeriodNotClosedError, 'PERIOD_NOT_CLOSED'],
    [PeriodLockedError, 'PERIOD_LOCKED'],
    [PeriodNotFoundError, 'PERIOD_NOT_FOUND'],
    // Closing a period that is already CLOSED. periods.md §9 has no separate
    // code; the period's own state is the answer.
    [PeriodAlreadyClosedError, 'PERIOD_CLOSED'],
  ]
  for (const [type, code] of map) {
    if (error instanceof type) throw new PostingError(code, error.message)
  }
  throw error
}

async function resolve(tx: TenantTx, tenantId: string, label: string) {
  if (typeof label !== 'string' || !/^\d{4}-\d{2}$/.test(label)) {
    throw new PostingError('PAYLOAD_INVALID', 'A period is named by its label, YYYY-MM.', {
      field: 'period',
    })
  }
  const period = await findPeriodByLabel(tx, tenantId, label)
  if (!period)
    throw new PostingError('PERIOD_NOT_FOUND', `No fiscal period ${label}.`, { period: label })
  return period
}

export interface PeriodEngine {
  close(label: string, tx: TenantTx): Promise<FiscalPeriodRow>
  reopen(label: string, reason: string, tx: TenantTx): Promise<FiscalPeriodRow>
  lock(label: string, tx: TenantTx): Promise<FiscalPeriodRow>
}

export const periodEngine: PeriodEngine = {
  async close(label, tx) {
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor()
    const period = await resolve(tx, tenantId, label)
    return closePeriodRow(tx, tenantId, period.id, period.version, actorUserId).catch(translate)
  },

  async reopen(label, reason, tx) {
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor()
    const trimmed = typeof reason === 'string' ? reason.trim() : ''
    if (trimmed.length === 0 || trimmed.length > REASON_MAX) {
      throw new PostingError(
        'PERIOD_REOPEN_REASON_REQUIRED',
        `Reopening a period needs a reason: non-empty, at most ${REASON_MAX} characters.`,
      )
    }
    const period = await resolve(tx, tenantId, label)
    return reopenPeriodRow(tx, tenantId, period.id, period.version, actorUserId, trimmed).catch(
      translate,
    )
  },

  async lock(label, tx) {
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor()
    const period = await resolve(tx, tenantId, label)
    return lockPeriodRow(tx, tenantId, period.id, period.version, actorUserId).catch(translate)
  },
}
