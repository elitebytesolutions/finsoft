import { Module } from '@nestjs/common'
import { MePermissionsController } from './me-permissions.controller'

/** S1 — GET /api/me/permissions. See that controller's own header. */
@Module({
  controllers: [MePermissionsController],
})
export class MeModule {}
