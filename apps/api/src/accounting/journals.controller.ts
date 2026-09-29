import { createHash } from 'node:crypto'
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request } from 'express'
import {
  FinancialEvent,
  JOURNAL_VOUCHER_SOURCE_TYPE,
  PostingError,
  postingEngine,
  reversalEngine,
} from '@finsoft/accounting-kernel'
import {
  findEntryById,
  findLinesByEntryId,
  listJournalEntries,
  withTenant,
  type JournalEntryRow,
  type JournalLineRow,
} from '@finsoft/database'
import type {
  JournalEntryDto,
  JournalEntryWithLinesDto,
  JournalLineDto,
  JournalListResponseDto,
  PostJournalVoucherResponseDto,
  ReverseJournalEntryResponseDto,
} from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { decodeRegisterCursor, encodeCursor } from './cursor'
import { JournalListQuerySchema, type JournalListQueryDto } from './dto/journal-query.dto'
import {
  PostJournalVoucherSchema,
  type PostJournalVoucherDto,
} from './dto/post-journal-voucher.dto'
import {
  ReverseJournalEntrySchema,
  type ReverseJournalEntryDto,
} from './dto/reverse-journal-entry.dto'
import { isUuidShaped } from './dto/shared'
import { requireIdempotencyKey } from './idempotency-key'
import { mapPostingError } from './posting-error.mapper'

/*
 * GET/POST /api/journals(, /:id, /:id/reverse). docs/design/M2/api-contract.md §2.
 *
 * Every write goes through postingEngine.post / reversalEngine.reverse —
 * this controller builds no journal line and writes no table itself
 * (CLAUDE.md "the posting pattern"). Every read goes through
 * @finsoft/database's already-tenant-scoped query surface.
 */

function entryDto(entry: JournalEntryRow): JournalEntryDto {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    postingRule: entry.postingRule,
    event: entry.event,
    occurredAt: entry.occurredAt,
    status: entry.status,
    narration: entry.narration,
    reference: entry.reference,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    reversalOf: entry.reversalOf,
    reversedBy: entry.reversedBy,
    reversalReason: entry.reversalReason,
  }
}

function lineDto(line: JournalLineRow): JournalLineDto {
  return {
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    partyId: line.partyId,
    memo: line.memo,
  }
}

function entryWithLinesDto(
  entry: JournalEntryRow,
  lines: readonly JournalLineRow[],
): JournalEntryWithLinesDto {
  return { ...entryDto(entry), lines: lines.map(lineDto) }
}

function notFoundBody(id: string) {
  return {
    statusCode: 404,
    error: 'entry_not_found',
    message: `Journal entry ${id} was not found.`,
  }
}

/**
 * A deterministic, server-computed uuid for a JV's referenceId, stable
 * across retries of the SAME (tenant, idempotencyKey) — see the comment at
 * this function's one call site (`post`, below) for why it must not be
 * `randomUUID()` per HTTP call.
 *
 * TECH_DEBT.md: this is a posting-identity rule (part of what makes a
 * replay a replay) sitting in an apps/api controller rather than in the
 * kernel that owns every other piece of that rule. Not moved here — out of
 * this lane's ALLOWED paths (packages/accounting-kernel/src/** beyond
 * importing its index) — flagged for the Accounting seat.
 */
