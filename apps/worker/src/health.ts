/*
 * Worker health.
 *
 * A worker has no HTTP surface of its own, but an orchestrator still needs to
 * know whether to restart it — so it gets the smallest possible server, on its
 * own port, serving two questions that are NOT the same question:
 *
 *   /health/live    is this process running?      Never touches a dependency.
 *   /health/ready   should it be given work?      Checks Redis.
 *
 * Collapsing them is the same operational hazard `apps/api` avoids: if
 * liveness touched Redis, a brief Redis blip would make the orchestrator kill
 * and restart healthy workers, turning a short outage into a restart storm at
 * the moment the dependency is least able to cope.
 *
 * During shutdown, readiness goes false immediately while liveness stays true.
 * That is the point of the split — the worker is asked to stop being given
 * work while it finishes what it holds, rather than being killed holding it.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'

import { OutageTracker } from './outage.ts'

export type ReadinessProbe = () => Promise<boolean>

export interface HealthServerOptions {
  readonly port: number
  readonly isReady: ReadinessProbe
  /** Flips to true on SIGTERM, so readiness fails before the process stops. */
  readonly isShuttingDown: () => boolean
}

export function startHealthServer(options: HealthServerOptions): Server {
  const outage = new OutageTracker('worker not ready', 'worker ready again')
  const startedAt = Date.now()

  const server = createServer((request, response) => {
    const url = request.url ?? '/'

    if (url === '/health/live') {
      json(response, 200, {
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      })
      return
    }

    if (url === '/health/ready') {
      if (options.isShuttingDown()) {
        json(response, 503, { status: 'shutting_down' })
        return
      }

      void options
        .isReady()
        .then((ready) => {
          if (ready) {
            outage.recordSuccess()
            json(response, 200, { status: 'ready' })
          } else {
            outage.recordFailure({ detail: 'redis probe returned not ready' })
            json(response, 503, { status: 'degraded' })
          }
        })
        .catch((error: unknown) => {
          /*
           * The public body stays generic. This port is not meant to be
           * reachable from outside the cluster, but a probe response is the
           * wrong place to publish which dependency is down and why — the
           * diagnosis goes to the log, keyed to the same moment (rule 20).
           */
          outage.recordFailure({ err: error })
          json(response, 503, { status: 'degraded' })
        })
      return
    }

    json(response, 404, { status: 'not_found' })
  })

  server.listen(options.port, '0.0.0.0')
  return server
}

function json(response: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}
