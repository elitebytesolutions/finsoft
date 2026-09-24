import { expect, test } from '@playwright/test'

/*
 * A real browser against the real API.
 *
 * Not `request.get(...)`, which is Playwright's own HTTP client and proves
 * nothing a curl in the smoke test does not already prove. These go through a
 * Chromium page, so what is asserted is what a browser actually receives:
 * the response a fetch sees, the headers the browser applies, and the CORS
 * behaviour that only exists once an Origin is involved.
 *
 * The API is started from `dist` by the Playwright config — the same artefact
 * shape the container runs.
 */

test.describe('the browser can reach the API', () => {
  test('navigating to the liveness route renders the response', async ({ page }) => {
    const response = await page.goto('/api/health')

    expect(response?.status()).toBe(200)

    // What the browser actually rendered, not what the client library parsed.
    const body = await page.locator('body').innerText()
    expect(JSON.parse(body)).toMatchObject({ status: 'ok' })
  })

  test('a fetch from page context reaches the database and gets a result', async ({ page }) => {
    await page.goto('/api/health')

    /*
     * Issued BY the page, same-origin, exactly as the application will issue
     * it. Readiness is the interesting one: liveness touches nothing, while
     * this reaches PostgreSQL, so a green result here is a browser observing
     * the whole stack.
     */
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/health/ready')
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ status: 'ready' })

    const checks = result.body.checks as { database: { status: string; detail: string } }
    expect(checks.database.status).toBe('up')
    expect(checks.database.detail).toMatch(/schema \d+, requires \d+/)
  })
})

test.describe('what the browser is not given', () => {
  test('an unknown route returns a structured 404, not a stack trace', async ({ page }) => {
    // Navigate first: a relative fetch from about:blank has no base URL to
    // resolve against, and fails before it reaches the API at all.
    await page.goto('/api/health')

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/does-not-exist')
      return { status: res.status, text: await res.text() }
    })

    expect(result.status).toBe(404)
    expect(result.text).not.toMatch(/at \w+ \(/) // no stack frames
    expect(result.text).not.toMatch(/node_modules/)
  })

  test('the readiness body carries nothing internal', async ({ page }) => {
    await page.goto('/api/health')

    const text = await page.evaluate(async () => {
      const res = await fetch('/api/health/ready')
      return res.text()
    })

    /*
     * Rule 20, asserted where it actually matters: this endpoint is
     * unauthenticated, so whatever it returns is public. A connection error
     * from `pg` carries host, port, database and role, and the service
     * deliberately reduces that to a generic word.
     */
    for (const leak of ['postgres://', '5432', 'finsoft_app', 'finsoft_migration', 'password']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase())
    }
  })
})