function deriveReferenceId(tenantId: string, idempotencyKey: string): string {
  const hex = createHash('sha256').update(`${tenantId}:${idempotencyKey}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

@ApiTags('journals')
@Controller('journals')
export class JournalsController {
  @Get()
  @RequirePermission('voucher.view')
  @ApiOperation({
    summary: "List the caller's tenant's journal register, newest first.",
    description:
      'Filters: status, from/to (occurred_at range). Entry headers only — GET /api/journals/:id ' +
      'for line detail. Cursor pagination.',
  })
  @ApiOkResponse({ description: 'A page of journal entries.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks voucher.view.' })
  @ApiBadRequestResponse({ description: 'An unknown query key, or a malformed cursor.' })
  async list(
    @Query(new ZodValidationPipe(JournalListQuerySchema)) query: JournalListQueryDto,
    @Req() req: Request,
  ): Promise<JournalListResponseDto> {
    const after = decodeRegisterCursor(query.cursor)
    const tenantId = callerTenantId(req)

    // exactOptionalPropertyTypes: an optional field must be OMITTED, never
    // explicitly assigned `undefined` — so the filter is built by spreading
    // only the keys the caller actually supplied.
    const filter = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    }

    const page = await withTenant((tx) =>
      listJournalEntries(tx, tenantId, filter, { limit: query.limit, after }),
    )

    return { items: page.rows.map(entryDto), nextCursor: encodeCursor(page.next) }
  }

  @Get(':id')
  @RequirePermission('voucher.view')
  @ApiOperation({ summary: 'A journal entry and its lines.' })
  @ApiOkResponse({ description: 'The entry, with its full line set.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks voucher.view.' })
  @ApiNotFoundResponse({
    description: 'Unknown id, malformed id, or another tenant’s id — identically.',
  })
  async getOne(@Param('id') id: string, @Req() req: Request): Promise<JournalEntryWithLinesDto> {
    if (!isUuidShaped(id)) throw new NotFoundException(notFoundBody(id))
    const tenantId = callerTenantId(req)

    const result = await withTenant(async (tx) => {
      const entry = await findEntryById(tx, tenantId, id)
      if (!entry) return null
      const lines = await findLinesByEntryId(tx, tenantId, entry.id)
      return { entry, lines }
    })

    if (!result) throw new NotFoundException(notFoundBody(id))
    return entryWithLinesDto(result.entry, result.lines)
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('voucher.post')
  @ApiOperation({
    summary: 'Post a manual journal voucher.',
    description:
      'Requires the Idempotency-Key header (ADR-0027). Three identical requests produce one ' +
      'posting — outcome distinguishes POSTED from REPLAYED, the body is otherwise identical.',
  })
  @ApiOkResponse({ description: 'The posted (or replayed) entry, with its lines.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks voucher.post.' })
  @ApiBadRequestResponse({
    description:
      'An unknown body key, a missing Idempotency-Key header, or a kernel validation ' +
      'rejection (JV_UNBALANCED, AMOUNT_SCALE, ACCOUNT_NOT_FOUND, ...) — see the contract §7.',
  })
  @ApiConflictResponse({
    description: 'PERIOD_CLOSED, PERIOD_LOCKED, or IDEMPOTENCY_KEY_REUSED.',
  })
  async post(
    @Body(new ZodValidationPipe(PostJournalVoucherSchema)) body: PostJournalVoucherDto,
    @Req() req: Request,
  ): Promise<PostJournalVoucherResponseDto> {
    const idempotencyKey = requireIdempotencyKey(req)
    const tenantId = callerTenantId(req)

    try {
      const result = await withTenant((tx) =>
        postingEngine.post(
          {
            event: FinancialEvent.JOURNAL_VOUCHER_POSTED,
            referenceType: JOURNAL_VOUCHER_SOURCE_TYPE,
            // journal-voucher.md §2: "uuid generated server-side for this
            // voucher" — but a RETRY of the same voucher (same
            // idempotencyKey) is a separate HTTP request, so "generated"
            // must mean deterministic, not a fresh random() per call: the
            // request fingerprint (README §4) is computed FROM referenceId,
            // and postingEngine's own idempotency lookup matches by
            // (idempotencyKey, fingerprint) — a referenceId that changed on
            // every call would make every retry look like a NEW request
            // with a REUSED key (IDEMPOTENCY_KEY_REUSED) instead of a
            // replay. Deriving it from (tenant, idempotencyKey) keeps it
            // server-controlled (never client-supplied, never negotiated)
            // while being stable across retries of the same submission.
            referenceId: deriveReferenceId(tenantId, idempotencyKey),
            occurredAt: body.occurredAt,
            idempotencyKey,
            payload: {
              narration: body.narration,
              reference: body.reference ?? null,
              lines: body.lines,
            },
          },
          tx,
        ),
      )
      return { outcome: result.outcome, ...entryWithLinesDto(result.entry, result.lines) }
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermission('voucher.reverse')
  @ApiOperation({
    summary: 'Reverse a posted journal voucher.',
    description:
      'Requires the Idempotency-Key header and a reason. Only a manual JV is reversed directly ' +
      'from the journal (reversal.md §5) — a document-sourced entry refuses with ' +
      'REVERSAL_VIA_SOURCE_REQUIRED.',
  })
  @ApiOkResponse({ description: 'The reversal entry, with its lines and the disclosure flag.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks voucher.reverse.' })
  @ApiNotFoundResponse({
    description: 'Unknown id, malformed id, or another tenant’s id — identically.',
  })
  @ApiBadRequestResponse({
    description:
      'An unknown body key, a missing Idempotency-Key header, or REVERSAL_REASON_REQUIRED.',
  })
  @ApiConflictResponse({
    description:
      'PERIOD_CLOSED, PERIOD_LOCKED, IDEMPOTENCY_KEY_REUSED, ALREADY_REVERSED, ' +
      'REVERSAL_OF_REVERSAL, or REVERSAL_VIA_SOURCE_REQUIRED.',
  })
  async reverse(
    @Param('id') id: string,
    // Bound directly to @Body, not via method-level @UsePipes: a
    // method-level pipe runs on EVERY data parameter, including @Param('id')
    // (a bare string) — which would fail ReverseJournalEntrySchema's object
    // shape. @Req()/@Res() are the platform request/response and are never
    // run through the pipe chain, which is why POST /journals (Body + Req
    // only) does not have this problem.
    @Body(new ZodValidationPipe(ReverseJournalEntrySchema)) body: ReverseJournalEntryDto,
    @Req() req: Request,
  ): Promise<ReverseJournalEntryResponseDto> {
    const idempotencyKey = requireIdempotencyKey(req)
    if (!isUuidShaped(id)) throw new NotFoundException(notFoundBody(id))

    try {
      const result = await withTenant((tx) =>
        reversalEngine.reverse({ entryId: id, reason: body.reason, idempotencyKey }, tx),
      )
      return {
        outcome: result.outcome,
        ...entryWithLinesDto(result.entry, result.lines),
        disclosure: result.disclosure,
      }
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }
}
