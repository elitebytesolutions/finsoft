import { Controller, Get, Req } from '@nestjs/common'
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request } from 'express'
import { listAllAccounts, withTenant } from '@finsoft/database'
import type { AccountDto, AccountsResponseDto } from '@finsoft/shared-types'
import { RequirePermission } from '../common/permission.decorator'
import { callerTenantId } from './caller'

/*
 * GET /api/accounts. docs/design/M2/api-contract.md §5.
 *
 * Council ruling, 2026-09-29: read-only, `account.view`. POST /api/accounts
 * stays Wave 2 remainder work (coa-standard.md §5) — no route for it here.
 */

function accountDto(account: {
  id: string
  code: string
  name: string
  type: string
  normalBalance: string
  kind: string
  controlKind: string
  role: string | null
  restricted: boolean
  parentId: string | null
  isActive: boolean
}): AccountDto {
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
  }
}

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  @Get()
  @RequirePermission('account.view')
  @ApiOperation({
    summary: 'The full chart of accounts (headers and postable accounts).',
    description:
      'Read-only in the MVP (coa-standard.md §5) — create/rename/deactivate are Wave 2 ' +
      'remainder work and are not built here. Ordered by code; build the tree client-side from parentId.',
  })
  @ApiOkResponse({ description: 'Every account of the caller’s tenant.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiForbiddenResponse({ description: 'The caller lacks account.view.' })
  async list(@Req() req: Request): Promise<AccountsResponseDto> {
    const tenantId = callerTenantId(req)
    const accounts = await withTenant((tx) => listAllAccounts(tx, tenantId))
    return { accounts: accounts.map(accountDto) }
  }
}
