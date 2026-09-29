import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request } from 'express'
import { accountLedger } from '@finsoft/reporting'
import { findAccountsByIds, withTenant } from '@finsoft/database'
import type { AccountLedgerResponseDto } from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { decodeLedgerCursor, encodeLedgerCursor } from './cursor'
import { LedgerQuerySchema, type LedgerQueryDto } from './dto/ledger-query.dto'
import { isUuidShaped } from './dto/shared'

/*
 * GET /api/ledgers/:accountId. docs/design/M2/api-contract.md §3.
 *
 * All arithmetic (opening balance, running balance, sign) is
 * @finsoft/reporting's accountLedger — this controller reads the account
 * header (for the response's code/name/type and its own existence check)
 * and hands everything else to that one function.
 *
 * M2-B Council ruling, 2026-09-29: the cursor carries no financial number.
 * accountLedger recomputes the carry-forward balance server-side from the
 * cursor's POSITION (packages/reporting/src/ledger.ts). This controller's
 * job is binding the cursor to the request that presented it — a cursor
 * issued for a different accountId/from/to/partyId is 400, never silently
 * reused against the new context (cursor.ts, decodeLedgerCursor).
 */

function notFoundBody(accountId: string) {
  return {
    statusCode: 404,
    error: 'account_not_found',
    message: `Account ${accountId} was not found.`,
  }
}

@ApiTags('ledgers')
@Controller('ledgers')
export class LedgersController {
  @Get(':accountId')
  @RequirePermission('report.financial')
  @ApiOperation({
    summary: 'One account’s ledger: opening balance, lines, running balance, closing balance.',
    description:
      'from/to required. partyId is accepted but inert until M3 (no IMPLEMENTED rule carries a ' +
      'party yet). Cursor pagination — a resumed page recomputes its carry-forward balance ' +
      'server-side from the cursor’s position; the cursor never carries a balance.',
  })
  @ApiOkResponse({ description: 'The ledger page.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks report.financial.' })
  @ApiNotFoundResponse({ description: 'Unknown accountId, or another tenant’s account.' })
  @ApiBadRequestResponse({
    description:
      'An unknown query key, a malformed cursor, or a cursor issued for a different ' +
      'accountId/from/to/partyId.',
  })
  async get(
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(LedgerQuerySchema)) query: LedgerQueryDto,
    @Req() req: Request,
  ): Promise<AccountLedgerResponseDto> {
    if (!isUuidShaped(accountId)) throw new NotFoundException(notFoundBody(accountId))
    const tenantId = callerTenantId(req)
    const partyId = query.partyId ?? null
    const cursorContext = { accountId, from: query.from, to: query.to, partyId }
    const after = decodeLedgerCursor(query.cursor, cursorContext)

    const result = await withTenant(async (tx) => {
      const accounts = await findAccountsByIds(tx, tenantId, [accountId])
      const account = accounts.get(accountId)
      if (!account) return null

      const ledger = await accountLedger(tx, tenantId, accountId, {
        from: query.from,
        to: query.to,
        partyId,
        limit: query.limit,
        after,
      })
      return { account, ledger }
    })

    if (!result) throw new NotFoundException(notFoundBody(accountId))
    const { account, ledger } = result

    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      openingBalance: ledger.openingBalance,
      closingBalance: ledger.closingBalance,
      lines: ledger.lines,
      nextCursor: encodeLedgerCursor(ledger.next, cursorContext),
    }
  }
}
