import { expect, test } from '@playwright/test'

/*
 * One browser, one origin, both applications — against the real deployment.
 *
 * ── What this proves, precisely ─────────────────────────────────────────
 *
 * A browser loads the Next.js application from the deployed origin, and from
 * inside that loaded page reaches the API under /api through the reverse
 * proxy. That is the FOUNDATION integration: Next.js served, proxy routing by
 * path, API answering, all on one origin, exercised by a real browser rather
 * than by curl.
 *
 * It is the arrangement ADR-0009's SameSite=Strict refresh cookie requires,
 * and it is the piece `smoke.sh` cannot show: curl proves each endpoint
 * answers, not that a document loaded from one of them can call the other.
 *
 * ── What it does NOT prove ──────────────────────────────────────────────
 *
 * That the application uses the API. It does not. `apps/web` is driven
 * entirely by `@/mocks/api` and issues no requests to /api/* of its own, by
 * current design — business screens stay mocked for now.
 *
 * So this is deliberately a FOUNDATION test, not a feature test. The fetch
 * below is issued by the test, from the page's context, precisely because the
 * page does not issue one itself. Do not cite this as evidence that the web
 * application is integrated with the API; when the first real call lands,
 * that needs its own test.
 */

test.describe('the deployed origin serves both applications', () => {
  test('a browser loads the Next.js application', async ({ page }) => {
    const response = await page.goto('/')

    expect(response?.status(), 'the web application should answer on /').toBe(200)

    // A rendered document, not merely a 200: a proxy error page is also a 200
    // in some configurations, and an empty shell would satisfy a status check.
    await expect(page).toHaveTitle(/Finsoft/i)
    expect(await page.locator('body').count()).toBeGreaterThan(0)
  })

  test('from that loaded page, the API is reachable on the same origin', async ({ page }) => {
    await page.goto('/')

    /*
     * Issued from the PAGE's context, so it carries the page's origin and
     * goes through the proxy exactly as an application request would. A
     * same-origin relative fetch is the thing being demonstrated — if the
     * proxy were not routing /api, this resolves against the web app and
     * returns Next's 404 document instead of JSON.
     */
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/health/ready')
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: await res.text(),
      }
    })

    expect(result.status, 'the API did not answer on the web origin').toBe(200)
    expect(result.contentType, 'the proxy returned the web app, not the API').toContain(
      'application/json',
    )

    const body = JSON.parse(result.body) as {
      status: string
      checks: { database: { status: string; detail: string } }
    }

    expect(body.status).toBe('ready')

    // Readiness reaches PostgreSQL, so a green result here is a browser
    // observing the whole stack: proxy, API, database.
    expect(body.checks.database.status).toBe('up')
    expect(body.checks.database.detail).toMatch(/schema \d+, requires \d+/)
  })

  test('the page never references the API by host and port', async ({ page }) => {
    await page.goto('/')
    const html = await page.content()

    /*
     * Same-origin is the whole reason the proxy exists. A hardcoded
     * :3001 anywhere in the document means a cross-origin call, which would
     * not send ADR-0009's SameSite=Strict refresh cookie — and would work
     * fine in development, where both happen to be on localhost.
     */
    expect(html).not.toMatch(/:300[01]\b/)
    expect(html.toLowerCase()).not.toContain('finsoft-api:')
  })

  test('nothing internal leaks through the proxy to the browser', async ({ page }) => {
    await page.goto('/')

    const text = await page.evaluate(async () => {
      const res = await fetch('/api/health/ready')
      return res.text()
    })

    // Rule 20, at the boundary that is actually public.
    for (const leak of ['postgres://', '5432', 'finsoft_app', 'finsoft_migration', 'password']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase())
    }
  })
})
