import { Module } from '@nestjs/common'
import { JournalsController } from './journals.controller'
import { LedgersController } from './ledgers.controller'
import { ReportsController } from './reports.controller'

/*
 * M2-B: the accounting HTTP API. docs/design/M2/api-contract.md.
 *
 * Journals (register, detail, post, reverse), the account ledger and the
 * trial balance. Chart-of-accounts and fiscal-period routes are NOT here —
 * see the contract doc §5/§6 for why (no permission code exists for either,
 * and account creation additionally conflicts with an APPROVED posting
 * rule; both are raised as open items rather than built).
 */
@Module({
  controllers: [JournalsController, LedgersController, ReportsController],
})
export class AccountingModule {}
