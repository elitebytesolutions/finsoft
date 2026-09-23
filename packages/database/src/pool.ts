import { Pool, types, type PoolConfig } from 'pg'
import { redactValueShapes } from '@finsoft/observability'
import { describeTarget, intEnv, optionalEnv, requireEnv } from './env.ts'

/*
 * The one Pool in the process. ADR-0013.
 *
 * ADR-0004:118 calls connection-pool discipline "the one way RLS can be
 * defeated by configuration", so every setting below is deliberate and
 * carries its reason. Nothing else in the repository may construct a Pool or
 * a Client — the dependency-cruiser rule `pg-driver-is-database-package-only`
 * enforces that on the module graph.
 *
 * Two properties of this file are load-bearing:
 *
 *   1. It is a singleton. One pool per process means `set_config(...,
 *      true)`'s transaction scoping is the only thing that has to be right;
 *      a second, differently configured pool would be a second set of rules.
 *   2. It refuses to start if the driver has been rewired to parse numeric
 *      or int8 into a JS number (ADR-0011). See assertExactNumericParsing.
 */

/* ------------------------------------------------------------------ *
 * The numbers
 *
 * docs/ specifies none of these, so they are chosen here and justified
 * here. Each is overridable by environment for a worker or a load test;
 * the defaults are what the API runs with.
 * ------------------------------------------------------------------ */

/**
 * Connections per process.
 *
 * PostgreSQL's stock `max_connections` is 100 and each backend costs real
 * memory, so the budget is spent, not assumed. At 10 per process: two API
 * replicas and a worker is 30, leaving room for the migration job, support
 * sessions, an engineer's psql and monitoring without ever approaching the
 * cap.
 *
 * Ten is also comfortably above the classic `2 x cores` sizing heuristic for
 * the hardware this runs on. A modular monolith does one transaction per
 * request (ARCHITECTURE §7), so requests that cannot get a connection should
 * queue in the pool — where the wait is visible and bounded by
 * connectionTimeoutMillis — rather than in PostgreSQL, where more backends
 * make every backend slower.
 */
const DEFAULT_MAX = 10

/**
 * Longest a single statement may run: 15s.
 *
 * The slowest budget in ARCHITECTURE §11 is the trial balance at P95 < 3s.
 * Five times the slowest documented surface is not "a bit slow" — it is a
 * statement that is not going to finish, and killing it returns a connection
 * to the pool instead of holding it plus whatever locks it took.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000

/**
 * Longest a transaction may sit idle between statements: 10s. Mandatory,
 * because in this system every unit of work is a transaction (ADR-0013).
 *
 * An idle-in-transaction session holds its locks, holds back vacuum, and —
 * the reason it is here rather than in a performance section — keeps a
 * connection checked out with `app.tenant_id` still set on it. The posting
 * budget is P95 < 800ms; ten seconds of doing nothing mid-transaction means
 * the caller has crashed, not that it is slow.
 */
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000

/**
 * Longest to wait for a free connection before failing: 5s.
 *
 * Failing fast beats an unbounded queue. A request that has already waited
 * five seconds for a connection has blown every budget in ARCHITECTURE §11
 * before touching the database.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000

/** An idle connection is closed after 10s. pg's default, restated on purpose. */
const DEFAULT_IDLE_TIMEOUT_MS = 10_000

/**
 * Hard ceiling on a connection's lifetime: 30 minutes.
 *
 * Nothing should be able to accumulate on a connection across half an hour of
 * reuse. Recycling bounds the blast radius of any session state that escapes
 * transaction scope, and it lets a rolling restart or a failover drain
 * without waiting for idle.
 */
const DEFAULT_MAX_LIFETIME_SECONDS = 1_800

/* ------------------------------------------------------------------ *
 * Driver type parsing — ADR-0011 / ADR-0013
 * ------------------------------------------------------------------ */

const NUMERIC_OID = 1700
const INT8_OID = 20

/**
 * A value that a JS number cannot hold. 9007199254740993 is 2^53 + 1: round
 * tripping it through `number` yields 9007199254740992, silently, with no
 * error anywhere. That is the failure this assertion exists to catch.
 */
const PROBE = '9007199254740993'

/**
 * Assert that `numeric` and `int8` still arrive from the driver as strings.
 *
 * ADR-0013:68 asks for one positive check rather than four negative greps:
 * `setTypeParser`, `pg.defaults`, the `types` option on Pool/Client and a
 * `pg-types` dependency are each a way to rewire this, and a lint rule per
 * hole will eventually miss one. Asking the driver what it will actually do
 * catches all of them, including one introduced by a transitive dependency
 * at import time.
 *
 * Called at pool construction. The process refuses to start if it fails —
 * there is no degraded mode in which money is allowed through a float.
 */
