import { SupportConnectionRoleError, verifyAuditChain } from '@finsoft/database'
import { prepareTestDatabase, teardownTestDatabase } from '@finsoft/database/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The verifier's readonly_support connection must actually BE
 * readonly_support, not merely have asked to be. Measured: libpq (and
 * therefore node-pg) honours a `user` — and a `password` — query parameter
 * in a connection string as an OVERRIDE of the URL's own userinfo. A
 * connection string carrying `?user=finsoft_migration&password=...`
 * reconnects as that role entirely, regardless of what
 * openSupportConnection's own URL construction set `url.username` to.
 * `current_user` is asked of PostgreSQL itself after connecting, rather than
 * trusted from the string that asked for the connection.
 */

beforeAll(prepareTestDatabase, 60_000)
afterAll(teardownTestDatabase)

describe('the readonly_support connection refuses a role override', () => {
  it('rejects a connection string carrying a ?user= override to finsoft_app', async () => {
    const base = process.env['TEST_DATABASE_URL']
    if (!base) throw new Error('TEST_DATABASE_URL is not set')

    // Simulates exactly the override this file's header describes: a
    // TEST_DATABASE_URL-shaped variable carrying a query-string override,
    // exercised through the real openSupportConnection code path by
    // pointing baseUrlVar at a temporary env var built the same way
    // asReadonlySupport builds its own URL, plus the override.
    const overridden = new URL(base)
    overridden.searchParams.set('user', 'finsoft_app')
    overridden.searchParams.set('password', overridden.password || 'local-dev-only-app')
    process.env['TEST_DATABASE_URL_WITH_OVERRIDE'] = overridden.toString()

    try {
      await expect(verifyAuditChain(undefined, 'TEST_DATABASE_URL_WITH_OVERRIDE')).rejects.toThrow(
        SupportConnectionRoleError,
      )
    } finally {
      delete process.env['TEST_DATABASE_URL_WITH_OVERRIDE']
    }
  })
})
