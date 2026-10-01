import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  createAccountingE2eTenant,
  type AccountingE2eFixture,
} from './helpers/accounting-fixture.ts'

/*
 * The M4-W2 invoice/receipt journey, against the real API and a real (disposable) tenant:
 * an Accountant (who holds invoice.create, invoice.post, payment.receive and voucher.reverse —
 * packages/permissions/src/system-roles.ts) creates a customer, raises and posts a 10,000
 * service invoice, receives and posts a 6,000 receipt allocated against it, sees the customer
 * ledger settle to 4,000 outstanding, is refused reversing the invoice while the receipt is
 * still live (INVOICE_HAS_LIVE_ALLOCATIONS — the Reverse button itself is withheld, same as a
 * real caller would see, not a raw 409), reverses the receipt, then reverses the invoice, and
 * the ledger is back to 0.
 *
 * Reuses tests/e2e/helpers/accounting-fixture.ts, same as m4-customers.spec.ts and
 * m2-accounting.spec.ts — this lane's own contract forbids a second copy of the same setup.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Same override m2-accounting.spec.ts and m4-customers.spec.ts use, for the same reason: this
// file's name does not match playwright.config.ts's `web` project glob.
test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 3021)}` })

function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

let fixture: AccountingE2eFixture

test.beforeAll(async () => {
  loadEnvFile()
  await openDatabase()
  fixture = await createAccountingE2eTenant('M4INV')
})

test.afterAll(async () => {
  await closeDatabase()
})

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/tenant code/i).fill(fixture.code)
  await page.getByLabel(/^email/i).fill(email)
  await page.getByLabel(/^password/i).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
}

test.describe('M4-W2 invoice + receipt journey (real API, real tenant)', () => {
  test('post an invoice, receive against it, the ledger settles, reversal order is enforced', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await login(page, fixture.accountantEmail, fixture.password)

    // 1. A customer to invoice (same wizard flow as m4-customers.spec.ts).
    await page.goto('/customers')
    await page.getByRole('button', { name: /New Customer/ }).click()
    await expect(page.getByText('Basic Information')).toBeVisible()
    const customerName = `E2E Invoice Customer ${Date.now()}`
    await page.getByPlaceholder('Ahmed Traders').fill(customerName)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: /Create Customer/ }).click()
    await expect(page).toHaveURL(/\/customers\/([^/]+)$/, { timeout: 15_000 })
    const customerUrl = page.url()
    const customerId = customerUrl.split('/customers/')[1]
    const customerCode = await page
      .getByText(/^CUST-\d{6}$/)
      .first()
      .innerText()
    // Both pickers (sales-voucher's and the receipt dialog's) resolve a selection on an exact
    // "Name (CODE)" match against the debounced C1 search results, not the bare name.
    const customerLabel = `${customerName} (${customerCode})`

    // 2. Raise and post a 10,000 service invoice against this customer.
    await page.goto(`/sales/voucher?customer=${customerId}`)
    await expect(page.getByLabel('Customer')).toHaveValue(new RegExp(customerName))
    await page.getByLabel('Description 1').fill('Consulting services')
    await page.getByLabel('Qty 1').fill('1')
    await page.getByLabel('Rate 1').fill('10000')
    await expect(page.getByText('Rs 10,000.00').first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /save & post/i }).click()
    const postInvoiceDialog = page.getByRole('dialog', { name: /post invoice/i })
    await expect(postInvoiceDialog).toBeVisible()
    await postInvoiceDialog.getByRole('button', { name: 'Post invoice' }).click()

    await expect(page).toHaveURL(/\/sales\/([^/?]+)$/, { timeout: 15_000 })
    const invoiceUrl = page.url()
    const invoiceId = invoiceUrl.split('/sales/')[1]
    // INV-<fiscal year>-<sequence>, e.g. INV-2027-000001 — not a fixed 6-digit suffix.
    await expect(page.getByText(/^INV-\d{4}-\d{6}$/).first()).toBeVisible()
    await expect(page.getByText('POSTED').first()).toBeVisible()
    await expect(page.getByText('Rs 10,000.00').first()).toBeVisible()

    // 3. Receive 6,000 against it.
    await page.goto('/payments')
    await page.getByRole('button', { name: /new receipt/i }).click()
    const newReceiptDialog = page.getByRole('dialog', { name: /new receipt/i })
    await expect(newReceiptDialog).toBeVisible()
    await newReceiptDialog.getByLabel('Customer').fill(customerLabel)
    await newReceiptDialog.getByLabel('Amount').fill('6000')
    await expect(newReceiptDialog.getByText(/^INV-\d{4}-\d{6}$/)).toBeVisible({ timeout: 10_000 })
    await newReceiptDialog
      .getByRole('button', { name: 'Use suggested allocation (oldest first)' })
      .click()
    await expect(newReceiptDialog.getByText('Rs 6,000.00')).toBeVisible() // Allocated
    await expect(newReceiptDialog.getByText('Rs 0.00')).toBeVisible() // Unallocated

    await newReceiptDialog.getByRole('button', { name: /post receipt/i }).click()
    const postReceiptDialog = page.getByRole('dialog', { name: 'Post receipt' })
    await expect(postReceiptDialog).toBeVisible()
    await postReceiptDialog.getByRole('button', { name: 'Post receipt' }).click()
    await expect(newReceiptDialog).not.toBeVisible({ timeout: 15_000 })

    // 4. The customer ledger shows 4,000 outstanding — the server's own figure, never summed
    // here.
    await page.goto(`/customers/${customerId}`)
    await expect(page.getByText('Rs 4,000.00').first()).toBeVisible({ timeout: 15_000 })

    // 5. Reversing the invoice is refused while the receipt is live: the Reverse action is
    // withheld (reversalBlockedBy), not merely rejected after the fact.
    await page.goto(`/sales/${invoiceId}`)
    await expect(page.getByText(/reverse .* first/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0)

    // 6. Reverse the receipt first.
    await page.goto('/payments')
    const receiptLink = page.getByRole('button', { name: /^RCT-\d{4}-\d{6}$/ }).first()
    await receiptLink.click()
    await expect(page).toHaveURL(/\/receipts\/.+/)
    await page.getByRole('button', { name: 'Reverse' }).click()
    await page.getByLabel(/^reason/i).fill('E2E: testing reversal order')
    await page.getByLabel(/I understand this cannot be undone/i).check()
    await page.getByRole('button', { name: 'Reverse receipt' }).click()
    await expect(page.getByText(/reversed by/i)).toBeVisible({ timeout: 15_000 })

    // 7. Now the invoice can be reversed.
    await page.goto(`/sales/${invoiceId}`)
    await expect(page.getByRole('button', { name: 'Reverse' })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Reverse' }).click()
    await page.getByLabel(/^reason/i).fill('E2E: receipt reversed first')
    await page.getByLabel(/I understand this cannot be undone/i).check()
    await page.getByRole('button', { name: 'Reverse invoice' }).click()
    await expect(page.getByText(/reversed by/i)).toBeVisible({ timeout: 15_000 })

    // 8. The ledger is back to 0.
    await page.goto(`/customers/${customerId}`)
    await expect(page.getByText('Rs 0.00').first()).toBeVisible({ timeout: 15_000 })
  })
})
