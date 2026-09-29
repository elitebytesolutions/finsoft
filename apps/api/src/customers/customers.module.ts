import { Module } from '@nestjs/common'
import { CustomersController } from './customers.controller'

/*
 * M3-C: the customers module's HTTP API. docs/design/M3/api-contract.md §2.
 * `GET /api/me/permissions` (S1) is registered separately, from
 * apps/api/src/me/ — see that controller's own header for why.
 */
@Module({
  controllers: [CustomersController],
})
export class CustomersModule {}
