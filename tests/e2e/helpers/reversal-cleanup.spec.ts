import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import type { ApiSession } from './api-client.ts'
import {
  MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED,
  reverseLeftovers,
  reverseMatchingPosted,
  type ListedDoc,
  type PostedDocs,
} from './reversal-cleanup.ts'

/*
 * Unit tests for tests/e2e/helpers/reversal-cleanup.ts — no browser, no server, no `.env`. Added
 * after the THIRD security review round of mvp-journey.deployed.spec.ts: the risk this file
 * guards against (an automatic sweep reversing another customer's real, posted invoice or
 * receipt on a shared demo tenant, with no human in the loop) is serious enough, and the
 * defence-in-depth code path uncommon enough to hit by chance in an ordinary e2e run, that it
 * needs a test which can force the exact bad input — a list response with another customer's
 * `POSTED` document in it — on demand, every run, not just whenever a real server happens to
 * misbehave that way.
 *
 * Pure logic, so plain `test`/`expect` from Playwright's own runner is enough; no `page`, no
 * `request` fixture, nothing that needs the webServer this config would otherwise start. The
 * fake below implements only the one method `apiCall` (api-client.ts) actually calls on an
 * `APIRequestContext` — `fetch()` — and records every call made through it so each test can
 * assert not just what WAS reversed, but, just as importantly, what was NOT.
 */

interface FakeCall {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

interface FakeResponse {
  readonly status: number
  readonly body: unknown
}

function fakeRequestContext(handler: (call: FakeCall) => FakeResponse): {
  request: APIRequestContext
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const fake = {
    async fetch(
      url: string,
      opts: { method: string; headers: Record<string, string>; data?: string },
    ) {
      const call: FakeCall = {
        method: opts.method,
        url,
        body: opts.data === undefined ? undefined : JSON.parse(opts.data),
      }
      calls.push(call)
      const { status, body } = handler(call)
      const text = JSON.stringify(body)
      return {
        status: () => status,
        ok: () => status >= 200 && status < 300,
        text: async () => text,
      }
    },
  }
  // A structural fake, not a real APIRequestContext (this project's own ESLint config would
  // reject constructing one outside Playwright's own fixtures) — cast, not implemented in full,
  // because `apiCall` only ever calls `.fetch()` on what it is given.
  return { request: fake as unknown as APIRequestContext, calls }
}

const SESSION: ApiSession = {
  baseUrl: 'http://fake.invalid',
  tenantCode: 'TEST',
  accessToken: 'tok',
}

function reverseCallsTo(calls: readonly FakeCall[]): FakeCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url.includes('/reverse'))
}

test.describe('reverseMatchingPosted', () => {
  test("never reverses another customer's POSTED document, and reports it", async () => {
    const items: ListedDoc[] = [
      {
        id: 'inv-mine',
        number: 'INV-2027-000001',
        status: 'POSTED',
        customer: { id: 'cust-mine' },
      },
      {
        id: 'inv-other',
        number: 'INV-2027-000002',
        status: 'POSTED',
        customer: { id: 'cust-other' },
      },
    ]
    const { request, calls } = fakeRequestContext(() => ({ status: 200, body: {} }))
    const problems: string[] = []

    await reverseMatchingPosted(
      request,
      SESSION,
      'invoice',
      'cust-mine',
      ' (customer Test)',
      items,
      problems,
    )

    const reversed = reverseCallsTo(calls)
    expect(reversed).toHaveLength(1)
    expect(reversed[0]!.url).toContain('/api/invoices/inv-mine/reverse')
    // The one property this whole function exists to enforce: the other customer's document is
    // never the target of a reverse call, under any circumstance.
    expect(calls.some((c) => c.url.includes('inv-other') && c.method === 'POST')).toBe(false)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('INV-2027-000002') // the mismatched item's own number, not id
    expect(problems[0]).toContain('cust-other')
    expect(problems[0]).toContain('NOT reversed')
  })

  test('leaves a DRAFT, a REVERSED and a CANCELLED document alone — no reverse call, no problem', async () => {
    const items: ListedDoc[] = [
      { id: 'd1', number: null, status: 'DRAFT', customer: { id: 'cust-mine' } },
      { id: 'd2', number: 'INV-2', status: 'REVERSED', customer: { id: 'cust-mine' } },
      { id: 'd3', number: null, status: 'CANCELLED', customer: { id: 'cust-mine' } },
    ]
    const { request, calls } = fakeRequestContext(() => ({ status: 200, body: {} }))
    const problems: string[] = []

    await reverseMatchingPosted(request, SESSION, 'invoice', 'cust-mine', '', items, problems)

    expect(reverseCallsTo(calls)).toHaveLength(0)
    expect(problems).toHaveLength(0)
  })

  test('reports, rather than throws, a reversal the server itself rejects', async () => {
    const items: ListedDoc[] = [
      { id: 'inv-1', number: 'INV-1', status: 'POSTED', customer: { id: 'cust-mine' } },
    ]
    const { request } = fakeRequestContext(() => ({
      status: 409,
      body: { error: 'INVOICE_HAS_LIVE_ALLOCATIONS' },
    }))
    const problems: string[] = []

    await reverseMatchingPosted(request, SESSION, 'invoice', 'cust-mine', '', items, problems)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('409')
    expect(problems[0]).toContain('INVOICE_HAS_LIVE_ALLOCATIONS')
  })
})