export function assertExactNumericParsing(): void {
  const checks: Array<{ oid: number; label: string }> = [
    { oid: NUMERIC_OID, label: 'numeric (OID 1700)' },
    { oid: INT8_OID, label: 'int8 (OID 20)' },
  ]

  for (const { oid, label } of checks) {
    const parsed: unknown = types.getTypeParser(oid)(PROBE)
    if (typeof parsed !== 'string' || parsed !== PROBE) {
      throw new Error(
        `ADR-0011 violated before a single query ran: ${label} parses "${PROBE}" into ` +
          `${typeof parsed} ${String(parsed)}, not the identical string. ` +
          'Something has called setTypeParser, set pg.defaults, or passed a `types` option. ' +
          'Money and 64-bit identifiers must reach TypeScript as strings and be parsed only ' +
          'by Money.from — a JS number cannot hold them exactly.',
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export interface PoolTarget {
  /** Which environment variable holds the connection string. */
  readonly urlVar: string
  /** Shows up in pg_stat_activity.application_name. */
  readonly applicationName: string
}

let pool: Pool | undefined

/**
 * The connection the running application uses: DATABASE_URL, as finsoft_app.
 *
 * Not MIGRATION_DATABASE_URL. finsoft_migration holds BYPASSRLS
 * (INFRASTRUCTURE §5) and the application must never hold a handle to it —
 * that role is reachable only from the migration CLI.
 */
export const APPLICATION_TARGET: PoolTarget = {
  urlVar: 'DATABASE_URL',
  applicationName: optionalEnv('FINSOFT_APPLICATION_NAME', 'finsoft-api'),
}

let target: PoolTarget = APPLICATION_TARGET

/**
 * Point the process at a different connection — the test cluster, or a
 * worker with its own `application_name`.
 *
 * Must be called before anything opens the pool, and throws if it is not.
 * Silently re-targeting a live pool would mean two halves of a process
 * talking to two databases, which is the failure this whole file is arranged
 * to make impossible.
 */
export function configurePoolTarget(next: PoolTarget): void {
  if (pool) {
    throw new Error(
      `The pool is already open against ${target.urlVar}; it cannot be re-pointed at ` +
        `${next.urlVar}. One pool per process (ADR-0013), configured before first use.`,
    )
  }
  target = next
}

function poolConfig(connectionString: string, applicationName: string): PoolConfig {
  return {
    connectionString,

    // Attribution. Without it pg_stat_activity shows a wall of identical
    // rows and nobody can tell the worker's long query from a user request.
    application_name: applicationName,

    max: intEnv('DATABASE_POOL_MAX', DEFAULT_MAX),
    min: 0,

    // These two are sent as startup parameters, so they apply to every
    // session the pool opens — there is no window in which a connection is
    // live but untimed. database/tests/roles.spec.ts asserts the server
    // actually received them rather than trusting this object.
    statement_timeout: intEnv('DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
    idle_in_transaction_session_timeout: intEnv(
      'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ),

    connectionTimeoutMillis: intEnv(
      'DATABASE_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    idleTimeoutMillis: intEnv('DATABASE_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS),
    maxLifetimeSeconds: intEnv('DATABASE_MAX_LIFETIME_SECONDS', DEFAULT_MAX_LIFETIME_SECONDS),

    // No `types` option, ever. It is the third way to defeat ADR-0011 and
    // assertExactNumericParsing above is what notices if one appears.
  }
}

/**
 * The process-wide pool, created on first use.
 *
 * If an external pooler (PgBouncer and friends) is ever put in front of this,
 * **transaction pooling mode is the only permitted mode** (ADR-0013:108). A
 * pooler that multiplexes mid-transaction breaks `set_config(..., true)`
 * scoping, and with it every guarantee in ADR-0004.
 */
export function getPool(): Pool {
  if (pool) return pool

  // Before the first connection, not after: a pool that has already handed
  // out a client with a rewired parser has already returned a wrong number.
  assertExactNumericParsing()

  const connectionString = requireEnv(
    target.urlVar,
    'The application connects as finsoft_app, which is subject to RLS (INFRASTRUCTURE §5).',
  )

  const created = new Pool(poolConfig(connectionString, target.applicationName))

  /*
   * Without a listener, an error on an idle client is an unhandled 'error'
   * event and takes the process down. pg has already removed the client from
   * the pool by this point, so the correct response is to record it and carry
   * on — not to lose every in-flight request because one idle socket died.
   */
  created.on('error', (error: Error) => {
    /*
     * `error.message` is redacted, not trusted. A pg connection failure puts
     * the DSN it tried — password included — into its MESSAGE, which is not
     * a field layer 3 can strip and has no token shape. Interpolating it raw
     * printed the password (rule 20). `describeTarget` was already safe; the
     * driver's own message was not.
     *
     * Still `console.error` and not the logger: this runs inside an 'error'
     * listener, and `getLogger()` throws before `initLogger()`. A CLI or a
     * test would turn a recoverable idle-socket error into a throw from an
     * error handler. Routing it through the logger needs a lifecycle this
     * package does not have yet — recorded as debt in ADR-0016.
     */
    console.error(
      `[database] idle client error against ${describeTarget(connectionString)}: ` +
        redactValueShapes(error.message),
    )
  })

  pool = created
  return created
}

/** Which connection string the pool is (or will be) opened against. */
export function poolTarget(): PoolTarget {
  return target
}

export function isPoolOpen(): boolean {
  return pool !== undefined
}

/**
 * Close the pool. Shutdown only.
 *
 * Kysely's own `destroy()` would also end this pool, which is why nothing
 * here calls it: two Kysely instances share one pool (see kysely.ts), and
 * `Pool.end()` throws if it is called twice. Ending the pool exactly once,
 * here, is the whole ownership story.
 */
export async function closePool(): Promise<void> {
  const open = pool
  pool = undefined
  if (open) await open.end()
}
