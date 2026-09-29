import { Module } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CustomersModule } from '../../apps/api/src/customers/customers.module.ts'
import { MeModule } from '../../apps/api/src/me/me.module.ts'

/*
 * ADR-0028: "M3-C adds a snapshot test of the generated OpenAPI document,
 * which does not exist today, so that a contract change shows up as a diff
 * in review." Pinned as an explicit, named list of path+method pairs rather
 * than a Vitest snapshot file — this codebase has no snapshot-file
 * convention (see tests/integration/module-surface.spec.ts's own header for
 * the same reasoning). docs/design/M3/api-contract.md §2's C1-C7 and S1 rows
 * are exactly this list.
 */

let document: ReturnType<typeof SwaggerModule.createDocument>

beforeAll(async () => {
  @Module({ imports: [CustomersModule, MeModule] })
  class TestSwaggerModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestSwaggerModule] }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()

  document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('FinSoft API').setVersion('0.1.0').build(),
  )
  await app.close()
})

afterAll(() => {})

function pathMethods(path: string): string[] {
  const item = (document.paths as Record<string, Record<string, unknown>>)[path]
  return item ? Object.keys(item).sort() : []
}

describe('OpenAPI surface: modules/customers routes (C1-C7, S1)', () => {
  it('documents the exact set of /api/customers paths', () => {
    const customerPaths = Object.keys(document.paths)
      .filter((p) => p.startsWith('/api/customers'))
      .sort()

    expect(customerPaths).toEqual(
      [
        '/api/customers',
        '/api/customers/{id}',
        '/api/customers/{id}/deactivate',
        '/api/customers/{id}/reactivate',
        '/api/customers/{id}/ledger',
      ].sort(),
    )
  })

  it('C1/C2: GET and POST /api/customers', () => {
    expect(pathMethods('/api/customers')).toEqual(['get', 'post'])
  })

  it('C3/C4: GET and PATCH /api/customers/{id}', () => {
    expect(pathMethods('/api/customers/{id}')).toEqual(['get', 'patch'])
  })

  it('C5: POST /api/customers/{id}/deactivate', () => {
    expect(pathMethods('/api/customers/{id}/deactivate')).toEqual(['post'])
  })

  it('C6: POST /api/customers/{id}/reactivate', () => {
    expect(pathMethods('/api/customers/{id}/reactivate')).toEqual(['post'])
  })

  it('C7: GET /api/customers/{id}/ledger', () => {
    expect(pathMethods('/api/customers/{id}/ledger')).toEqual(['get'])
  })

  it('S1: GET /api/me/permissions', () => {
    expect(pathMethods('/api/me/permissions')).toEqual(['get'])
  })

  it('every operation carries a documented summary (no undocumented route)', () => {
    const allCustomerAndMePaths = Object.keys(document.paths).filter(
      (p) => p.startsWith('/api/customers') || p.startsWith('/api/me'),
    )
    for (const path of allCustomerAndMePaths) {
      const operations = (document.paths as Record<string, Record<string, { summary?: string }>>)[
        path
      ]
      for (const [method, op] of Object.entries(operations ?? {})) {
        expect(
          op.summary,
          `${method.toUpperCase()} ${path} has no @ApiOperation summary`,
        ).toBeTruthy()
      }
    }
  })
})
