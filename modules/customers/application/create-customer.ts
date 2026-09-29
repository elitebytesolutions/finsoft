import { recordAudit, withTenant, type JsonObject } from '@finsoft/database'
import { documentNumbers, registerParty } from '@finsoft/accounting-kernel'
import {
  normalizeCustomerFields,
  type CreateCustomerInput,
  type Customer,
} from '../domain/customer.ts'
import { CustomerError } from '../domain/errors.ts'
import { computeCommandFingerprint } from './fingerprint.ts'
import type { CustomersRepository } from './ports.ts'

/*
 * CreateCustomer. modules.md §4 (posting transaction shape, restated for a
 * non-posting mutation), §8 (audit), §9 (idempotency), §10 (CUST numbering,
 * K7). ADR-0026 statement 5: the customer is created in ONE transaction —
 * registerParty(tx, 'CUSTOMER') first, then this row, with id = the
 * returned party id. A rolled-back create consumes no CUST number and
 * registers no orphan party (the transaction rolls back together).
 */

export interface Actor {
  readonly userId: string
}

export interface CreateCustomerCommand {
  readonly fields: CreateCustomerInput
  readonly idempotencyKey: string
  readonly actor: Actor
}

export interface CreateCustomerResult {
  readonly customer: Customer
  /** True when this call replayed a prior identical request (modules.md §9). */
  readonly replayed: boolean
}

/** PostgreSQL's unique_violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'
/** database/migrations/015_create_customers.sql's UNIQUE (tenant_id, create_idempotency_key). */
const CREATE_IDEMPOTENCY_KEY_CONSTRAINT = 'customers_tenant_create_idempotency_key'

function isConcurrentIdempotencyKeyRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  const constraint =
    'constraint' in error ? (error as { constraint?: unknown }).constraint : undefined
  return code === UNIQUE_VIOLATION && constraint === CREATE_IDEMPOTENCY_KEY_CONSTRAINT
}

function auditAfter(customer: Customer): JsonObject {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.fields.name,
    phone: customer.fields.phone,
    email: customer.fields.email,
    address: customer.fields.address,
    city: customer.fields.city,
    ntn: customer.fields.ntn,
    creditDays: String(customer.fields.creditDays),
    status: customer.status,
  }
}

export function createCreateCustomer(repo: CustomersRepository) {
  return async function createCustomer(
    command: CreateCustomerCommand,
  ): Promise<CreateCustomerResult> {
    // Validation runs before any transaction is opened — a malformed
    // request never touches the database (rule: reject early).
    const fields = normalizeCustomerFields(command.fields)
    const fingerprint = computeCommandFingerprint({
      route: 'POST /api/customers',
      targetId: null,
      command: fields,
    })

    const attempt = async (): Promise<CreateCustomerResult> =>
      withTenant(async (tx) => {
        const prior = await repo.findByCreateIdempotencyKey(tx, command.idempotencyKey)
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw new CustomerError(
              'IDEMPOTENCY_KEY_REUSED',
              `idempotencyKey "${command.idempotencyKey}" was already used for a different request.`,
            )
          }
          return { customer: prior.customer, replayed: true }
        }

        // registerParty BEFORE the CUST number and BEFORE the row — the
        // composite FK makes this order compulsory, and ADR-0026 statement 4
        // is explicit that customers.id IS the returned party id.
        const partyId = await registerParty(tx, 'CUSTOMER')
        const code = await documentNumbers.next(tx, { series: 'CUST' })

        const customer = await repo.insert(tx, {
          id: partyId,
          code,
          fields,
          createIdempotencyKey: command.idempotencyKey,
          createFingerprint: fingerprint,
        })

        await recordAudit(tx, {
          actorUserId: command.actor.userId,
          // ADR-0020 §4 / migration 009 audit_log_action_shape: action is
          // UPPER_SNAKE_CASE (docs/design/M3/modules.md §8 gives it as
          // 'customer.created' — that table is a LEVEL 3 design pack, and its
          // own header says a released rule wins where the two disagree; the
          // audit_log CHECK is the released shape). entityType stays
          // lower_snake_case, matching audit_log_entity_type_shape.
          action: 'CUSTOMER_CREATED',
          entityType: 'customer',
          entityId: customer.id,
          beforeJson: null,
          afterJson: auditAfter(customer),
        })

        return { customer, replayed: false }
      })

    try {
      return await attempt()
    } catch (error) {
      // Security seat, Council review, 2026-09-29: two concurrent requests
      // with the SAME idempotency key can both pass the "no prior row"
      // check above (neither has committed yet under READ COMMITTED), and
      // then both attempt the INSERT. Whichever commits second loses the
      // race on customers_tenant_create_idempotency_key (23505) — not a
      // server fault, and not a caller error either: it is the SAME
      // request, arriving twice, exactly what idempotency exists to answer
      // as a replay. A raw 23505 reaching the HTTP layer as an unmapped 500
      // would be wrong on both counts. The first attempt's transaction has
      // already rolled back whole (registerParty included) by the time this
      // runs, so the retry opens its own, fresh transaction — a lost race
      // never leaves an orphan party.
      if (isConcurrentIdempotencyKeyRace(error)) {
        return withTenant(async (tx) => {
          const prior = await repo.findByCreateIdempotencyKey(tx, command.idempotencyKey)
          if (prior && prior.fingerprint === fingerprint) {
            return { customer: prior.customer, replayed: true }
          }
          // The row that won the race does not match this request's own
          // fingerprint (a genuine, if astronomically unlikely, key
          // collision between two DIFFERENT requests) — the same answer a
          // sequential replay-with-different-body gets.
          throw new CustomerError(
            'IDEMPOTENCY_KEY_REUSED',
            `idempotencyKey "${command.idempotencyKey}" was already used for a different request.`,
          )
        })
      }
      throw error
    }
  }
}
