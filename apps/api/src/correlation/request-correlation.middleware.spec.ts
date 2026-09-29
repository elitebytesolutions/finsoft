import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { getCorrelation } from '@finsoft/observability'
import {
  REQUEST_ID_RESPONSE_HEADER,
  requestCorrelationMiddleware,
} from './request-correlation.middleware.ts'

/*
 * M1-C. Unit-level: the middleware's own logic (id resolution, header echo,
 * establishing the correlation context for the continuation) — without a
 * full NestJS boot. tests/integration/request-correlation.spec.ts covers the
 * same behaviour over real HTTP, through the whole pipeline.
 */

function fakeRequest(
  headers: Record<string, string | string[]>,
  remoteAddress = '203.0.113.9',
): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request
}

function fakeResponse(): Response & { setHeader: ReturnType<typeof vi.fn> } {
  return {
    setHeader: vi.fn(),
  } as unknown as Response & { setHeader: ReturnType<typeof vi.fn> }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('requestCorrelationMiddleware', () => {
  it('adopts a well-formed inbound X-Request-Id, echoes it, and puts it in req and the correlation context', () => {
    const inbound = '9f8e7d6c-5b4a-4321-9876-543210fedcba'
    const req = fakeRequest({ 'x-request-id': inbound })
    const res = fakeResponse()

    let seen: string | undefined
    const next = vi.fn(() => {
      seen = getCorrelation()?.requestId
    })

    requestCorrelationMiddleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.requestId).toBe(inbound)
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_RESPONSE_HEADER, inbound)
    expect(seen).toBe(inbound)
  })

  it('mints and echoes a fresh id when the header is absent', () => {
    const req = fakeRequest({})
    const res = fakeResponse()
    const next = vi.fn()

    requestCorrelationMiddleware(req, res, next)

    expect(req.requestId).toMatch(UUID_RE)
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_RESPONSE_HEADER, req.requestId)
  })

  it('mints a fresh id rather than trusting a malformed header', () => {
    const req = fakeRequest({ 'x-request-id': 'not-a-uuid' })
    const res = fakeResponse()
    const next = vi.fn()

    requestCorrelationMiddleware(req, res, next)

    expect(req.requestId).toMatch(UUID_RE)
    expect(req.requestId).not.toBe('not-a-uuid')
  })

  it('carries the client ip (via the shared clientIp extraction) into the correlation context', () => {
    const req = fakeRequest({ 'x-forwarded-for': '198.51.100.23' }, '10.0.0.5')
    const res = fakeResponse()

    let seenIp: string | undefined
    const next = vi.fn(() => {
      seenIp = getCorrelation()?.ip
    })

    requestCorrelationMiddleware(req, res, next)

    expect(seenIp).toBe('198.51.100.23')
  })

  it('the correlation context does not leak outside the request (no store after next returns synchronously)', () => {
    const req = fakeRequest({})
    const res = fakeResponse()
    const next = vi.fn()

    requestCorrelationMiddleware(req, res, next)

    expect(getCorrelation()).toBeUndefined()
  })
})
