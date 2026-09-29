import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
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
import { chartOfAccounts, PostingError } from '@finsoft/accounting-kernel'
import { listAllAccounts, withTenant, type AccountRow } from '@finsoft/database'
import type {
  AccountDto,
  AccountsResponseDto,
  SuggestAccountCodeResponseDto,
} from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { CreateAccountSchema, type CreateAccountDto } from './dto/create-account.dto'
import { isUuidShaped } from './dto/shared'
import {
  SuggestAccountCodeQuerySchema,
  type SuggestAccountCodeQueryDto,
} from './dto/suggest-account-code.dto'
import { UpdateAccountSchema, type UpdateAccountDto } from './dto/update-account.dto'
import { mapPostingError } from './posting-error.mapper'

/*
 * GET /api/accounts, POST /api/accounts, PATCH /api/accounts/:id,
 * GET /api/accounts/suggest-code. docs/design/M2/api-contract.md §5,
 * docs/posting-rules/coa-standard.md §8 (M2-C, 2026-09-29).
 *
 * This controller is thin: every business rule (parent/code/name
 * validation, protected-account and has-postings refusal, the §8.9
 * evaluation order, the audit record) lives in
 * `chartOfAccounts.create`/`.update`/`.suggestCode`
 * (packages/accounting-kernel/src/chart-of-accounts.ts). This file only
 * resolves the route, maps DTO -> kernel command, and maps the kernel's
 * typed rejection to HTTP (posting-error.mapper.ts).
 *
 * No Idempotency-Key here (coa-standard.md §8.7 "Idempotency": account
 * maintenance is not a posting — a duplicate create fails the second time
 * on ACCOUNT_CODE_TAKEN, a duplicate edit on ACCOUNT_VERSION_CONFLICT). See
 * this lane's report for the discrepancy with the delivery brief's generic
 * "an Idempotency-Key on create per the contract conventions" line — the
 * contract's own §1 scopes that requirement to "every POSTING endpoint",
 * and account creation is explicitly not one (coa-standard.md §8.3).
 */

function accountDto(account: AccountRow): AccountDto {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance as AccountDto['normalBalance'],
    kind: account.kind as AccountDto['kind'],
    controlKind: account.controlKind as AccountDto['controlKind'],
    role: account.role,
    restricted: account.restricted,
    parentId: account.parentId,
    isActive: account.isActive,
    version: account.version,
  }
}

function notFoundBody(id: string) {
  return { statusCode: 404, error: 'account_not_found', message: `Account ${id} was not found.` }
}

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  @Get()
  @RequirePermission('account.view')
  @ApiOperation({
    summary: 'The full chart of accounts (headers and postable accounts).',
    description:
      'Ordered by code; build the tree client-side from parentId. `version` is what a PATCH ' +
      'sends back as `expectedVersion` (coa-standard.md §8.2).',
  })
  @ApiOkResponse({ description: 'Every account of the caller’s tenant.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks account.view.' })
  async list(@Req() req: Request): Promise<AccountsResponseDto> {
    const tenantId = callerTenantId(req)
    const accounts = await withTenant((tx) => listAllAccounts(tx, tenantId))
    return { accounts: accounts.map(accountDto) }
  }

  @Get('suggest-code')
  @RequirePermission('account.manage')
  @ApiOperation({
    summary: 'A server-suggested free code in a header’s block.',
    description:
      'Advisory only (coa-standard.md §8.1): reserves nothing, re-validated at submit like any ' +
      'typed code. `code: null` if the block (all 999 codes) is exhausted.',
  })
  @ApiOkResponse({ description: 'The suggested code, or null.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks account.manage.' })
  @ApiNotFoundResponse({ description: 'Unknown parentId, malformed id, or another tenant’s id.' })
  @ApiBadRequestResponse({ description: 'The parent is not a HEADER account.' })
  async suggestCode(
    @Query(new ZodValidationPipe(SuggestAccountCodeQuerySchema)) query: SuggestAccountCodeQueryDto,
  ): Promise<SuggestAccountCodeResponseDto> {
    if (!isUuidShaped(query.parentId)) throw new NotFoundException(notFoundBody(query.parentId))
    try {
      const code = await withTenant((tx) => chartOfAccounts.suggestCode(query.parentId, tx))
      return { code }
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('account.manage')
  @ApiOperation({
    summary: 'Create a postable account under an existing header.',
    description:
      'coa-standard.md §8.1: type and normalBalance are inherited/derived, never request fields. ' +
      'Not a posting — no Idempotency-Key; a duplicate submission fails on ACCOUNT_CODE_TAKEN.',
  })
  @ApiOkResponse({ description: 'The created account.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks account.manage.' })
  @ApiNotFoundResponse({ description: 'Unknown parentId, malformed id, or another tenant’s id.' })
  @ApiBadRequestResponse({
    description: 'PAYLOAD_INVALID, ACCOUNT_CODE_FORMAT, ACCOUNT_NAME_INVALID, ...',
  })
  @ApiConflictResponse({ description: 'ACCOUNT_CODE_TAKEN or ACCOUNT_NAME_TAKEN.' })
  async create(
    @Body(new ZodValidationPipe(CreateAccountSchema)) body: CreateAccountDto,
  ): Promise<AccountDto> {
    try {
      const account = await withTenant((tx) => chartOfAccounts.create(body, tx))
      return accountDto(account)
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('account.manage')
  @ApiOperation({
    summary: 'Rename an account, or re-code/re-parent it before its first journal line.',
    description:
      'coa-standard.md §8.2: a protected account (header, role-holding, control, or restricted) ' +
      'cannot be edited at all. code and parentId freeze once the account has a journal line. ' +
      'expectedVersion is required (optimistic concurrency).',
  })
  @ApiOkResponse({ description: 'The updated account (unchanged if the edit changed nothing).' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks account.manage.' })
  @ApiNotFoundResponse({ description: 'Unknown id, malformed id, or another tenant’s id.' })
  @ApiBadRequestResponse({
    description: 'PAYLOAD_INVALID, ACCOUNT_CODE_FORMAT, ACCOUNT_PARENT_TYPE_MISMATCH, ...',
  })
  @ApiConflictResponse({
    description:
      'ACCOUNT_PROTECTED, ACCOUNT_HAS_POSTINGS, ACCOUNT_VERSION_CONFLICT, ACCOUNT_CODE_TAKEN, ACCOUNT_NAME_TAKEN.',
  })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAccountSchema)) body: UpdateAccountDto,
  ): Promise<AccountDto> {
    if (!isUuidShaped(id)) throw new NotFoundException(notFoundBody(id))
    try {
      const account = await withTenant((tx) =>
        chartOfAccounts.update({ accountId: id, payload: body }, tx),
      )
      return accountDto(account)
    } catch (error) {
      if (error instanceof PostingError) {
        // ACCOUNT_NOT_FOUND is ALSO raised by journal-voucher.ts for an
        // unknown account named inside a JV's body, where 400 is the
        // established mapping (posting-error.mapper.ts's own comment) — the
        // shared, code-keyed map cannot distinguish that case from this
        // one, a PATH parameter, where the id is a resource reference and
        // "never 403" (coa-standard.md §8.1) means 404. Special-cased here
        // rather than widened there.
        if (error.code === 'ACCOUNT_NOT_FOUND') throw new NotFoundException(notFoundBody(id))
        throw mapPostingError(error)
      }
      throw error
    }
  }
}
