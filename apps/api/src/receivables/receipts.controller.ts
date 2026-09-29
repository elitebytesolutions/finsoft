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
  CreateReceiptSchema,
  ListReceiptsQuerySchema,
  PreviewReceiptSchema,
  ReasonSchema,
  ReceiptVersionOnlySchema,
  ReceivablesError,
  UpdateReceiptSchema,
  decodeReceiptCursor,
  toReceiptDto,
  toReceiptListPageDto,
  toReceiptPreviewDto,
  type CreateReceiptDto,
  type ListReceiptsQueryDto,
  type PreviewReceiptDto,
  type ReasonDto,
  type ReceiptVersionOnlyDto,
  type UpdateReceiptDto,
} from '@finsoft/receivables'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { receivables } from './composition'
import { requireIdempotencyKey } from './idempotency-key'
import { isReceivablesRoutableError, mapReceivablesError } from './receivables-error.mapper'

/*
 * GET/POST/PATCH /api/receipts(, /:id, /preview, /:id/post, /:id/cancel,
 * /:id/reverse). docs/design/M3/api-contract.md §2, §4.3.
 *
 * RECEIPT_NOT_FOUND is always 404 (api/errors.ts), so `fromPathId` is not
 * needed here the way it is on invoices — the only other *_NOT_FOUND this
 * controller's use cases raise (INVOICE_NOT_FOUND on a stale allocation) is
 * always a body reference, 422, the default.
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
      new ReceivablesError('RECEIPT_NOT_FOUND', `receipt ${id} was not found.`, { receiptId: id }),
    )
  }
}

async function buildReceiptDto(
  id: string,
  journalEntry: { readonly id: string; readonly number: string } | null = null,
) {
  const result = await receivables.getReceipt(id)
  return toReceiptDto(
    result.receipt,
    result.customer,
    result.proposals,
    result.proposalProblems,
    result.allocations,
    journalEntry,
  )
}

@ApiTags('receipts')
@Controller('receipts')
export class ReceiptsController {
  @Get()
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'List receipts, drafts included (cursor-paginated).' })
  async list(@Query(new ZodValidationPipe(ListReceiptsQuerySchema)) query: ListReceiptsQueryDto) {
    try {
      const result = await receivables.listReceipts({
        customerId: query.customerId ?? null,
        status: query.status ?? null,
        method: query.method ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        q: query.q ?? null,
        limit: query.limit ?? 50,
        cursor: decodeReceiptCursor(query.cursor),
      })
      return toReceiptListPageDto(result.items, result.next)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('payment.receive')
  @ApiOperation({
    summary: 'Preview allocation of a receipt against open invoices. Writes nothing.',
  })
  async preview(@Body(new ZodValidationPipe(PreviewReceiptSchema)) body: PreviewReceiptDto) {
    try {
      const result = await receivables.previewReceipt({
        customerId: body.customerId ?? null,
        receiptId: body.receiptId ?? null,
        receiptDate: body.receiptDate ?? null,
        amount: body.amount ?? null,
        allocations: body.allocations ?? null,
      })
      return toReceiptPreviewDto(result)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post()
  @RequirePermission('payment.receive')
  @ApiOperation({ summary: 'Create a customer receipt draft. Posts nothing, no number.' })
  async create(
    @Body(new ZodValidationPipe(CreateReceiptSchema)) body: CreateReceiptDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      const result = await receivables.createReceiptDraft({
        customerId: body.customerId,
        receiptDate: body.receiptDate ?? null,
        method: body.method,
        amount: body.amount,
        reference: body.reference,
        narration: body.narration,
        allocations: body.allocations,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildReceiptDto(result.receipt.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Get(':id')
  @RequirePermission('customer.view')
  @ApiOperation({ summary: 'Get one receipt: proposals for a draft, allocations once posted.' })
  async getOne(@Param('id') id: string) {
    try {
      requireUuidPathParam(id)
      return await buildReceiptDto(id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Patch(':id')
  @RequirePermission('payment.receive')
  @ApiOperation({
    summary: 'Edit a receipt draft. `allocations`, if present, replaces all proposals.',
  })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateReceiptSchema)) body: UpdateReceiptDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.updateReceiptDraft({
        id,
        ...(body.customerId !== undefined ? { customerId: body.customerId } : {}),
        ...(body.receiptDate !== undefined ? { receiptDate: body.receiptDate } : {}),
        ...(body.method !== undefined ? { method: body.method } : {}),
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
        ...(body.narration !== undefined ? { narration: body.narration } : {}),
        ...(body.allocations !== undefined ? { allocations: body.allocations } : {}),
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      return buildReceiptDto(result.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('payment.receive')
  @ApiOperation({
    summary:
      'Post the receipt: CUSTOMER_PAYMENT_RECEIVED@1. Assigns RCT-… and applies allocations.',
  })
  async post(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReceiptVersionOnlySchema)) body: ReceiptVersionOnlyDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.postReceipt({
        id,
        expectedVersion: body.version,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildReceiptDto(id, { id: result.journalEntryId, number: result.journalEntryNumber })
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('payment.receive')
  @ApiOperation({ summary: 'Cancel a receipt draft (terminal; never numbered).' })
  async cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReceiptVersionOnlySchema)) body: ReceiptVersionOnlyDto,
    @Req() req: Request,
  ) {
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.cancelReceiptDraft({
        id,
        expectedVersion: body.version,
        actor: { userId: auth.userId },
      })
      return buildReceiptDto(result.id)
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermission('payment.receive', 'voucher.reverse')
  @ApiOperation({
    summary: 'Reverse a posted receipt. Voids its allocations, restores invoice outstanding.',
  })
  async reverse(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReasonSchema)) body: ReasonDto,
    @Req() req: Request,
  ) {
    const idempotencyKey = requireIdempotencyKey(req)
    const auth = requireAuth(req)
    try {
      requireUuidPathParam(id)
      const result = await receivables.reverseReceipt({
        id,
        reason: body.reason,
        idempotencyKey,
        actor: { userId: auth.userId },
      })
      return buildReceiptDto(id, { id: result.journalEntryId, number: result.journalEntryNumber })
    } catch (error) {
      if (isReceivablesRoutableError(error)) throw mapReceivablesError(error)
      throw error
    }
  }
}
