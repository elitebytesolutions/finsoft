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
 * balance, the chart of accounts (view, create, edit — M2-C,
 * coa-standard.md §8) and the fiscal-period lifecycle (view/close/reopen —
 * no lock route, Council ruling 2026-09-29). Deactivate stays Wave 2
 * remainder work (coa-standard.md §8.4) and is not built.
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
