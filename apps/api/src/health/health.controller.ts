import { Controller, Get, HttpCode, Res } from '@nestjs/common'
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Response } from 'express'
import { Public } from '../common/tenant.guard'
import { HealthService } from './health.service'

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. Answers only "is this process running".
   *
   * Public because an orchestrator and a load balancer have no credentials
   * and no tenant. It exposes nothing beyond uptime — no version, no
   * hostname, no dependency detail — because it is unauthenticated.
   */
  @Public()
  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Liveness probe. Touches no dependency.' })
  @ApiOkResponse({ description: 'The process is running.' })
  liveness() {
    return this.health.liveness()
  }

  /**
   * Readiness. Answers "can this process serve traffic".
   *
   * Returns 503 when a dependency is down, so a load balancer removes this
   * instance instead of sending it requests that will fail. The status code
   * is the contract; the body is for humans reading a terminal.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe. Verifies the database is reachable and migrated.' })
  @ApiOkResponse({ description: 'Every dependency is up.' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down.' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness()
    res.status(report.status === 'ready' ? 200 : 503)
    return report
  }
}
