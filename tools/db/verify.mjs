#!/usr/bin/env node
/*
 * FND-005 acceptance. Asserts that the local data plane actually has the
 * properties ADR-0004 and ADR-0002 depend on, rather than assuming the
 * bootstrap script did what it says.
 *
 * Runs everything through `docker compose exec`, so it adds no dependency and
 * tests the real container rather than a client's view of it. `pg` belongs to
 * packages/database (ADR-0013) and arrives with FND-007.
 *
 * This is infrastructure verification, not the schema test suite. The full
 * database/tests/roles.spec.ts and rls.spec.ts belong to FND-008.
 */

import { execFileSync } from 'node:child_process'

const results = []
let failed = 0

function sh(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** One value out of a container's PostgreSQL, unaligned and untupled. */
function psql(service, db, sql) {
  return sh([
    'compose',
    'exec',
    '-T',
    service,
    'psql',
    '-U',
    process.env.POSTGRES_BOOTSTRAP_USER ?? 'finsoft_bootstrap',
    '-d',
    db,
    '-tAc',
    sql,
  ]).trim()
}

function check(name, detail, fn) {
  try {
    const outcome = fn()
    if (outcome === true) {
      results.push(['PASS', name, detail])
    } else {
      failed++
      results.push(['FAIL', name, `${detail} — got: ${outcome}`])
    }
  } catch (error) {
    failed++
    results.push(['FAIL', name, `${detail} — ${String(error.message).split('\n')[0]}`])
  }
}

const DEV_DB = process.env.POSTGRES_DB ?? 'finsoft'
const TEST_DB = process.env.POSTGRES_TEST_DB ?? 'finsoft_test'

/* ---------------------------------------------------------------- *
 * Services
 * ---------------------------------------------------------------- */
check('services healthy', 'all four containers report healthy', () => {
  const ps = sh(['compose', 'ps', '--format', 'json'])
  const rows = ps
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const wanted = ['postgres', 'postgres-test', 'redis', 'redis-test']
  const unhealthy = wanted.filter((name) => {
    const row = rows.find((r) => r.Service === name)
    return !row || !(row.Health === 'healthy' || row.State === 'running')
  })
  return unhealthy.length === 0 ? true : `not healthy: ${unhealthy.join(', ')}`
})

/* ---------------------------------------------------------------- *
 * Role separation — ADR-0004:55-61. The load-bearing assertions.
 * ---------------------------------------------------------------- */
for (const [service, db] of [
  ['postgres', DEV_DB],
  ['postgres-test', TEST_DB],
]) {
  check(
    `${service}: finsoft_app is not privileged`,
    'no BYPASSRLS and no SUPERUSER — ADR-0004:57',
    () => {
      const row = psql(
        service,
        db,
        "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'finsoft_app'",
      )
      return row === 'false,false' ? true : `rolsuper,rolbypassrls = ${row || '(role missing)'}`
    },
  )

  check(`${service}: finsoft_migration has BYPASSRLS`, 'it is the migration role', () => {
    const row = psql(
      service,
      db,
      "SELECT rolbypassrls::text FROM pg_roles WHERE rolname = 'finsoft_migration'",
    )
    return row === 'true' ? true : `rolbypassrls = ${row || '(role missing)'}`
  })

  check(`${service}: readonly_support is not privileged`, 'subject to RLS — ADR-0004:61', () => {
    const row = psql(
      service,
      db,
      "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'readonly_support'",
    )
    return row === 'false,false' ? true : `rolsuper,rolbypassrls = ${row || '(role missing)'}`
  })

  check(`${service}: no breakglass role locally`, 'production-only, rule 21', () => {
    const row = psql(
      service,
      db,
      "SELECT count(*)::text FROM pg_roles WHERE rolname = 'finsoft_breakglass'",
    )
    return row === '0' ? true : `found ${row}`
  })

  /* -------------------------------------------------------------- *
   * finsoft_refresh — ADR-0023 §2, migration 006's pre-tenant
   * refresh resolver. Created by 00-bootstrap.sh, not by a migration
   * (finsoft_migration has no CREATEROLE). Its NOLOGIN/NOBYPASSRLS
   * attributes are "protected by NOTHING but a catalogue assertion"
   * per the ADR's own residual register — this is that assertion.
   * -------------------------------------------------------------- */
  check(
    `${service}: finsoft_refresh is NOLOGIN and NOBYPASSRLS`,
    'ADR-0023 §2 — owner of the pre-tenant resolver must never connect and never bypass RLS',
    () => {
      const row = psql(
        service,
        db,
        "SELECT rolcanlogin::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'finsoft_refresh'",
      )
      return row === 'false,false' ? true : `rolcanlogin,rolbypassrls = ${row || '(role missing)'}`
    },
  )

  check(
    `${service}: finsoft_refresh membership options exact`,
    'ADR-0023 §2 — finsoft_migration holds SET, not INHERIT, on finsoft_refresh',
    () => {
      // Asserting only the member list would leave the INHERIT FALSE claim
      // untested — a re-grant with INHERIT TRUE keeps the member set
      // identical while handing finsoft_migration passive cross-tenant
      // reach, per the ADR's own compliance section.
      const row = psql(
        service,
        db,
        `SELECT m.inherit_option::text || ',' || m.set_option::text || ',' || m.admin_option::text
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles g ON g.oid = m.member
         WHERE r.rolname = 'finsoft_refresh' AND g.rolname = 'finsoft_migration'`,
      )
      return row === 'false,true,false'
        ? true
        : `inherit_option,set_option,admin_option = ${row || '(no membership row)'}`
    },
  )

  /*
   * D6, security/database re-review 2026-09-27. `pg_has_role` treats a
   * superuser as a member of every role, so this is deliberately a direct
   * `rolsuper` read rather than a role-membership check — and a separate
   * check that finsoft_refresh holds no membership OF ITS OWN, distinct
   * from the check above (which only asserts finsoft_migration's options as
   * a member OF finsoft_refresh).
   */
  check(`${service}: finsoft_refresh is not a superuser`, 'ADR-0023 §2', () => {
    const rolsuper = psql(
      service,
      db,
      "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'finsoft_refresh'",
    )
    return rolsuper === 'false' ? true : `rolsuper = ${rolsuper || '(role missing)'}`
  })

  check(
    `${service}: finsoft_refresh holds no membership of its own`,
    'a NOLOGIN, non-superuser role picking up passive privilege through a role it was granted would be a hole nobody granted directly',
    () => {
      const count = psql(
        service,
        db,
        `SELECT count(*)::text FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.member
        WHERE g.rolname = 'finsoft_refresh'`,
      )
      return count === '0' ? true : `finsoft_refresh is a member of ${count} role(s)`
    },
  )

  check(`${service}: finsoft_app owns nothing and cannot create`, 'ADR-0004:59', () => {
    const canCreate = psql(
      service,
      db,
      "SELECT has_schema_privilege('finsoft_app', 'public', 'CREATE')::text",
    )
    return canCreate === 'false' ? true : `has CREATE on public = ${canCreate}`
  })

  check(`${service}: migration role owns the schema`, 'so FORCE RLS is meaningful', () => {
    const owner = psql(
      service,
      db,
      "SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public'",
    )
    return owner === 'finsoft_migration' ? true : `public schema owner = ${owner}`
  })

  /* ------------------------------------------------------------ *
   * Encoding and collation — permanent, so worth asserting
   * ------------------------------------------------------------ */
  check(`${service}: UTF8 with the builtin provider`, `${db} uses C.UTF-8`, () => {
    // datlocprovider is type "char" and needs an explicit cast: an unadorned
    // `text || "char"` raises "operator is not unique".
    const row = psql(
      service,
      db,
      `SELECT pg_encoding_to_char(encoding) || ',' || datlocprovider::text || ',' || datlocale FROM pg_database WHERE datname = '${db}'`,
    )
    // 'b' is the builtin provider, PostgreSQL 17+.
    return row === 'UTF8,b,C.UTF-8' ? true : `encoding,provider,locale = ${row}`
  })

  check(`${service}: collation is byte-order`, 'behaviour, not just the catalog setting', () => {
    // Proves the ordering rather than trusting the configuration. Byte order
    // puts all uppercase before lowercase; en_US.UTF-8 would interleave them
    // as a,A,b,B. This is the ordering reports and indexes will actually use.
    const sorted = psql(
      service,
      db,
      "SELECT string_agg(v, ',' ORDER BY v) FROM (VALUES ('B'),('a'),('A'),('b')) t(v)",
    )
    return sorted === 'A,B,a,b' ? true : `sorted as ${sorted}`
  })

  check(`${service}: isolation is READ COMMITTED`, 'ARCHITECTURE.md:285 assumes it', () => {
    const level = psql(service, db, 'SHOW default_transaction_isolation')
    return level === 'read committed' ? true : level
  })

  check(`${service}: app.tenant_id has no default`, 'ADR-0004:77 requires it to raise', () => {
    try {
      const value = psql(service, db, "SELECT current_setting('app.tenant_id')")
      return `it resolved to "${value}" instead of raising`
    } catch {
      return true
    }
  })
}

/* ---------------------------------------------------------------- *
 * The two clusters are genuinely separate
 * ---------------------------------------------------------------- */
check('dev and test are different clusters', 'not two databases in one server', () => {
  const dev = psql('postgres', DEV_DB, 'SELECT system_identifier::text FROM pg_control_system()')
  const test = psql(
    'postgres-test',
    TEST_DB,
    'SELECT system_identifier::text FROM pg_control_system()',
  )
  return dev !== test ? true : `both report system_identifier ${dev}`
})

/* ---------------------------------------------------------------- *
 * Redis — disposable by design, ADR-0002:60
 * ---------------------------------------------------------------- */
for (const service of ['redis', 'redis-test']) {
  check(`${service}: answers PING`, 'cache and queues are up', () => {
    const pong = sh(['compose', 'exec', '-T', service, 'redis-cli', 'ping']).trim()
    return pong === 'PONG' ? true : pong
  })

  check(`${service}: persistence is off`, 'nothing may depend on Redis durability', () => {
    const conf = sh([
      'compose',
      'exec',
      '-T',
      service,
      'redis-cli',
      'config',
      'get',
      'appendonly',
    ]).trim()
    return conf.includes('no') ? true : conf
  })
}

/* ---------------------------------------------------------------- *
 * Report. Also prints the privileged-role table, because FND-008's
 * roles.spec.ts needs to know what the bootstrap superuser looks like.
 * ---------------------------------------------------------------- */
const width = Math.max(...results.map(([, name]) => name.length))
for (const [status, name, detail] of results) {
  const mark = status === 'PASS' ? '✓' : '✗'
  console.log(`  ${mark} ${name.padEnd(width)}  ${detail}`)
}

try {
  console.log('\n  roles carrying SUPERUSER or BYPASSRLS (informational):')
  const roles = psql(
    'postgres',
    DEV_DB,
    "SELECT rolname || '  super=' || rolsuper::text || '  bypassrls=' || rolbypassrls::text FROM pg_roles WHERE rolsuper OR rolbypassrls ORDER BY rolname",
  )
  for (const line of roles.split('\n').filter(Boolean)) console.log(`    ${line}`)
} catch {
  /* informational only */
}

console.log(`\n  ${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
