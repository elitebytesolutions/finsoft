import { Controller, Get, Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { AuthenticatedOnly } from '../../apps/api/src/common/authenticated-only.decorator.ts'
import { RequirePermission } from '../../apps/api/src/common/permission.decorator.ts'
import { RouteDecorationCheck } from '../../apps/api/src/common/route-decoration.check.ts'
import { Public } from '../../apps/api/src/common/tenant.guard.ts'

/*
 * M1-X, Council SEC-C1/C2: the startup check that every route declares
 * @Public(), @RequirePermission(...) or @AuthenticatedOnly(). This is the
 * "aborts boot" half of the contract, exercised directly rather than through
 * apps/api/src/app.module.ts's own controllers (which are, correctly,
 * already fully decorated and so cannot demonstrate a FAILING case).
 */

@Controller('undecorated')
class UndecoratedController {
  /** No @Public / @RequirePermission / @AuthenticatedOnly at all. */
  @Get('whoops')
  whoops() {
    return { reached: true }
  }
}

@Controller('decorated')
class FullyDecoratedController {
  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true }
  }

  @RequirePermission('audit.view')
  @Get('permissioned')
  permissioned() {
    return { ok: true }
  }

  @AuthenticatedOnly()
  @Get('authenticated-only')
  authenticatedOnly() {
    return { ok: true }
  }

  /** A plain method, no HTTP verb decorator — must never count as a route. */
  helper() {
    return 'not a route'
  }
}

describe('RouteDecorationCheck: the startup route-decoration check', () => {
  it('aborts app.init() when a route carries none of the three markers', async () => {
    @Module({
      imports: [DiscoveryModule],
      controllers: [UndecoratedController],
      providers: [RouteDecorationCheck],
    })
    class BadModule {}

    const moduleRef = await Test.createTestingModule({ imports: [BadModule] }).compile()
    const app = moduleRef.createNestApplication()

    await expect(app.init()).rejects.toThrow(/UndecoratedController\.whoops/)
    await app.close()
  })

  it('boots cleanly when every route is decorated, and ignores non-route methods', async () => {
    @Module({
      imports: [DiscoveryModule],
      controllers: [FullyDecoratedController],
      providers: [RouteDecorationCheck],
    })
    class GoodModule {}

    const moduleRef = await Test.createTestingModule({ imports: [GoodModule] }).compile()
    const app = moduleRef.createNestApplication()

    await expect(app.init()).resolves.toBeDefined()
    await app.close()
  })
})
