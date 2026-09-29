import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { accountLedger } from '@finsoft/reporting'
import { findAccountsByIds, withTenant } from '@finsoft/database'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { decodeCursor, encodeCursor, isLedgerCursorShape } from './cursor'
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
 * accountLedger's own contract: resuming past page 1 needs the PREVIOUS
 * page's closing balance, because the running balance cannot be recomputed
 * from `from` alone once paging has moved past it. This controller's
 * opaque cursor therefore carries `closingBalance` alongside
 * packages/reporting's own LedgerCursor fields (cursor.ts,
 * isLedgerCursorShape) — the client passes it back unchanged, exactly as
 * every other cursor here, and never sees or reasons about the balance
 * inside it.
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
  async get(
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(LedgerQuerySchema)) query: LedgerQueryDto,
    @Req() req: Request,
  ) {
    if (!isUuidShaped(accountId)) throw new NotFoundException(notFoundBody(accountId))
    const tenantId = callerTenantId(req)
    const cursor = decodeCursor(query.cursor, isLedgerCursorShape)

    const result = await withTenant(async (tx) => {
      const accounts = await findAccountsByIds(tx, tenantId, [accountId])
      const account = accounts.get(accountId)
      if (!account) return null

      const ledger = await accountLedger(tx, tenantId, accountId, {
        from: query.from,
        to: query.to,
        partyId: query.partyId ?? null,
        limit: query.limit,
        ...(cursor === null
          ? { after: null }
          : {
              after: {
                occurredAt: cursor.occurredAt,
                createdAt: cursor.createdAt,
                entryNumber: cursor.entryNumber,
                lineNumber: cursor.lineNumber,
              },
              carryForwardBalance: cursor.closingBalance,
            }),
      })
      return { account, ledger }
    })

    if (!result) throw new NotFoundException(notFoundBody(accountId))
    const { account, ledger } = result

    const nextCursor =
      ledger.next === null
        ? null
        : encodeCursor({ ...ledger.next, closingBalance: ledger.closingBalance })

    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      openingBalance: ledger.openingBalance,
      closingBalance: ledger.closingBalance,
      lines: ledger.lines,
      nextCursor,
    }
  }
}
