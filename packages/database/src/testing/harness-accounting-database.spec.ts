import { describe, expect, it } from 'vitest'
import { assertLocalDatabaseHost, assertTestDatabaseName } from './harness.ts'

/*
 * QA-001, Security seat review 2026-10-01 (changes required against
 * 15644fe). Two guards in harness.ts's accounting-database mechanism, both
 * pure functions over a connection-string URL — no database needed.
 */

describe('assertLocalDatabaseHost', () => {
  it('accepts localhost, 127.0.0.1 and ::1', () => {
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@localhost:5432/postgres'),
    ).not.toThrow()
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@127.0.0.1:5432/postgres'),
    ).not.toThrow()
    // WHATWG URL keeps an IPv6 host bracketed in the connection string
    // itself ("[::1]"); the function must still recognise it as ::1.
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@[::1]:5432/postgres'),
    ).not.toThrow()
  })

  it('refuses a non-local host', () => {
    // The exact failure this guard exists to prevent: the cluster's
    // bootstrap login (finsoft_bootstrap — the real Postgres
    // superuser-equivalent) reaching anywhere but the local test cluster.
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@db.example.com:5432/postgres'),
    ).toThrow(/Refusing to connect to "db\.example\.com"/)
  })

  it('refuses a non-local IP address', () => {
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@10.0.0.5:5432/postgres'),
    ).toThrow(/Refusing to connect to "10\.0\.0\.5"/)
  })

  it('refuses a bare hostname that merely contains "local"', () => {
    // Guards against a substring-match implementation sneaking back in —
    // this must be an exact match against the allowed set, not a contains.
    expect(() =>
      assertLocalDatabaseHost('postgresql://finsoft_bootstrap:x@notlocalhost:5432/postgres'),
    ).toThrow(/Refusing to connect to "notlocalhost"/)
  })
})

describe('assertTestDatabaseName', () => {
  const accepted = [
    'postgresql://finsoft_app:x@localhost:5433/finsoft_test',
    'postgresql://finsoft_app:x@localhost:5433/finsoft_test_accounting',
  ]

  it.each(accepted)('accepts %s', (url) => {
    expect(() => assertTestDatabaseName(url, 'TEST_EXAMPLE_URL')).not.toThrow()
  })

  const rejected = [
    // Security seat review, 2026-10-01: the OLD guard used
    // `.includes('_test')`, which both of these satisfy — exactly the
    // weakness being fixed. Neither ENDS in '_test' or '_test_accounting'.
    'postgresql://finsoft_app:x@localhost:5433/finsoft_test_prod',
    'postgresql://finsoft_app:x@localhost:5433/prod_test_x',
    'postgresql://finsoft_app:x@localhost:5433/finsoft',
    'postgresql://finsoft_app:x@localhost:5433/production',
  ]

  it.each(rejected)('rejects %s', (url) => {
    expect(() => assertTestDatabaseName(url, 'TEST_EXAMPLE_URL')).toThrow(
      /is not a test database name/,
    )
  })
})
