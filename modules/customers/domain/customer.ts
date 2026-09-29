import { CustomerError } from './errors.ts'

/*
 * The customer entity. Pure TypeScript — no NestJS, no ORM, no HTTP, no
 * `@finsoft/database` (ARCHITECTURE §2 / ADR-0028 statement 5). Field
 * shapes here are docs/design/M3/modules.md §7 (the migration 015 CHECKs),
 * restated at the application boundary so a bad value is a typed
 * CustomerError before it ever reaches SQL, not a bare 23514.
 *
 * `email`'s FORMAT is deliberately NOT checked here — api-contract.md §4.1:
 * "email format-checked by the API schema, not the database" — this class
 * still caps its length (the migration's own CHECK) as a structural bound,
 * consistent with every other field.
 */

export type CustomerStatus = 'ACTIVE' | 'INACTIVE'

const NAME_MAX = 200
const PHONE_MAX = 50
const EMAIL_MAX = 200
const ADDRESS_MAX = 500
const CITY_MAX = 100
const NTN_PATTERN = /^[0-9]{7}-?[0-9]?$/
const CREDIT_DAYS_MIN = 0
const CREDIT_DAYS_MAX = 365

export interface CustomerFields {
  readonly name: string
  readonly phone: string | null
  readonly email: string | null
  readonly address: string | null
  readonly city: string | null
  readonly ntn: string | null
  readonly creditDays: number
}

/** What CreateCustomer accepts — every field required (creditDays defaults at the api boundary). */
export type CreateCustomerInput = CustomerFields

/** What UpdateCustomer accepts — every field optional; omitted means unchanged. */
export type UpdateCustomerInput = Partial<CustomerFields>

export interface CustomerRow {
  readonly id: string
  readonly code: string
  readonly fields: CustomerFields
  readonly status: CustomerStatus
  readonly version: number
  readonly createdAt: string
  readonly createdBy: string
  readonly updatedAt: string
  readonly updatedBy: string
}

function fail(field: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new CustomerError('VALIDATION_FAILED', message, { path: field, ...extra })
}

function normalizeRequiredText(value: string, field: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max) {
    fail(field, `${field} must be 1-${max} characters after trimming.`)
  }
  return trimmed
}

function normalizeOptionalText(value: string | null, field: string, max: number): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) {
    fail(field, `${field} must be at most ${max} characters.`)
  }
  return trimmed
}

function normalizeNtn(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!NTN_PATTERN.test(trimmed)) {
    fail('ntn', 'ntn must match 7 digits, an optional hyphen, and an optional check digit.')
  }
  return trimmed
}

function normalizeCreditDays(value: number): number {
  if (!Number.isInteger(value) || value < CREDIT_DAYS_MIN || value > CREDIT_DAYS_MAX) {
    fail(
      'creditDays',
      `creditDays must be an integer between ${CREDIT_DAYS_MIN} and ${CREDIT_DAYS_MAX}.`,
    )
  }
  return value
}

/** Validates and normalises a full field set — CreateCustomer's boundary. */
export function normalizeCustomerFields(input: CreateCustomerInput): CustomerFields {
  return {
    name: normalizeRequiredText(input.name, 'name', NAME_MAX),
    phone: normalizeOptionalText(input.phone, 'phone', PHONE_MAX),
    email: normalizeOptionalText(input.email, 'email', EMAIL_MAX),
    address: normalizeOptionalText(input.address, 'address', ADDRESS_MAX),
    city: normalizeOptionalText(input.city, 'city', CITY_MAX),
    ntn: normalizeNtn(input.ntn),
    creditDays: normalizeCreditDays(input.creditDays),
  }
}

