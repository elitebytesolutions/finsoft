import { assertIssuedTenantTx, type FiscalPeriodRow, type TenantTx } from '@finsoft/database'
import { PostingError } from './errors.ts'
import { requirePostingActor } from './posting-engine.ts'
import {
  closePeriodTransition,
  findPeriodByLabel,
  lockPeriodTransition,
  reopenPeriodTransition,
} from './queries/periods.ts'

/*
 * PERIOD_CLOSED@1 — close, reopen, lock. docs/posting-rules/periods.md §4,
 * §7, ADR-0012.
 *
 * The ONLY way anything in the system transitions a fiscal period. The
 * transitions' bodies — calendar lock, order check, UPDATE, audit — are the
 * kernel's own src/queries/periods.ts (T3 Council, Arch 1/2/5: no longer on
 * the @finsoft/database surface), with migration 011's trigger as the
 * database backstop. This layer adds what makes them a user operation: a
 * user is required (rule 22 — no job closes a period), the period is named
 * by its label, and the reopen reason is validated. Every refusal is a
 * PostingError with periods.md §9's code.
 *
 * The permission check (`period.close`, `period.reopen`, MFA step-up per
 * ADR-0012 / GAP-003) belongs to the calling application layer, as for
 * `voucher.post`.
 */

const REASON_MAX = 500

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
    const { tenantId, actorUserId } = requirePostingActor(tx)
    const period = await resolve(tx, tenantId, label)
    return closePeriodTransition(tx, tenantId, period.id, actorUserId)
  },

  async reopen(label, reason, tx) {
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor(tx)
    const trimmed = typeof reason === 'string' ? reason.trim() : ''
    if (trimmed.length === 0 || trimmed.length > REASON_MAX) {
      throw new PostingError(
        'PERIOD_REOPEN_REASON_REQUIRED',
        `Reopening a period needs a reason: non-empty, at most ${REASON_MAX} characters.`,
      )
    }
    const period = await resolve(tx, tenantId, label)
    return reopenPeriodTransition(tx, tenantId, period.id, actorUserId, trimmed)
  },

  async lock(label, tx) {
    assertIssuedTenantTx(tx)
    const { tenantId, actorUserId } = requirePostingActor(tx)
    const period = await resolve(tx, tenantId, label)
    return lockPeriodTransition(tx, tenantId, period.id, actorUserId)
  },
}
