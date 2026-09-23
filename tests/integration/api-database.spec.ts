import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withGlobal } from '@finsoft/database'
import {
  prepareTestDatabase,
  rawOn,
  scalarOn,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { HealthModule } from '../../apps/api/src/health/health.module.ts'

/*
 * API to PostgreSQL, over real HTTP, against a real database.
 *
 * apps/api's own suite already proves the readiness route answers and reports
 * a schema version. What it does not prove — and what this file exists for —
 * is WHICH ROLE the request travelled as.
 *
 * That distinction is the whole of ADR-0004. A readiness probe that returns
 * `ready` proves the API reached a database; it does not prove it reached it
 * as `finsoft_app`. If the pool were pointed at `finsoft_migration`, every
 * test here would still pass while RLS had been silently switched off for the
 * entire application, because BYPASSRLS is exactly what that role has.
 */

let app: INestApplication

beforeAll(async () => {
  await prepareTestDatabase()

  const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await teardownTestDatabase()
})

describe('a request reaches PostgreSQL', () => {
  it('answers readiness from the live database, not from a cached value', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200)

    expect(res.body.status).toBe('ready')
    expect(res.body.checks.database.status).toBe('up')

    /*
     * The detail names the schema version it found AND the one it required.
     * A count of applied migrations would say the database has *some* schema,
     * not the one this build expects.
     */
    expect(res.body.checks.database.detail).toMatch(/schema \d+, requires \d+/)
  })

  it('reports the schema version that is actually applied', async () => {
    const applied = await withGlobal((tx) =>
      scalarOn<string>(tx, 'SELECT max(version)::text FROM schema_migrations'),
    )
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200)

    expect(res.body.checks.database.detail).toContain(`schema ${applied}`)
  })
})

describe('the request travels as the restricted role', () => {
  /*
   * Asserted against the connection the APPLICATION uses, not a connection
   * the test opens for itself: withGlobal hands out a transaction on the
   * application pool — the same pool the readiness probe above used.
   */
  it('connects as finsoft_app', async () => {
    const who = await withGlobal((tx) => scalarOn<string>(tx, 'SELECT current_user'))
    expect(who).toBe('finsoft_app')
  })

  it('that role cannot bypass row level security', async () => {
    const [row] = await withGlobal((tx) =>
      rawOn<{ rolsuper: boolean; rolbypassrls: boolean }>(
        tx,
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    )

    /*
     * ADR-0004:57 calls this pair "the difference between RLS being a control
     * and RLS being decoration". Either flag true and every policy in the
     * database is advisory for this connection.
     */
    expect(row?.rolsuper, 'the application role must not be SUPERUSER').toBe(false)
    expect(row?.rolbypassrls, 'the application role must not have BYPASSRLS').toBe(false)
  })

  it('is not the migration role, which does have BYPASSRLS', async () => {
    /*
     * Stated as its own assertion because it is the specific mistake worth
     * catching: pointing DATABASE_URL at the migration role makes everything
     * work, and turns RLS off for the whole application at once.
     */
    const who = await withGlobal((tx) => scalarOn<string>(tx, 'SELECT current_user'))
    expect(who).not.toBe('finsoft_migration')
  })

  it('cannot create tables, so a compromised request cannot alter the schema', async () => {
    await expect(
      withGlobal((tx) => rawOn(tx, 'CREATE TABLE should_not_exist (id int)')),
    ).rejects.toThrow()
  })
})
