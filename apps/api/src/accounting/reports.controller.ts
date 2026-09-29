import { Controller, Get, Query, Req } from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request } from 'express'
import { trialBalance as computeTrialBalance } from '@finsoft/reporting'
import { Money } from '@finsoft/validation'
import { withTenant } from '@finsoft/database'
import type { TrialBalanceResponseDto } from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { TrialBalanceQuerySchema, type TrialBalanceQueryDto } from './dto/trial-balance-query.dto'

/*
 * GET /api/reports/trial-balance. docs/design/M2/api-contract.md §4.
 *
 * "Totals must be equal: assert it and never paper over a difference"
 * (the brief, quoting CLAUDE.md's "never add a rounding tolerance to get to
 * green"). @finsoft/reporting's trialBalance already computes both totals
 * from the same stored numeric(19,4) values with no tolerance (Invariant 2);
 * the assertion below is this endpoint's own belt-and-braces check that it
 * never SHIPS a disagreement to a caller — if it ever fires, that is
 * Invariant 2 broken, a genuine defect, reported as an opaque 500 by
 * AllExceptionsFilter (never smoothed into a "difference" field, never
 * caught and re-labelled as a 4xx).
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  @Get('trial-balance')
  @RequirePermission('report.financial')
  @ApiOperation({
    summary: 'The trial balance as of a date.',
    description:
      'Every POSTABLE account with activity on or before asOf. totalDebit always equals totalCredit exactly.',
  })
  @ApiOkResponse({ description: 'The trial balance.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks report.financial.' })
  @ApiBadRequestResponse({ description: 'An unknown query key, or a malformed asOf date.' })
  async trialBalance(
    @Query(new ZodValidationPipe(TrialBalanceQuerySchema)) query: TrialBalanceQueryDto,
    @Req() req: Request,
  ): Promise<TrialBalanceResponseDto> {
    const tenantId = callerTenantId(req)

    const result = await withTenant((tx) => computeTrialBalance(tx, tenantId, query.asOf))

    if (!Money.equals(Money.from(result.totalDebit), Money.from(result.totalCredit))) {
      throw new Error(
        `Trial balance does not balance as of ${query.asOf}: debit ${result.totalDebit}, ` +
          `credit ${result.totalCredit}. This is Invariant 2 broken, not a request error.`,
      )
    }

    return result
  }
}
