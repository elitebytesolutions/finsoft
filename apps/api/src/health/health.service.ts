import { Injectable } from '@nestjs/common'
import { readSchemaHealth } from '@finsoft/database'

/*
 * Liveness and readiness are different questions and are answered separately.
 *
 *   liveness  — is this process running? Never touches a dependency.
 *   readiness — can it actually serve traffic? Checks the database.
 *
 * Collapsing them is a real operational hazard: if liveness touched the
 * database, a brief database blip would make the orchestrator kill and
 * restart healthy API processes, turning a short outage into a restart storm
 * at exactly the moment the database is least able to cope.
 */

/**
 * The lowest schema version this build can run against.
 *
 * A count of applied migrations is not a compatibility check — it says the
 * database has *some* schema, not the one this code expects. A build deployed
 * ahead of its migrations would report ready and then fail on the first query
 * against a column that does not exist yet.
 *
 * Bump this when a migration lands that the API requires. `health.spec.ts`
 * asserts it matches the highest migration on disk, so it cannot drift
 * silently — while the running container still needs no access to the
 * migration files.
 */
export const REQUIRED_SCHEMA_VERSION = 3

/**
 * A readiness probe must answer quickly or it is useless: an orchestrator
 * that waits 15s for an answer has already made its own decision. This is far
 * below the pool's statement_timeout, which is sized for real queries.
 */
const PROBE_TIMEOUT_MS = 2_000

export interface CheckResult {
  readonly status: 'up' | 'down'
  readonly detail: string
}

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded'
  readonly checks: Readonly<Record<string, CheckResult>>
}

class ProbeTimeout extends Error {
  constructor() {
    super('probe timed out')
    this.name = 'ProbeTimeout'
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now()

  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) }
  }

  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase()
    const checks = { database }
    const status = Object.values(checks).every((c) => c.status === 'up') ? 'ready' : 'degraded'
    return { status, checks }
  }

  /**
   * Verifies three things, in one round trip:
   *
   *   1. the connection works and the application database is reachable;
   *   2. the schema is at or beyond the version this build requires;
   *   3. a real table is readable — not merely that the catalog has rows.
   *
   * It runs through `withGlobal` because it has no tenant and touches only
   * global tables, which is exactly what that wrapper exists for
   * (ADR-0004:77).
   */
  private async checkDatabase(): Promise<CheckResult> {
    try {
      /*
       * The query lives in packages/database. ADR-0013 confines query
       * construction and apps/** is not on the list — receiving a transaction
       * handle through a callback does not make a controller the data layer.
       * This service decides what a failure MEANS for readiness and what may
       * be said about it; it does not build the query.
       */
      const { appliedVersion, readable } = await withTimeout(readSchemaHealth(), PROBE_TIMEOUT_MS)

      if (!readable) return { status: 'down', detail: 'schema not readable' }

      if (appliedVersion < REQUIRED_SCHEMA_VERSION) {
        return {
          status: 'down',
          detail: `schema at ${appliedVersion}, this build requires ${REQUIRED_SCHEMA_VERSION}`,
        }
      }

      return {
        status: 'up',
        detail: `schema ${appliedVersion}, requires ${REQUIRED_SCHEMA_VERSION}`,
      }
    } catch (error) {
      /*
       * The detail is deliberately generic. A connection error from `pg`
       * carries the host, port, database and role, and /health/ready is
       * unauthenticated — rule 20 forbids putting that in a response. The
       * real error belongs in the logs, which FND-010 wires up.
       */
      return {
        status: 'down',
        detail: error instanceof ProbeTimeout ? 'timed out' : 'unreachable',
      }
    }
  }
}
