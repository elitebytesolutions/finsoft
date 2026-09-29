/*
 * modules/customers — the composition root. ADR-0028 statement 3: exports
 * use-case factories that build their own repositories internally, plus the
 * api/ contract. Exports NO repository, no query and nothing else from
 * infrastructure/. apps/api, apps/worker and tests/** are the callers.
 */
import { CustomersRepository } from './infrastructure/customers.repository.ts'
import { createCustomerDirectory } from './application/customer-directory.ts'
import { createCreateCustomer } from './application/create-customer.ts'
import { createUpdateCustomer } from './application/update-customer.ts'
import { createDeactivateCustomer } from './application/deactivate-customer.ts'
import { createReactivateCustomer } from './application/reactivate-customer.ts'
import { createGetCustomer } from './application/get-customer.ts'
import { createListCustomers } from './application/list-customers.ts'
import { createGetCustomerLedger } from './application/get-customer-ledger.ts'

const repository = new CustomersRepository()

/** Use-case factories — apps/api's controllers call these directly. */
export const createCustomer = createCreateCustomer(repository)
export const updateCustomer = createUpdateCustomer(repository)
export const deactivateCustomer = createDeactivateCustomer(repository)
export const reactivateCustomer = createReactivateCustomer(repository)
export const getCustomer = createGetCustomer(repository)
export const listCustomers = createListCustomers(repository)
export const getCustomerLedger = createGetCustomerLedger(repository)

/**
 * The `CustomerDirectory` implementation, for `apps/api` to hand to
 * `modules/receivables`' use-case factories (modules.md §3). Not part of
 * `published.ts` — that file carries the INTERFACE only; this is the one
 * concrete instance of it, built with this module's own repository.
 */
export const customerDirectory = createCustomerDirectory(repository)

// ---------------------------------------------------------------------------
// Command / query / result types — apps/api's controllers need these to
// build a command and to type a use case's return value.
// ---------------------------------------------------------------------------
export type {
  Actor,
  CreateCustomerCommand,
  CreateCustomerResult,
} from './application/create-customer.ts'
export type { UpdateCustomerCommand } from './application/update-customer.ts'
export type { DeactivateCustomerCommand } from './application/deactivate-customer.ts'
export type { ReactivateCustomerCommand } from './application/reactivate-customer.ts'
export type { GetCustomerResult } from './application/get-customer.ts'
export type {
  CustomerListItemResult,
  ListCustomersQuery,
  ListCustomersResult,
} from './application/list-customers.ts'
export type {
  GetCustomerLedgerQuery,
  GetCustomerLedgerResult,
} from './application/get-customer-ledger.ts'
export type { CustomerListCursor } from './application/ports.ts'

// ---------------------------------------------------------------------------
// Domain types a controller needs to READ a result (never to build one —
// commands are built from validated DTOs, not domain objects).
// ---------------------------------------------------------------------------
export type { Customer, CustomerStatus } from './domain/customer.ts'
export { CustomerError, type CustomerErrorCode } from './domain/errors.ts'

// ---------------------------------------------------------------------------
// The api/ contract: framework-free zod schemas, response mappers, the
// error-code -> HTTP-status table, and the cursor codec.
// ---------------------------------------------------------------------------
export {
  CreateCustomerSchema,
  CustomerLedgerQuerySchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
  VersionOnlySchema,
  type CreateCustomerDto,
  type CustomerLedgerQueryDto,
  type ListCustomersQueryDto,
  type UpdateCustomerDto,
  type VersionOnlyDto,
} from './api/schemas.ts'
export {
  toCustomerDto,
  toCustomerLedgerDto,
  toCustomerListItemDto,
  toCustomerListPageDto,
} from './api/mappers.ts'
export { customerErrorSlug, statusForCustomerErrorCode } from './api/errors.ts'
export { decodeCustomerCursor, encodeCustomerCursor } from './api/cursor.ts'
