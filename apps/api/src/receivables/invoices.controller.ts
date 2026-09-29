import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import {
  CalculateInvoiceSchema,
  CreateInvoiceSchema,
  InvoiceVersionOnlySchema,
  ListInvoicesQuerySchema,
  ReasonSchema,
  ReceivablesError,
  UpdateInvoiceSchema,
  decodeInvoiceCursor,
  toInvoiceCalculationDto,
  toInvoiceDto,
  toInvoiceListPageDto,
  type CalculateInvoiceDto,
  type CreateInvoiceDto,
  type InvoiceVersionOnlyDto,
  type ListInvoicesQueryDto,
  type ReasonDto,
  type UpdateInvoiceDto,
} from '@finsoft/receivables'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { receivables } from './composition'
import { requireIdempotencyKey } from './idempotency-key'
import { isReceivablesRoutableError, mapReceivablesError } from './receivables-error.mapper'

/*
 * GET/POST/PUT /api/invoices(, /:id, /:id/cancel, /calculate, /:id/post,
 * /:id/reverse). docs/design/M3/api-contract.md §2, §4.2.
 *
 * Thin per ADR-0028 statement 4. `fromPathId: true` on every route that
 * loads an invoice by its OWN `:id` — INVOICE_NOT_FOUND there is the path
 * id, always 404, never the 422 an allocation's invoiceId gets.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireAuth(req: Request): { readonly userId: string } {
  const auth = req.auth
  if (!auth) throw new UnauthorizedException()
  return auth
}

function requireUuidPathParam(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw mapReceivablesError(
      new ReceivablesError('INVOICE_NOT_FOUND', `invoice ${id} was not found.`, { invoiceId: id }),
      true,
    )
  }
}

async function buildInvoiceDto(
  id: string,
  journalEntry: { readonly id: string; readonly number: string } | null = null,
) {
  const result = await receivables.getInvoice(id)
  return toInvoiceDto(
    result.invoice,
    result.customer,
    result.lines,
    result.outstanding,
    result.allocations,
    result.reversalBlockedBy,
    journalEntry,
  )
}

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  @Get()
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'List invoices (cursor-paginated).' })
  async list(@Query(new ZodValidationPipe(ListInvoicesQuerySchema)) query: ListInvoicesQueryDto) {
    try {
      const result = await receivables.listInvoices({
        customerId: query.customerId ?? null,
        status: query.status ?? null,
        open: query.open ?? false,
        from: query.from ?? null,
        to: query.to ?? null,
        q: query.q ?? null,
        limit: query.limit ?? 50,
        cursor: decodeInvoiceCursor(query.cursor),
      })
      return toInvoiceListPageDto(result.items, result.next)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post()
  @RequirePermission('invoice.create')
  @ApiOperation({ summary: 'Create a service invoice draft.' })
  async create(
    @Body(new ZodValidationPipe(CreateInvoiceSchema)) body: CreateInvoiceDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      const result = await receivables.createInvoiceDraft({
        customerId: body.customerId,
        invoiceDate: body.invoiceDate ?? null,
        dueDate: body.dueDate,
        narration: body.narration,
        lines: body.lines,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildInvoiceDto(result.invoice.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Get(':id')
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'Get one invoice.' })
  async getOne(@Param('id') id: string) {
    try {
      requireUuidPathParam(id)
      return await buildInvoiceDto(id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error, true)
      throw error
    }
  }

  @Put(':id')
  @RequirePermission('invoice.create')
  @ApiOperation({ summary: 'Replace a draft invoice header and lines.' })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateInvoiceSchema)) body: UpdateInvoiceDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.updateInvoiceDraft({
        id,
        customerId: body.customerId,
        invoiceDate: body.invoiceDate ?? null,
        dueDate: body.dueDate,
        narration: body.narration,
        lines: body.lines,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      return buildInvoiceDto(result.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error, true)
      throw error
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('invoice.create')
  @ApiOperation({ summary: 'Cancel a draft invoice (terminal; never numbered).' })
  async cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(InvoiceVersionOnlySchema)) body: InvoiceVersionOnlyDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.cancelInvoiceDraft({
        id,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      return buildInvoiceDto(result.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error, true)
      throw error
    }
  }

  @Post('calculate')
  @HttpCode(200)
  @RequirePermission('invoice.create')
  @ApiOperation({ summary: 'Compute line nets and the total, without saving anything.' })
  calculate(@Body(new ZodValidationPipe(CalculateInvoiceSchema)) body: CalculateInvoiceDto) {
    const preview = receivables.calculateInvoice({ lines: body.lines })
    return toInvoiceCalculationDto(preview)
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('invoice.post')
  @ApiOperation({ summary: 'Post the invoice: SALE_POSTED/service@1.' })
  async post(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(InvoiceVersionOnlySchema)) body: InvoiceVersionOnlyDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.postInvoice({
        id,
        expectedVersion: body.version,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildInvoiceDto(id, { id: result.journalEntryId, number: result.journalEntryNumber })
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error, true)
      throw error
    }
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermission('invoice.post', 'voucher.reverse')
  @ApiOperation({ summary: 'Reverse a posted invoice.' })
  async reverse(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReasonSchema)) body: ReasonDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.reverseInvoice({
        id,
        reason: body.reason,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildInvoiceDto(id, { id: result.journalEntryId, number: result.journalEntryNumber })
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error, true)
      throw error
    }
  }
}
