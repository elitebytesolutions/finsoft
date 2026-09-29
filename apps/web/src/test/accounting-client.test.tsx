import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getJournal,
  getLedger,
  getTrialBalance,
  listJournals,
  postJournal,
  reverseJournal,
} from '@/lib/api/accounting-client'
import { setAccessToken } from '@/lib/api/session'
import { ApiError } from '@/lib/api/types'

/*
 * Exercises the M2 accounting client against a mocked `fetch`, per
 * docs/design/M2/api-contract.md (M2-B). Covers only the routes the contract marks Built —
 * journals (list/get/post/reverse), the ledger, and the trial balance — matching
 * accounting-client.ts's own scope. Query construction, the Idempotency-Key header, and the
 * PostingErrorCode -> ApiError.serverCode/serverDetails mapping are what's under test; the
 * shared 401/403/network handling is already covered by api-client.test.tsx.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('lib/api/accounting-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAccessToken('tok-1')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('listJournals', () => {
    it('builds the query string only from the params that were passed', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], nextCursor: null }))

      await listJournals({ status: 'POSTED', from: '2026-09-01' })

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('/api/journals?status=POSTED&from=2026-09-01')
    })

    it('calls the bare route with no params', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], nextCursor: null }))
      await listJournals()
      expect(fetchMock.mock.calls[0][0]).toBe('/api/journals')
    })
  })

  describe('getJournal', () => {
    it('encodes the id into the path', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'abc/def', lines: [] }))
      await getJournal('abc/def')
      expect(fetchMock.mock.calls[0][0]).toBe('/api/journals/abc%2Fdef')
    })

    it('surfaces a 404 entry_not_found as an ApiError with the server code attached', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(404, { statusCode: 404, error: 'entry_not_found', message: 'Not found' }),
      )
      const err = await getJournal('missing').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).serverCode).toBe('entry_not_found')
      expect((err as ApiError).status).toBe(404)
    })
  })

  describe('postJournal', () => {
    it('sends the Idempotency-Key header and the request body', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          outcome: 'POSTED',
          id: 'j1',
          entryNumber: 'JV-2027-000001',
          lines: [],
        }),
      )

      const body = {
        occurredAt: '2026-09-27',
        narration: 'Rent',
        lines: [
          { accountId: 'a1', debit: '1000.0000' },
          { accountId: 'a2', credit: '1000.0000' },
        ],
      }
      const result = await postJournal(body, 'key-123')

      expect(result.outcome).toBe('POSTED')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/journals')
      expect(init.method).toBe('POST')
      const headers = init.headers as Headers
      expect(headers.get('Idempotency-Key')).toBe('key-123')
      expect(JSON.parse(init.body as string)).toEqual(body)
    })

    it('maps a jv_unbalanced rejection to serverCode and serverDetails', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, {
          statusCode: 400,
          error: 'jv_unbalanced',
          message: 'Debits and credits differ.',
          details: { totalDebit: '55000.0000', totalCredit: '54000.0000' },
        }),
      )

      const err = await postJournal(
        { occurredAt: '2026-09-27', narration: 'x', lines: [] },
        'key-1',
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).serverCode).toBe('jv_unbalanced')
      expect((err as ApiError).serverDetails).toEqual({
        totalDebit: '55000.0000',
        totalCredit: '54000.0000',
      })
    })

    it('maps a 409 period_closed rejection', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, {
          statusCode: 409,
          error: 'period_closed',
          message: 'Period is closed.',
        }),
      )
      const err = await postJournal(
        { occurredAt: '2026-08-15', narration: 'x', lines: [] },
        'key-2',
      ).catch((e: unknown) => e)
      expect((err as ApiError).serverCode).toBe('period_closed')
      expect((err as ApiError).status).toBe(409)
    })
  })

  describe('reverseJournal', () => {
    it('sends the reason and Idempotency-Key, and returns disclosure when present', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          outcome: undefined,
          id: 'r1',
          entryNumber: 'RV-2027-000001',
          lines: [],
          disclosure: { originalPeriod: '2026-08', originalPeriodStatus: 'CLOSED' },
        }),
      )

      const result = await reverseJournal('j1', { reason: 'Wrong account' }, 'key-3')

      expect(result.disclosure).toEqual({
        originalPeriod: '2026-08',
        originalPeriodStatus: 'CLOSED',
      })
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/journals/j1/reverse')
      expect(JSON.parse(init.body as string)).toEqual({ reason: 'Wrong account' })
      expect((init.headers as Headers).get('Idempotency-Key')).toBe('key-3')
    })

    it('maps already_reversed', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, {
          statusCode: 409,
          error: 'already_reversed',
          message: 'Already reversed.',
        }),
      )
      const err = await reverseJournal('j1', { reason: 'x' }, 'key-4').catch((e: unknown) => e)
      expect((err as ApiError).serverCode).toBe('already_reversed')
    })
  })

  describe('getLedger', () => {
    it('requires from/to and includes them in the query', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          accountId: 'a1',
          code: '1120',
          name: 'Bank',
          type: 'ASSET',
          openingBalance: '0.0000',
          closingBalance: '0.0000',
          lines: [],
          nextCursor: null,
        }),
      )

      await getLedger('a1', { from: '2026-08-01', to: '2026-08-31' })

      expect(fetchMock.mock.calls[0][0]).toBe('/api/ledgers/a1?from=2026-08-01&to=2026-08-31')
    })

    it('maps 404 account_not_found', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(404, { statusCode: 404, error: 'account_not_found', message: 'Not found' }),
      )
      const err = await getLedger('missing', { from: '2026-08-01', to: '2026-08-31' }).catch(
        (e: unknown) => e,
      )
      expect((err as ApiError).serverCode).toBe('account_not_found')
    })
  })

  describe('getTrialBalance', () => {
    it('requests the given as-of date and returns the totals verbatim', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          asOf: '2026-09-27',
          lines: [],
          totalDebit: '500000.0000',
          totalCredit: '500000.0000',
        }),
      )

      const result = await getTrialBalance('2026-09-27')

      expect(fetchMock.mock.calls[0][0]).toBe('/api/reports/trial-balance?asOf=2026-09-27')
      expect(result.totalDebit).toBe('500000.0000')
      expect(result.totalCredit).toBe('500000.0000')
    })
  })
})
