import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
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
import { periodEngine, PostingError } from '@finsoft/accounting-kernel'
import { findPeriodById, listPeriods, withTenant, type FiscalPeriodRow } from '@finsoft/database'
import type { FiscalPeriodDto, PeriodsResponseDto } from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { callerTenantId } from './caller'
import { ReopenPeriodSchema, type ReopenPeriodDto } from './dto/reopen-period.dto'
import { isUuidShaped } from './dto/shared'
import { mapPostingError } from './posting-error.mapper'

/*
 * GET /api/periods, POST /api/periods/:id/{close,reopen}.
 * docs/design/M2/api-contract.md §6, Council ruling 2026-09-29.
 *
 * Every transition goes through periodEngine.close/reopen
 * (packages/accounting-kernel) — this controller never writes
 * fiscal_periods itself and never decides the §4.1 ordering rules; it only
 * resolves the route's :id (a period's uuid) to the label the kernel's API
 * takes, and maps the kernel's typed rejections to HTTP (§7).
 *
 * There is no lock route and no period.lock permission (Council ruling): M2
 * builds view/close/reopen only.
 */

function periodDto(period: FiscalPeriodRow): FiscalPeriodDto {
  return {
    id: period.id,
    fiscalYear: period.fiscalYear,
    periodIndex: period.periodIndex,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    label: period.label,
    status: period.status,
  }
}

function notFoundBody(id: string) {
  return {
    statusCode: 404,
    error: 'period_not_found',
    message: `Fiscal period ${id} was not found.`,
  }
}

@ApiTags('periods')
@Controller('periods')
export class PeriodsController {
  @Get()
  @RequirePermission('period.view')
  @ApiOperation({ summary: 'Every fiscal period of the caller’s tenant, chronological order.' })
  @ApiOkResponse({ description: 'The tenant’s fiscal calendar.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks period.view.' })
  async list(@Req() req: Request): Promise<PeriodsResponseDto> {
    const tenantId = callerTenantId(req)
    const periods = await withTenant((tx) => listPeriods(tx, tenantId))
    return { periods: periods.map(periodDto) }
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('period.close')
  @ApiOperation({
    summary: 'Close a fiscal period.',
    description:
      'Only when every earlier period of the tenant is CLOSED or LOCKED (periods.md §4.1). ' +
      'Produces no journal entry.',
  })
  @ApiOkResponse({ description: 'The closed period.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks period.close.' })
  @ApiNotFoundResponse({ description: 'Unknown id, malformed id, or another tenant’s id.' })
  @ApiConflictResponse({
    description: 'PERIOD_CLOSE_OUT_OF_ORDER, or the period is already CLOSED/LOCKED.',
  })
  async close(@Param('id') id: string, @Req() req: Request): Promise<FiscalPeriodDto> {
    if (!isUuidShaped(id)) throw new NotFoundException(notFoundBody(id))
    const tenantId = callerTenantId(req)

    const label = await withTenant(async (tx) => {
      const period = await findPeriodById(tx, tenantId, id)
      return period?.label ?? null
    })
    if (label === null) throw new NotFoundException(notFoundBody(id))

    try {
      const period = await withTenant((tx) => periodEngine.close(label, tx))
      return periodDto(period)
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('period.reopen')
  @ApiOperation({
    summary: 'Reopen the latest closed fiscal period.',
    description:
      'Owner only (Council ruling). A reason is required. Only the LATEST closed period may be ' +
      'reopened (periods.md §4.1) — a LOCKED period never reopens.',
  })
  @ApiOkResponse({ description: 'The reopened period.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks period.reopen.' })
  @ApiNotFoundResponse({ description: 'Unknown id, malformed id, or another tenant’s id.' })
  @ApiBadRequestResponse({ description: 'An unknown body key, or PERIOD_REOPEN_REASON_REQUIRED.' })
  @ApiConflictResponse({
    description: 'PERIOD_REOPEN_OUT_OF_ORDER, PERIOD_LOCKED, or the period is not CLOSED.',
  })
  async reopen(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReopenPeriodSchema)) body: ReopenPeriodDto,
    @Req() req: Request,
  ): Promise<FiscalPeriodDto> {
    if (!isUuidShaped(id)) throw new NotFoundException(notFoundBody(id))
    const tenantId = callerTenantId(req)

    const label = await withTenant(async (tx) => {
      const period = await findPeriodById(tx, tenantId, id)
      return period?.label ?? null
    })
    if (label === null) throw new NotFoundException(notFoundBody(id))

    try {
      const period = await withTenant((tx) => periodEngine.reopen(label, body.reason, tx))
      return periodDto(period)
    } catch (error) {
      if (error instanceof PostingError) throw mapPostingError(error)
      throw error
    }
  }
}
