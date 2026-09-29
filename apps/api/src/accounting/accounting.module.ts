import { Module } from '@nestjs/common'
import { AccountsController } from './accounts.controller'
import { JournalsController } from './journals.controller'
import { LedgersController } from './ledgers.controller'
import { PeriodsController } from './periods.controller'
import { ReportsController } from './reports.controller'

/*
 * The accounting HTTP API. docs/design/M2/api-contract.md.
 *
 * Journals (register, detail, post, reverse), the account ledger, the trial
 * balance, the read-only chart of accounts and the fiscal-period lifecycle
 * (view/close/reopen — no lock route, Council ruling 2026-09-29).
 * POST /api/accounts stays Wave 2 remainder work (coa-standard.md §5) and
 * is not built.
 */
@Module({
  controllers: [
    AccountsController,
    JournalsController,
    LedgersController,
    PeriodsController,
    ReportsController,
  ],
})
export class AccountingModule {}
