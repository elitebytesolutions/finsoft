import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import {
  CreateCustomerSchema,
  CustomerError,
  CustomerLedgerQuerySchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
  VersionOnlySchema,
  createCustomer,
  decodeCustomerCursor,
  deactivateCustomer,
  getCustomer,
  getCustomerLedger,
  listCustomers,
  reactivateCustomer,
  toCustomerDto,
  toCustomerLedgerDto,
  toCustomerListPageDto,
  updateCustomer,
  type CreateCustomerDto,
  type CustomerLedgerQueryDto,
  type ListCustomersQueryDto,
  type UpdateCustomerDto,
  type VersionOnlyDto,
} from '@finsoft/customers'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { requireIdempotencyKey } from './idempotency-key'
import {
  isControlAccountError,
  mapControlAccountError,
  mapCustomerError,
} from './customer-error.mapper'

/*
 * GET/POST /api/customers(, /:id, /:id/deactivate, /:id/reactivate,
 * /:id/ledger). docs/design/M3/api-contract.md §2, §4.1.
 *
 * Thin per ADR-0028 statement 4: parse with the module's zod schema, call
 * ONE use case, map the result with the module's mapper, declare
 * @RequirePermission. No transaction, no domain type, no query — every use
 * case opens (and closes) its own `withTenant` inside `@finsoft/customers`.
 * `withTenant`/`withGlobal` are themselves banned in this directory
 * (ADR-0028 C6) precisely so this file cannot grow one.
 *
 * README §10 debt: customer edits and status changes use `customer.create`
 * (the MVP catalogue has no `customer.update`); confirmed against
 * packages/permissions/src/catalog.ts at this lane's review.
 */

const DEFAULT_LIST_LIMIT = 50
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The caller's identity, verified by `TenantGuard` ahead of every
 * `@RequirePermission` route. Never a fall-through — `req.auth` absent here
 * is a guard-ordering defect, not a legitimate unauthenticated request
 * (accounting/caller.ts's own precedent for the same defensive check).
 */
function requireAuth(req: Request): { readonly userId: string } {
  const auth = req.auth
  if (!auth) throw new UnauthorizedException()
  return auth
}

/**
 * A malformed :id never reaches the database as a `uuid`-typed parameter
 * (which would raise a driver-level type error, a 500). It gets the SAME
 * `CUSTOMER_NOT_FOUND` an unknown or cross-tenant id gets — api-contract.md
 * §1: "A path id that is unknown or belongs to another tenant is the same
 * 404 with the same body."
 */
function requireUuidPathParam(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new CustomerError('CUSTOMER_NOT_FOUND', `customer ${id} was not found.`, {
      customerId: id,
    })
  }
}

@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  @Post()
  @RequirePermission('customer.create')
  @ApiOperation({ summary: 'Create a customer (system-generated CUST-000001 code).' })
  async create(
    @Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)

    try {
      const result = await createCustomer({
        fields: body,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      if (!result.replayed) {
        // A genuinely new customer has posted no journal line yet, so its
        // AR_CONTROL balance is 0.0000 by construction — no need for the
        // round trip getCustomer's other callers make to learn the same
        // fact. A REPLAY is not new: real postings may have happened since
        // the original create, so its balance is read for real, below.
        return toCustomerDto(result.customer, '0.0000', today())
      }
      const balanceResult = await getCustomer(result.customer.id)
      return toCustomerDto(result.customer, balanceResult.balance, balanceResult.balanceAsOf)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Get()
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'List customers (cursor-paginated, code ascending).' })
  async list(@Query(new ZodValidationPipe(ListCustomersQuerySchema)) query: ListCustomersQueryDto) {
    try {
      const result = await listCustomers({
        q: query.q ?? null,
        status: query.status ?? null,
        limit: query.limit ?? DEFAULT_LIST_LIMIT,
        cursor: decodeCustomerCursor(query.cursor),
      })
      return toCustomerListPageDto(result.items, result.nextCursor)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Get(':id')
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'Get one customer, with its current AR_CONTROL balance (K5).' })
  async getOne(@Param('id') id: string) {
    try {
      requireUuidPathParam(id)
      const result = await getCustomer(id)
      return toCustomerDto(result.customer, result.balance, result.balanceAsOf)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Patch(':id')
  @RequirePermission('customer.create')
  @ApiOperation({ summary: 'Edit a customer. code and status are not editable here.' })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCustomerSchema)) body: UpdateCustomerDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)
    // exactOptionalPropertyTypes: `{ ...rest } = body` would carry explicit
    // `undefined` for every field the caller omitted (UpdateCustomerSchema's
    // zod .optional() fields), which Partial<CustomerFields> rejects — spread
    // only the keys the caller actually supplied (same pattern as
    // apps/api/src/accounting/journals.controller.ts's filter object).
    const patch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.ntn !== undefined ? { ntn: body.ntn } : {}),
      ...(body.creditDays !== undefined ? { creditDays: body.creditDays } : {}),
    }

    try {
      requireUuidPathParam(id)
      const customer = await updateCustomer({
        id,
        patch,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      const balanceResult = await getCustomer(id)
      return toCustomerDto(customer, balanceResult.balance, balanceResult.balanceAsOf)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('customer.create')
  @ApiOperation({ summary: 'Deactivate a customer. Refused while its AR balance is non-zero.' })
  async deactivate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VersionOnlySchema)) body: VersionOnlyDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)

    try {
      requireUuidPathParam(id)
      const customer = await deactivateCustomer({
        id,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      const balanceResult = await getCustomer(id)
      return toCustomerDto(customer, balanceResult.balance, balanceResult.balanceAsOf)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('customer.create')
  @ApiOperation({ summary: 'Reactivate a customer.' })
  async reactivate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VersionOnlySchema)) body: VersionOnlyDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)

    try {
      requireUuidPathParam(id)
      const customer = await reactivateCustomer({
        id,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      const balanceResult = await getCustomer(id)
      return toCustomerDto(customer, balanceResult.balance, balanceResult.balanceAsOf)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      throw error
    }
  }

  @Get(':id/ledger')
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'The AR_CONTROL ledger (K5), filtered to this customer.' })
  async ledger(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(CustomerLedgerQuerySchema)) query: CustomerLedgerQueryDto,
  ) {
    try {
      requireUuidPathParam(id)
      // Defaults (first day of the tenant's current fiscal year; today in
      // the tenant's timezone) are resolved server-side, inside the use
      // case's own withTenant — never here, which has no tenant timezone
      // to compute either from (rule 13).
      const result = await getCustomerLedger({
        id,
        from: query.from ?? null,
        to: query.to ?? null,
      })
      return toCustomerLedgerDto(result)
    } catch (error) {
      if (error instanceof CustomerError) throw mapCustomerError(error)
      // ACCOUNT_ROLE_UNMAPPED / ACCOUNT_ROLE_MISCONFIGURED (api-contract.md
      // §3): a tenant configuration fault, not a caller error — the only
      // route in this controller that resolves an account role.
      if (isControlAccountError(error)) throw mapControlAccountError(error)
      throw error
    }
  }
}
