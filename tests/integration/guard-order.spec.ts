import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionGuard } from '../../apps/api/src/common/permission.guard.ts'
import { TenantGuard } from '../../apps/api/src/common/tenant.guard.ts'

/*
 * M1-X, Council SEC-C1/C2: PermissionGuard must be registered as a global
 * APP_GUARD that runs AFTER TenantGuard, so that req.auth is always set (or
 * the request has already been rejected) before PermissionGuard reads it.
 *
 * This exercises the REAL apps/api/src/app.module.ts wiring, not a
 * hand-built test module — the assertion is about the actual registration
 * order in that file, not about a reimplementation of it. Both guards'
 * canActivate are spied (call-through) to record invocation order; no
 * database or Redis connection is touched by either case below.
 */

let app: INestApplication
const callOrder: string[] = []

const originalTenantCanActivate = TenantGuard.prototype.canActivate
const originalPermissionCanActivate = PermissionGuard.prototype.canActivate

beforeEach(async () => {
  callOrder.length = 0

  vi.spyOn(TenantGuard.prototype, 'canActivate').mockImplementation(function (
    this: TenantGuard,
    ...args: Parameters<typeof originalTenantCanActivate>
  ) {
    callOrder.push('TenantGuard')
    return originalTenantCanActivate.apply(this, args)
  })

  vi.spyOn(PermissionGuard.prototype, 'canActivate').mockImplementation(function (
    this: PermissionGuard,
    ...args: Parameters<typeof originalPermissionCanActivate>
  ) {
    callOrder.push('PermissionGuard')
    return originalPermissionCanActivate.apply(this, args)
  })

  const { AppModule } = await import('../../apps/api/src/app.module.ts')
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()
}, 60_000)

afterEach(async () => {
  await app?.close()
  vi.restoreAllMocks()
})

describe('global guard order (app.module.ts): TenantGuard, then PermissionGuard', () => {
  it('on a @Public() route, both guards run, TenantGuard first', async () => {
    const res = await request(app.getHttpServer()).get('/api/health')
    expect(res.status).toBe(200)
    expect(callOrder).toEqual(['TenantGuard', 'PermissionGuard'])
  })

  it(
    'on an authenticated, permission-protected route with NO credentials, ' +
      'TenantGuard rejects before PermissionGuard ever runs',
    async () => {
      const res = await request(app.getHttpServer()).get('/api/audit')
      expect(res.status).toBe(401)
      // PermissionGuard is never invoked: had it run first (the wrong order),
      // it would 401 on the missing req.auth without TenantGuard ever having
      // been called at all, and this array would read the other way round.
      expect(callOrder).toEqual(['TenantGuard'])
    },
  )
})