test.describe('reverseLeftovers', () => {
  test('does nothing when neither flag was ever set — no list call, no reverse call', async () => {
    const { request, calls } = fakeRequestContext(() => ({ status: 200, body: { items: [] } }))
    const posted: PostedDocs = { session: SESSION, customerId: 'cust-mine' }

    await expect(reverseLeftovers(request, posted)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('refuses to reverse ANYTHING, and throws, when the combined list exceeds what this run could have created', async () => {
    const { request, calls } = fakeRequestContext((call) => {
      if (call.method === 'GET' && call.url.includes('/api/invoices')) {
        return {
          status: 200,
          body: {
            items: [
              { id: 'inv-mine', number: 'INV-1', status: 'POSTED', customer: { id: 'cust-mine' } },
              // The extra item is what pushes the combined total over the cap — it does not even
              // need to be a mismatched customer to trip this: the LIST ITSELF being longer than
              // physically possible is the signal the filter cannot be trusted.
              { id: 'inv-extra', number: 'INV-2', status: 'POSTED', customer: { id: 'cust-mine' } },
            ],
          },
        }
      }
      if (call.method === 'GET' && call.url.includes('/api/receipts')) {
        return {
          status: 200,
          body: {
            items: [
              { id: 'rct-mine', number: 'RCT-1', status: 'POSTED', customer: { id: 'cust-mine' } },
            ],
          },
        }
      }
      return { status: 200, body: {} }
    })
    const posted: PostedDocs = {
      session: SESSION,
      customerId: 'cust-mine',
      customerName: 'Test Customer',
      invoicePossiblyPosted: true,
      receiptPossiblyPosted: true,
    }

    await expect(reverseLeftovers(request, posted)).rejects.toThrow(/Refusing to reverse anything/)

    // The cap is checked BEFORE any reversal is attempted — not one reverse call happened,
    // including for the one genuinely-this-run's-own invoice in that over-long list.
    expect(reverseCallsTo(calls)).toHaveLength(0)
  })

  test('refuses and throws even when every extra item belongs to a different customer', async () => {
    const { request, calls } = fakeRequestContext((call) => {
      if (call.method === 'GET' && call.url.includes('/api/invoices')) {
        return {
          status: 200,
          body: {
            items: [
              { id: 'inv-mine', number: 'INV-1', status: 'POSTED', customer: { id: 'cust-mine' } },
              {
                id: 'inv-other',
                number: 'INV-2',
                status: 'POSTED',
                customer: { id: 'cust-other' },
              },
              {
                id: 'inv-other-2',
                number: 'INV-3',
                status: 'POSTED',
                customer: { id: 'cust-other-2' },
              },
            ],
          },
        }
      }
      return { status: 200, body: { items: [] } }
    })
    const posted: PostedDocs = {
      session: SESSION,
      customerId: 'cust-mine',
      invoicePossiblyPosted: true,
    }

    await expect(reverseLeftovers(request, posted)).rejects.toThrow(
      new RegExp(`more than the ${MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED}`),
    )
    expect(reverseCallsTo(calls)).toHaveLength(0)
  })

  test('within bounds: reverses exactly the matching documents, receipt before invoice (PO-Q1)', async () => {
    const { request, calls } = fakeRequestContext((call) => {
      if (call.method === 'GET' && call.url.includes('/api/invoices')) {
        return {
          status: 200,
          body: {
            items: [
              { id: 'inv-mine', number: 'INV-1', status: 'POSTED', customer: { id: 'cust-mine' } },
            ],
          },
        }
      }
      if (call.method === 'GET' && call.url.includes('/api/receipts')) {
        return {
          status: 200,
          body: {
            items: [
              { id: 'rct-mine', number: 'RCT-1', status: 'POSTED', customer: { id: 'cust-mine' } },
            ],
          },
        }
      }
      return { status: 200, body: {} } // the two reverse POSTs
    })
    const posted: PostedDocs = {
      session: SESSION,
      customerId: 'cust-mine',
      customerName: 'Test Customer',
      invoicePossiblyPosted: true,
      receiptPossiblyPosted: true,
    }

    await expect(reverseLeftovers(request, posted)).resolves.toBeUndefined()

    const reversed = reverseCallsTo(calls)
    expect(reversed).toHaveLength(2)
    const receiptIndex = calls.findIndex((c) => c.url.includes('/api/receipts/rct-mine/reverse'))
    const invoiceIndex = calls.findIndex((c) => c.url.includes('/api/invoices/inv-mine/reverse'))
    expect(receiptIndex).toBeGreaterThanOrEqual(0)
    expect(invoiceIndex).toBeGreaterThan(receiptIndex) // PO-Q1: the receipt is reversed first
  })

  test('nothing to do: no error, no reverse call, when everything listed is already REVERSED', async () => {
    const { request, calls } = fakeRequestContext((call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            items: [
              { id: 'x', number: 'INV-1', status: 'REVERSED', customer: { id: 'cust-mine' } },
            ],
          },
        }
      }
      return { status: 200, body: {} }
    })
    const posted: PostedDocs = {
      session: SESSION,
      customerId: 'cust-mine',
      invoicePossiblyPosted: true,
    }

    await expect(reverseLeftovers(request, posted)).resolves.toBeUndefined()
    expect(reverseCallsTo(calls)).toHaveLength(0)
  })
})