/** Validates and normalises a PATCH — UpdateCustomer's boundary. Only present keys are returned. */
export function normalizeCustomerPatch(input: UpdateCustomerInput): Partial<CustomerFields> {
  // CustomerFields' properties are `readonly`, and `Partial<T>` preserves
  // that modifier — a mutable local needs every field writable again.
  const patch: { -readonly [K in keyof CustomerFields]?: CustomerFields[K] } = {}
  if (input.name !== undefined) patch.name = normalizeRequiredText(input.name, 'name', NAME_MAX)
  if (input.phone !== undefined)
    patch.phone = normalizeOptionalText(input.phone, 'phone', PHONE_MAX)
  if (input.email !== undefined)
    patch.email = normalizeOptionalText(input.email, 'email', EMAIL_MAX)
  if (input.address !== undefined)
    patch.address = normalizeOptionalText(input.address, 'address', ADDRESS_MAX)
  if (input.city !== undefined) patch.city = normalizeOptionalText(input.city, 'city', CITY_MAX)
  if (input.ntn !== undefined) patch.ntn = normalizeNtn(input.ntn)
  if (input.creditDays !== undefined) patch.creditDays = normalizeCreditDays(input.creditDays)
  return patch
}

/**
 * The entity. A thin, immutable wrapper over a persisted row — the
 * behaviour that matters is which transitions are allowed, not arithmetic
 * (there is none: a customer carries no money of its own, only a computed
 * ledger balance the application layer reads separately, K5).
 */
export class Customer {
  readonly id: string
  readonly code: string
  readonly fields: CustomerFields
  readonly status: CustomerStatus
  readonly version: number
  readonly createdAt: string
  readonly createdBy: string
  readonly updatedAt: string
  readonly updatedBy: string

  private constructor(row: CustomerRow) {
    this.id = row.id
    this.code = row.code
    this.fields = row.fields
    this.status = row.status
    this.version = row.version
    this.createdAt = row.createdAt
    this.createdBy = row.createdBy
    this.updatedAt = row.updatedAt
    this.updatedBy = row.updatedBy
    Object.freeze(this)
  }

  static fromRow(row: CustomerRow): Customer {
    return new Customer(row)
  }

  /**
   * VERSION_CONFLICT is checked once, here, ahead of every other rule — a
   * caller working from a stale read should never see a MORE specific error
   * (api-contract.md §1 "Optimistic concurrency").
   */
  assertVersion(expected: number): void {
    if (this.version !== expected) {
      throw new CustomerError(
        'VERSION_CONFLICT',
        `customer ${this.id} is at version ${this.version}, not ${expected}.`,
        { currentVersion: this.version },
      )
    }
  }

  /**
   * C5. `CUSTOMER_HAS_BALANCE` names the balance the application read under
   * the row lock (K5) — this method does no arithmetic itself, it only
   * enforces the rule given the answer. Deactivating an already-INACTIVE
   * customer is a no-op success (`alreadyInactive`), not an error: the
   * contract (api-contract.md §3) defines no code for that transition, and
   * inventing one is out of scope for this lane (delivery brief: "If edit
   * or deactivate needs a code that doesn't exist, STOP and report. Do not
   * invent one.").
   */
  assertDeactivatable(balance: { readonly isZero: boolean }): {
    readonly alreadyInactive: boolean
  } {
    if (this.status === 'INACTIVE') return { alreadyInactive: true }
    if (!balance.isZero) {
      throw new CustomerError(
        'CUSTOMER_HAS_BALANCE',
        `customer ${this.id} has a non-zero balance and cannot be deactivated.`,
        {},
      )
    }
    return { alreadyInactive: false }
  }

  /** Reactivating an already-ACTIVE customer is likewise a no-op success. */
  assertReactivatable(): { readonly alreadyActive: boolean } {
    return { alreadyActive: this.status === 'ACTIVE' }
  }

  /** C3-C7, I2/I4/I7/R3/R5/R6 (receivables, not this lane): a posting precondition. */
  assertActiveForPosting(): void {
    if (this.status !== 'ACTIVE') {
      throw new CustomerError('CUSTOMER_INACTIVE', `customer ${this.id} is not active.`, {
        customerId: this.id,
      })
    }
  }
}

/** api-contract.md §4.1 C7: the ledger range is capped at 366 days. */
export const LEDGER_MAX_DAYS = 366

export function assertLedgerRange(from: string, to: string): void {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1
  if (days > LEDGER_MAX_DAYS) {
    throw new CustomerError(
      'LEDGER_RANGE_TOO_LARGE',
      `ledger range ${from}..${to} is ${days} days; the maximum is ${LEDGER_MAX_DAYS}.`,
      { maxDays: LEDGER_MAX_DAYS },
    )
  }
}
