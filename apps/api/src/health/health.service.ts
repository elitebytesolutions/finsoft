import { Injectable } from '@nestjs/common'
import { withGlobal } from '@finsoft/database'

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

export interface CheckResult {
  readonly status: 'up' | 'down'
  readonly detail: string
}

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded'
  readonly checks: Readonly<Record<string, CheckResult>>
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
   * Counts applied migrations rather than issuing `SELECT 1`.
   *
   * `SELECT 1` proves a socket is open. This proves the connection works, the
   * application database is the one we think it is, and the schema has been
   * migrated — which is the condition that actually has to hold before this
   * process should receive traffic.
   *
   * It runs through `withGlobal` because it has no tenant and touches only a
   * global table, which is precisely what that wrapper is for (ADR-0004:77).
   */
  private async checkDatabase(): Promise<CheckResult> {
    try {
      const row = await withGlobal((tx) =>
        tx
          .selectFrom('schema_migrations')
          .select(({ fn }) => fn.countAll<string>().as('applied'))
          .executeTakeFirst(),
      )
      const applied = Number(row?.applied ?? 0)
      return applied > 0
        ? { status: 'up', detail: `${applied} migration(s) applied` }
        : { status: 'down', detail: 'reachable, but no migrations have been applied' }
    } catch (error) {
      /*
       * The message is deliberately generic. A connection error from `pg`
       * carries the host, port, database and role, and /health/ready is an
       * unauthenticated endpoint — rule 20 forbids putting that in a
       * response. The real error belongs in the logs, which FND-010 wires up.
       */
      return {
        status: 'down',
        detail: error instanceof Error ? error.name : 'unreachable',
      }
    }
  }
}
