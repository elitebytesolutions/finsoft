import { Module } from '@nestjs/common'
import { InvoicesController } from './invoices.controller'
import { ReceiptsController } from './receipts.controller'

/*
 * M3-P: the receivables module's HTTP API (sales invoices, customer
 * receipts). docs/design/M3/api-contract.md §2.
 */
@Module({
  controllers: [InvoicesController, ReceiptsController],
})
export class ReceivablesModule {}
